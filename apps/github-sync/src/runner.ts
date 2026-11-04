import { BridgeError } from '@poietic-tech/bridge';
import type { Bridge, BridgeEvent } from '@poietic-tech/bridge';
import { describeError, type Logger } from './log.ts';
import type { Store } from './store.ts';
import { isTransient, type Sync, TRACKER_EVENT_TYPES } from './sync.ts';
import type { Tracker } from './tracker.ts';

/** The bridge event types the sync reads; each also matches the types beneath it (`github.issues.opened`). */
export const BRIDGE_EVENT_TYPES = ['github.issues', 'github.issue_comment', 'github.repository'];

const TRACKER_CURSOR = 'tracker.events';

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
  /** The subscription name used on every terminal. */
  subscription: string;
  /** Only these terminals; otherwise every `github` terminal the agent can read. */
  terminals?: string[];
  discoveryMs: number;
  trackerPollMs: number;
  /** The longest wait between idle tracker polls; each empty poll doubles the wait up to it. Defaults to `trackerPollMs`. */
  trackerIdleMaxMs?: number;
  /** The wait before following a terminal again after its stream stopped. */
  restartMs?: number;
  signal: AbortSignal;
}

/**
 * Runs the sync until `signal` aborts: one bridge subscription per GitHub terminal (found again every
 * `discoveryMs`), and a poll of the tracker's event log from a saved cursor.
 */
export class Runner {
  readonly #o: RunnerOptions;
  readonly #following = new Map<string, Promise<void>>();
  /** When each loop last made progress or found nothing to do, for the health check. */
  readonly heartbeat = { tracker: 0, discovery: 0 };

  constructor(options: RunnerOptions) {
    this.#o = options;
  }

  get terminals(): string[] {
    return [...this.#following.keys()];
  }

  async run(): Promise<void> {
    const { store, sync, log } = this.#o;
    if (store.isEmpty()) {
      const found = await sync.rebuild();
      log.info('store.rebuilt', { links: found });
    }
    await Promise.all([this.#discoverLoop(), this.#trackerLoop()]);
    await Promise.allSettled(this.#following.values());
  }

  // ------------------------------------------------------------------ bridge

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
        await this.#ensureSubscription(terminal);
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

  async #ensureSubscription(terminal: string): Promise<void> {
    const { bridge, subscription, log } = this.#o;
    try {
      await bridge.subscriptions.get(terminal, subscription);
    } catch (error) {
      if (!(error instanceof BridgeError && error.code === 'not_found')) throw error;
      // A new subscription starts at the newest event: history before the sync existed is not replayed.
      await bridge.subscriptions.create(terminal, { name: subscription });
      log.info('bridge.subscribed', { terminal, subscription });
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

  // ------------------------------------------------------------------ tracker

  async #trackerLoop(): Promise<void> {
    const { tracker, store, sync, log, signal, trackerPollMs } = this.#o;
    const idleMaxMs = Math.max(this.#o.trackerIdleMaxMs ?? trackerPollMs, trackerPollMs);
    let failures = 0;
    let delay = trackerPollMs;
    while (!signal.aborted) {
      try {
        let cursor = store.cursor(TRACKER_CURSOR);
        if (cursor === undefined) {
          // First run: start from now. Tracker history before the sync existed is not pushed to GitHub.
          cursor = await this.#trackerHead(tracker);
          store.setCursor(TRACKER_CURSOR, cursor);
          log.info('tracker.cursor_started', { seq: cursor });
        }
        const page = await tracker.events(cursor, TRACKER_EVENT_TYPES, 100);
        for (const event of page.data) {
          if (signal.aborted) return;
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
        failures = 0;
        this.heartbeat.tracker = Date.now();
        if (page.data.length >= 100) continue;
        // Back off while the log is quiet; any new event brings the wait back to `trackerPollMs`.
        if (page.data.length > 0) delay = trackerPollMs;
        if (!(await sleep(delay, signal))) return;
        if (page.data.length === 0) delay = Math.min(delay * 2, idleMaxMs);
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        log.warn('tracker.retry', { attempt: failures, error: describeError(error) });
        if (!(await sleep(Math.min(1000 * 2 ** failures, 60_000), signal))) return;
      }
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
