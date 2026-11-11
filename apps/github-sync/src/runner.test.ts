import { BridgeError } from '@poietic-tech/bridge';
import type { BridgeEvent, ListenOptions, SocketLike } from '@poietic-tech/bridge';
import { createClient } from '@poietic-tech/issues-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from './log.ts';
import { NOTICE_TYPES, onReady, RECONCILE_MS, Runner, type RunnerOptions } from './runner.ts';
import { Store } from './store.ts';
import type { Sync } from './sync.ts';
import { Tracker, type TrackerEvent } from './tracker.ts';

const event = (seq: number, type: string, payload: unknown): BridgeEvent =>
  ({
    seq,
    type,
    artifact: () => ({ json: async () => payload }),
  }) as unknown as BridgeEvent;

/** A bridge whose `listen` yields what the test sends it, until aborted, or throws what the test fails it with. */
function fakeNotices() {
  const queue: (BridgeEvent | Error)[] = [];
  let poke: (() => void) | undefined;
  let opts: ListenOptions | undefined;
  let seq = 0;
  const listen = vi.fn((_t: string, o: ListenOptions = {}) => {
    opts = o;
    return (async function* () {
      for (;;) {
        if (o.signal?.aborted) return;
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          poke = resolve;
          o.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    })();
  });
  const create = vi.fn(async () => ({}));
  const bridge = {
    subscriptions: {
      get: vi.fn(async () => {
        throw new BridgeError('not_found', 'no', 404);
      }),
      create,
      reset: vi.fn(async () => ({})),
    },
    listen,
  } as unknown as RunnerOptions['notices']['bridge'];
  return {
    options: { bridge, terminal: 'poietic-issues', subscription: 'github-sync' },
    listen,
    create,
    /** A notice arrives. */
    notify(type = 'issues.issue.updated') {
      queue.push({ seq: ++seq, type } as BridgeEvent);
      poke?.();
    },
    /** The listener gives up (a non-retryable error). */
    fail(error: Error) {
      queue.push(error);
      poke?.();
    },
    /** The SDK is about to reconnect. */
    reconnect(attempt = 1) {
      opts!.onReconnect?.(attempt);
    },
  };
}

/** A tracker serving `GET /events` from `log`, counting every request it gets. */
function fakeTracker(log: TrackerEvent[]) {
  const requests: string[] = [];
  let failNext = 0;
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (failNext > 0) {
      failNext -= 1;
      return new Response(JSON.stringify({ title: 'down', status: 503 }), {
        status: 503,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const page = log.filter((e) => e.seq > after).slice(0, limit);
    const more = log.filter((e) => e.seq > after).length > limit;
    return Response.json({ data: page, nextCursor: more ? String(page.at(-1)!.seq) : null });
  };
  return {
    tracker: new Tracker(createClient({ baseUrl: 'http://tracker.test', fetch })),
    requests,
    failNext(n: number) {
      failNext = n;
    },
  };
}

function trackerSetup(
  options: Partial<RunnerOptions> & { onTracker?: (e: TrackerEvent) => Promise<void> } = {},
) {
  const log: TrackerEvent[] = [5, 6].map((seq) => ({ seq, type: 'issue.updated' }) as TrackerEvent);
  const fake = fakeTracker(log);
  const notices = fakeNotices();
  const seen: number[] = [];
  const store = new Store(':memory:');
  const controller = new AbortController();
  const runner = new Runner({
    bridge: { terminals: { list: async () => [] } } as unknown as RunnerOptions['bridge'],
    tracker: fake.tracker,
    store,
    sync: {
      rebuild: async () => 0,
      onTracker:
        options.onTracker ??
        (async (e: TrackerEvent) => {
          seen.push(e.seq);
        }),
    } as unknown as Sync,
    log: silentLogger,
    subscription: 'issues-sync',
    discoveryMs: 60_000,
    notices: notices.options,
    restartMs: 10,
    signal: controller.signal,
    ...options,
  });
  const running = runner.run();
  const stop = async () => {
    controller.abort();
    await running;
  };
  /** A tracker change: an event in the log (its notice is the test's to send). */
  const change = (seq: number) => log.push({ seq, type: 'issue.updated' } as TrackerEvent);
  return { runner, store, seen, notices, change, stop, ...fake };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function setup(onGitHub: (type: string, payload: unknown) => Promise<void>) {
  const handled: unknown[] = [];
  const subscribe = vi.fn(
    async (
      _t: string,
      _s: string,
      handler: (e: BridgeEvent) => Promise<unknown>,
      _opts?: unknown,
    ) => {
      await handler(event(1, 'github.issues.opened', { n: 1 }));
      handled.push('after-1');
    },
  );
  const bridge = {
    terminals: {
      list: vi.fn(async () => [
        { name: 'github-a', adapter: 'github' },
        { name: 'other', adapter: 'stripe' },
      ]),
    },
    subscriptions: {
      get: vi.fn(async () => {
        throw new BridgeError('not_found', 'no', 404);
      }),
      create: vi.fn(async () => ({})),
      reset: vi.fn(async () => ({})),
    },
    subscribe,
  } as unknown as RunnerOptions['bridge'];
  const controller = new AbortController();
  const runner = new Runner({
    bridge,
    tracker: {} as Tracker,
    store: new Store(':memory:'),
    sync: { onGitHub } as unknown as Sync,
    log: silentLogger,
    subscription: 'issues-sync',
    discoveryMs: 60_000,
    notices: fakeNotices().options,
    restartMs: 60_000,
    signal: controller.signal,
  });
  return { runner, bridge, subscribe, handled, controller };
}

describe('Runner', () => {
  it('follows every GitHub terminal through a new subscription', async () => {
    const seen: string[] = [];
    const { runner, bridge, subscribe, controller } = setup(async (type) => {
      seen.push(type);
    });
    await runner.discover();
    await vi.waitFor(() => expect(seen).toEqual(['github.issues.opened']));
    expect(runner.terminals).toEqual(['github-a']);
    expect(bridge.subscriptions.create).toHaveBeenCalledWith('github-a', { name: 'issues-sync' });
    expect(subscribe.mock.calls[0]![3]).toMatchObject({
      types: ['github.issues', 'github.issue_comment', 'github.repository'],
    });
    controller.abort();
  });

  it('skips events that fail for good, and leaves transient failures unsaved', async () => {
    const permanent = setup(async () => {
      throw new Error('bad payload');
    });
    await permanent.runner.discover();
    await vi.waitFor(() => expect(permanent.handled).toEqual(['after-1']));
    permanent.controller.abort();

    const transient = setup(async () => {
      throw new TypeError('fetch failed');
    });
    await transient.runner.discover();
    await vi.waitFor(() => expect(transient.subscribe).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(transient.handled).toEqual([]);
    transient.controller.abort();
  });
});

describe('Runner, tracker side', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the cursor at the head on its first run, without pushing history', async () => {
    const t = trackerSetup();
    await vi.waitFor(() => expect(t.store.cursor('tracker.events')).toBe(6));
    expect(t.seen).toEqual([]);
    await t.stop();
  });

  it('listens on the notice terminal with its own subscription and types, created when missing', async () => {
    const t = trackerSetup();
    await vi.waitFor(() => expect(t.notices.listen).toHaveBeenCalled());
    expect(t.notices.create).toHaveBeenCalledWith('poietic-issues', { name: 'github-sync' });
    const [terminal, opts] = t.notices.listen.mock.calls[0]!;
    expect(terminal).toBe('poietic-issues');
    expect(opts).toMatchObject({ subscription: 'github-sync', types: NOTICE_TYPES });
    // Acknowledged on receipt: the SDK's default for a subscription, not turned off.
    expect(opts?.ack).not.toBe(false);
    expect(NOTICE_TYPES).toEqual(['issues.issue', 'issues.comment']);
    await t.stop();
  });

  it('reads the tracker when a notice wakes it, and hands on the new events', async () => {
    const t = trackerSetup();
    await vi.waitFor(() => expect(t.store.cursor('tracker.events')).toBe(6));
    t.change(9);
    t.notices.notify();
    await vi.waitFor(() => expect(t.seen).toEqual([9]));
    expect(t.store.cursor('tracker.events')).toBe(9);
    await t.stop();
  });

  it('makes no tracker requests while idle', async () => {
    const t = trackerSetup();
    await vi.waitFor(() => expect(t.store.cursor('tracker.events')).toBe(6));
    await vi.waitFor(() => expect(t.runner.health().trackerReadAt).toBeGreaterThan(0));
    const before = t.requests.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(t.requests.length).toBe(before);
    // A tracker change with no notice is not seen until something wakes the follower.
    t.change(9);
    await settle();
    expect(t.seen).toEqual([]);
    expect(t.requests.length).toBe(before);
    await t.stop();
  });

  it('folds notices that arrive during a read into one more read', async () => {
    const t = trackerSetup();
    await vi.waitFor(() => expect(t.runner.health().trackerReadAt).toBeGreaterThan(0));
    const before = t.requests.length;
    t.change(9);
    for (let i = 0; i < 5; i++) t.notices.notify();
    await vi.waitFor(() => expect(t.seen).toEqual([9]));
    await settle();
    expect(t.requests.length - before).toBeLessThanOrEqual(2);
    await t.stop();
  });

  it('catches up after a notice outage longer than 60 seconds, but not a short one', async () => {
    const t = trackerSetup();
    await vi.waitFor(() => expect(t.runner.health().trackerReadAt).toBeGreaterThan(0));
    t.runner.noticesConnected();

    // A blip: down and back within a minute. No read.
    t.notices.reconnect();
    t.runner.noticesConnected(Date.now() + 30_000);
    const before = t.requests.length;
    t.change(9);
    await settle();
    expect(t.requests.length).toBe(before);

    // Down for more than a minute: notices may have been lost, so read once it is back.
    t.notices.reconnect();
    t.runner.noticesConnected(Date.now() + 61_000);
    await vi.waitFor(() => expect(t.seen).toEqual([9]));
    await t.stop();
  });

  it('reconciles every 6 hours with no notice at all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect(RECONCILE_MS).toBe(6 * 60 * 60_000);
    const t = trackerSetup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.store.cursor('tracker.events')).toBe(6);
    const before = t.requests.length;
    t.change(9);
    await vi.advanceTimersByTimeAsync(RECONCILE_MS - 2000);
    expect(t.requests.length).toBe(before);
    expect(t.seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.seen).toEqual([9]);
    expect(t.requests.length).toBe(before + 1);
    await t.stop();
  });

  it('retries a failed read with backoff, and skips an event that fails for good', async () => {
    const t = trackerSetup({
      onTracker: async (e) => {
        if (e.seq === 9) throw new Error('bad event');
      },
    });
    await vi.waitFor(() => expect(t.runner.health().trackerReadAt).toBeGreaterThan(0));
    t.failNext(1);
    t.change(9);
    t.change(10);
    t.notices.notify();
    await vi.waitFor(() => expect(t.runner.health().trackerFailing).toBe(true));
    await vi.waitFor(() => expect(t.store.cursor('tracker.events')).toBe(10), { timeout: 5000 });
    expect(t.runner.health().trackerFailing).toBe(false);
    await t.stop();
  });

  it('is ready while the listener is connected or reconnecting and the last read did not fail', async () => {
    const t = trackerSetup();
    expect(t.runner.health()).toMatchObject({ ready: false, notices: 'starting' });
    await vi.waitFor(() => expect(t.runner.health().trackerReadAt).toBeGreaterThan(0));
    // Read, but the listener has not said it is connected yet.
    expect(t.runner.health().ready).toBe(false);
    t.runner.noticesConnected();
    expect(t.runner.health()).toMatchObject({ ready: true, live: true, notices: 'connected' });

    // Reconnecting within the SDK's backoff is still ready.
    t.notices.reconnect();
    expect(t.runner.health()).toMatchObject({ ready: true, notices: 'reconnecting' });
    t.runner.noticesConnected();

    // A failed read is not ready until a read succeeds again.
    t.failNext(1);
    t.notices.notify();
    await vi.waitFor(() => expect(t.runner.health()).toMatchObject({ ready: false }));
    await vi.waitFor(() => expect(t.runner.health().ready).toBe(true), { timeout: 5000 });

    // A listener that gave up is not ready, until it is listening again.
    t.notices.fail(new BridgeError('not_allowed', 'not a reader', 403));
    await vi.waitFor(() =>
      expect(t.runner.health()).toMatchObject({ notices: 'stopped', ready: false }),
    );
    await vi.waitFor(() => expect(t.notices.listen).toHaveBeenCalledTimes(2));
    t.runner.noticesConnected();
    expect(t.runner.health().ready).toBe(true);
    await t.stop();
  });

  it('is not live while a read has hung for more than 5 minutes', async () => {
    let release: (() => void) | undefined;
    const t = trackerSetup({
      onTracker: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await vi.waitFor(() => expect(t.runner.health().trackerReadAt).toBeGreaterThan(0));
    expect(t.runner.health(Date.now() + 10 * 60_000).live).toBe(true);
    t.change(9);
    t.notices.notify();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(t.runner.health().live).toBe(true);
    expect(t.runner.health(Date.now() + 10 * 60_000).live).toBe(false);
    release!();
    await vi.waitFor(() => expect(t.store.cursor('tracker.events')).toBe(9));
    expect(t.runner.health(Date.now() + 10 * 60_000).live).toBe(true);
    await t.stop();
  });
});

describe('onReady', () => {
  it("reports the bridge's ready frame and passes every frame on", async () => {
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
        if (type === 'message') listeners.push(fn);
      },
    };
    const ready = vi.fn();
    const wrapped = await onReady(async () => socket as unknown as SocketLike, ready)('wss://x');
    const got: unknown[] = [];
    wrapped.addEventListener('message', (e) => got.push(e.data));
    for (const data of ['pong', JSON.stringify({ op: 'event' }), JSON.stringify({ op: 'ready' })])
      for (const fn of listeners) fn({ data });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(got).toHaveLength(3);
    wrapped.send('ping');
    expect(socket.send).toHaveBeenCalledWith('ping');
  });
});
