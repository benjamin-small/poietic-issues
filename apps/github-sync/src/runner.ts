import { BridgeError } from '@poietic-tech/bridge';
import type { Bridge, BridgeEvent, Connect } from '@poietic-tech/bridge';
import { type Follower, follow } from '@poietic-tech/issues-client';
import { describeError, type Logger } from './log.ts';
import type { Store } from './store.ts';
import { isTransient, type Sync, TRACKER_EVENT_TYPES } from './sync.ts';
import type { Tracker, TrackerEvent } from './tracker.ts';

/** The bridge event types the sync reads; each also matches the types beneath it (`github.issues.opened`). */
export const BRIDGE_EVENT_TYPES = ['github.issues', 'github.issue_comment', 'github.repository'];

/** The tracker's notice types the sync wakes for (the bridge prefixes tracker types with `issues.`). */
export const NOTICE_TYPES = ['issues.issue', 'issues.comment'];

const TRACKER_CURSOR = 'tracker.events';

/** How often the tracker is read with no notice at all: a safety net, not a heartbeat (four times a day). */
export const RECONCILE_MS = 6 * 60 * 60_000;
/** A notice connection down for longer than this may have missed notices: read the tracker once it is back. */
export const OUTAGE_MS = 60_000;
/** A follower run in flight for longer than this has hung (liveness fails, so the pod restarts). */
export const HUNG_MS = 5 * 60_000;

/**
 * Wraps a bridge `Connect` to report each `ready` frame, the bridge's word that a listener's socket is open and
 * caught up. `listen` reports reconnect attempts but not their success; this is how the runner knows.
 */
export function onReady(connect: Connect, ready: () => void): Connect {
  return async (url, signal) => {
    const socket = await connect(url, signal);
    const watch = (data: unknown) => {
      try {
        if (typeof data === 'string' && (JSON.parse(data) as { op?: unknown }).op === 'ready')
          ready();
      } catch {
        /* not a JSON frame (a pong, say) */
      }
    };
    return {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      addEventListener(type: 'message' | 'close' | 'error', fn: (e: never) => void) {
        if (type === 'message')
          socket.addEventListener('message', (e) => {
            watch(e.data);
            (fn as (e: { data: unknown }) => void)(e);
          });
        else
          socket.addEventListener(
            type as 'close',
            fn as (e: { code: number; reason: string }) => void,
          );
      },
    } as Awaited<ReturnType<Connect>>;
  };
}

/** Resolves after `ms`, or at once (false) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RunnerOptions {
  bridge: Pick<Bridge, 'terminals' | 'subscriptions' | 'subscribe'>;
  tracker: Tracker;
  store: Store;
  sync: Sync;
  log: Logger;
  /** The subscription name used on every GitHub terminal. */
  subscription: string;
  /** Only these terminals; otherwise every `github` terminal the agent can read. */
  terminals?: string[];
  discoveryMs: number;
  /**
   * The tracker's notices: a terminal (`poietic-issues`) with the sync's own subscription on it. Its bridge
   * should report `ready` frames to `Runner.noticesConnected` (see `onReady`).
   */
  notices: {
    bridge: Pick<Bridge, 'subscriptions' | 'listen'>;
    terminal: string;
    subscription: string;
  };
  /** The wait between reconciliations. Default `RECONCILE_MS`. */
  reconcileMs?: number;
  /** How long the notice connection may be down before its return triggers a reconciliation. Default `OUTAGE_MS`. */
  outageMs?: number;
  /** The wait before following a terminal again after its stream stopped. */
  restartMs?: number;
  signal: AbortSignal;
}

/** Where the notice listener is: `reconnecting` is the SDK retrying within its backoff; `stopped`, waiting to restart. */
export type NoticeState = 'starting' | 'connected' | 'reconnecting' | 'stopped';

export interface Health {
  /** Liveness: no follower run has hung. */
  live: boolean;
  /** Readiness: the listener is connected (or reconnecting within its backoff) and the last read did not fail. */
  ready: boolean;
  notices: NoticeState;
  /** Whether the last read of the tracker failed (it is being retried). */
  trackerFailing: boolean;
  /** When the tracker was last read through (ms since the epoch; 0 before the first read). */
  trackerReadAt: number;
}

/**
 * Runs the sync until `signal` aborts: one bridge subscription per GitHub terminal (found again every
 * `discoveryMs`), and a follower of the tracker's event log, from a saved cursor, that reads only when woken: by a
 * tracker notice through the bridge, or by a reconciliation (at start, after a notice outage, every 6 hours).
 * Between wake-ups nothing reaches the tracker, so its container can sleep.
 */
export class Runner {
  readonly #o: RunnerOptions;
  readonly #following = new Map<string, Promise<void>>();
  readonly #follower: Follower;
  /** When discovery last succeeded. */
  readonly heartbeat = { discovery: 0 };

  /** Why the tracker should be read next, or undefined when nothing asked. */
  #due: string | undefined;
  #nudge: (() => void) | undefined;
  #notices: NoticeState = 'starting';
  /** When the notice connection went down, while it is down. */
  #downSince: number | undefined;
  #trackerFailing = false;
  #trackerReadAt = 0;
  #runningSince: number | undefined;

  constructor(options: RunnerOptions) {
    this.#o = options;
    this.#follower = follow(options.tracker.api, {
      types: TRACKER_EVENT_TYPES,
      limit: 100,
      cursor: {
        load: () => this.#loadCursor(),
        save: async (through) => options.store.setCursor(TRACKER_CURSOR, through),
      },
      onBatch: (events) => this.#onTrackerBatch(events),
    });
  }

  get terminals(): string[] {
    return [...this.#following.keys()];
  }

  health(now = Date.now()): Health {
    const listening = this.#notices === 'connected' || this.#notices === 'reconnecting';
    return {
      live: this.#runningSince === undefined || now - this.#runningSince < HUNG_MS,
      ready: listening && this.#trackerReadAt > 0 && !this.#trackerFailing,
      notices: this.#notices,
      trackerFailing: this.#trackerFailing,
      trackerReadAt: this.#trackerReadAt,
    };
  }

  async run(): Promise<void> {
    const { store, sync, log } = this.#o;
    if (store.isEmpty()) {
      const found = await sync.rebuild();
      log.info('store.rebuilt', { links: found });
    }
    this.#wake('start');
    await Promise.all([
      this.#discoverLoop(),
      this.#noticeLoop(),
      this.#trackerLoop(),
      this.#reconcileLoop(),
    ]);
    await Promise.allSettled(this.#following.values());
  }

  // ------------------------------------------------------------------ bridge: GitHub

  async #discoverLoop(): Promise<void> {
    const { signal, discoveryMs, log } = this.#o;
    while (!signal.aborted) {
      try {
        await this.discover();
        this.heartbeat.discovery = Date.now();
      } catch (error) {
        log.error('bridge.discovery_failed', { error: describeError(error) });
      }
      if (!(await sleep(discoveryMs, signal))) return;
    }
  }

  /** Starts following any GitHub terminal not followed yet. */
  async discover(): Promise<void> {
    const { bridge, terminals } = this.#o;
    const names =
      terminals ??
      (await bridge.terminals.list()).filter((t) => t.adapter === 'github').map((t) => t.name);
    for (const name of names) {
      if (this.#following.has(name)) continue;
      this.#following.set(name, this.#follow(name));
    }
  }

  /** Follows one terminal for good, starting its stream again whenever it stops. */
  async #follow(terminal: string): Promise<void> {
    const { bridge, subscription, signal, log, restartMs = 30_000 } = this.#o;
    while (!signal.aborted) {
      try {
        await ensureSubscription(bridge, terminal, subscription, log);
        log.info('bridge.following', { terminal, subscription });
        await bridge.subscribe(
          terminal,
          subscription,
          (event) => this.#onBridgeEvent(terminal, event),
          {
            types: BRIDGE_EVENT_TYPES,
            signal,
            retries: 5,
            backoffMs: 2000,
          },
        );
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof BridgeError && error.code === 'aged_out') {
          // Events expired before they were read. Nothing can bring them back; carry on from what is left.
          log.error('bridge.aged_out', { terminal, error: describeError(error) });
          await bridge.subscriptions.reset(terminal, subscription, 'earliest').catch(() => {});
        } else {
          log.error('bridge.stopped', { terminal, error: describeError(error) });
        }
      }
      if (!(await sleep(restartMs, signal))) return;
    }
  }

  /** Throws only for failures worth retrying, which leaves the event unsaved; others are logged and skipped. */
  async #onBridgeEvent(terminal: string, event: BridgeEvent): Promise<void> {
    const { sync, log } = this.#o;
    try {
      const payload = await event.artifact('payload').json();
      await sync.onGitHub(event.type, payload);
    } catch (error) {
      if (isTransient(error) || (error instanceof BridgeError && error.code === 'network'))
        throw error;
      log.error('bridge.event_skipped', {
        terminal,
        seq: event.seq,
        type: event.type,
        error: describeError(error),
      });
    }
  }

  // ------------------------------------------------------------------ bridge: tracker notices

  /**
   * Listens for tracker notices for good. A notice only says "something changed": it is acknowledged on receipt
   * and wakes the follower, which reads the tracker as the sync from its own cursor.
   */
  async #noticeLoop(): Promise<void> {
    const { notices, signal, log, restartMs = 30_000 } = this.#o;
    const { bridge, terminal, subscription } = notices;
    while (!signal.aborted) {
      try {
        await ensureSubscription(bridge, terminal, subscription, log);
        log.info('bridge.listening', { terminal, subscription });
        for await (const _notice of bridge.listen(terminal, {
          subscription,
          types: NOTICE_TYPES,
          signal,
          onReconnect: () => this.#noticesDown('reconnecting'),
        })) {
          this.noticesConnected();
          this.#wake('notice');
        }
        return; // only an abort ends the listener without an error
      } catch (error) {
        if (signal.aborted) return;
        this.#noticesDown('stopped');
        if (error instanceof BridgeError && error.code === 'aged_out') {
          // Notices expired unread. They carry nothing the tracker does not have: skip ahead, then read the tracker.
          log.error('bridge.aged_out', { terminal, error: describeError(error) });
          await bridge.subscriptions.reset(terminal, subscription, 'latest').catch(() => {});
          this.#wake('aged_out');
        } else {
          log.error('bridge.stopped', { terminal, error: describeError(error) });
        }
      }
      if (!(await sleep(restartMs, signal))) return;
    }
  }

  /** The notice socket is open (a `ready` frame, or a notice). After a long outage, reconcile. */
  noticesConnected(now = Date.now()): void {
    const { outageMs = OUTAGE_MS, log } = this.#o;
    if (this.#downSince !== undefined && now - this.#downSince > outageMs) {
      log.info('bridge.notices_back', { downMs: now - this.#downSince });
      this.#wake('outage');
    }
    this.#downSince = undefined;
    this.#notices = 'connected';
  }

  #noticesDown(state: 'reconnecting' | 'stopped'): void {
    this.#downSince ??= Date.now();
    this.#notices = state;
  }

  // ------------------------------------------------------------------ tracker

  async #reconcileLoop(): Promise<void> {
    const { signal, reconcileMs = RECONCILE_MS } = this.#o;
    while (await sleep(reconcileMs, signal)) this.#wake('reconcile');
  }

  /** Asks for a read of the tracker. Wake-ups while one is pending or running fold into one more read. */
  #wake(why: string): void {
    this.#due ??= why;
    this.#nudge?.();
  }

  /** Resolves on the next wake-up (or at once when one is pending), or when `signal` aborts. */
  #woken(): Promise<void> {
    const { signal } = this.#o;
    if (this.#due !== undefined || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.#nudge = undefined;
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.#nudge = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** Reads the tracker each time it is woken, retrying a failed read with backoff until it succeeds. */
  async #trackerLoop(): Promise<void> {
    const { log, signal } = this.#o;
    let failures = 0;
    while (!signal.aborted) {
      await this.#woken();
      const why = this.#due;
      if (why === undefined || signal.aborted) continue;
      this.#due = undefined;
      if (why !== 'notice') log.info('tracker.reconcile', { why });
      this.#runningSince = Date.now();
      try {
        await this.#follower.run();
        failures = 0;
        this.#trackerFailing = false;
        this.#trackerReadAt = Date.now();
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        this.#trackerFailing = true;
        this.#due ??= why;
        log.warn('tracker.retry', { attempt: failures, why, error: describeError(error) });
        if (!(await sleep(Math.min(1000 * 2 ** failures, 60_000), signal))) return;
      } finally {
        this.#runningSince = undefined;
      }
    }
  }

  async #loadCursor(): Promise<number> {
    const { tracker, store, log } = this.#o;
    const saved = store.cursor(TRACKER_CURSOR);
    if (saved !== undefined) return saved;
    // First run: start from now. Tracker history before the sync existed is not pushed to GitHub.
    const head = await this.#trackerHead(tracker);
    store.setCursor(TRACKER_CURSOR, head);
    log.info('tracker.cursor_started', { seq: head });
    return head;
  }

  /**
   * Hands each event to the sync, saving the cursor after each one, as before. A transient failure throws, so the
   * run fails and is retried from that event; a permanent one is logged and passed over.
   */
  async #onTrackerBatch(events: TrackerEvent[]): Promise<void> {
    const { sync, store, log, signal } = this.#o;
    for (const event of events) {
      // Throwing leaves the batch's cursor unsaved, so events not yet handled are read again.
      if (signal.aborted) throw signal.reason;
      try {
        await sync.onTracker(event);
      } catch (error) {
        if (isTransient(error)) throw error;
        log.error('tracker.event_skipped', {
          seq: event.seq,
          type: event.type,
          error: describeError(error),
        });
      }
      store.setCursor(TRACKER_CURSOR, event.seq);
    }
  }

  /** The newest tracker event's sequence number. */
  async #trackerHead(tracker: Tracker): Promise<number> {
    let cursor = 0;
    for (;;) {
      const page = await tracker.events(cursor, TRACKER_EVENT_TYPES, 1000);
      const last = page.data.at(-1);
      if (!last) return cursor;
      cursor = last.seq;
      if (page.data.length < 1000) return cursor;
    }
  }
}

/** Makes sure a subscription exists. A new one starts at the newest event: earlier history is not replayed. */
async function ensureSubscription(
  bridge: Pick<Bridge, 'subscriptions'>,
  terminal: string,
  subscription: string,
  log: Logger,
): Promise<void> {
  try {
    await bridge.subscriptions.get(terminal, subscription);
  } catch (error) {
    if (!(error instanceof BridgeError && error.code === 'not_found')) throw error;
    await bridge.subscriptions.create(terminal, { name: subscription });
    log.info('bridge.subscribed', { terminal, subscription });
  }
}
