import { BridgeError } from '@poietic-tech/bridge';
import type { BridgeEvent } from '@poietic-tech/bridge';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from './log.ts';
import { Runner, type RunnerOptions } from './runner.ts';
import { Store } from './store.ts';
import type { Sync } from './sync.ts';
import type { Tracker, TrackerEvent } from './tracker.ts';

const event = (seq: number, type: string, payload: unknown): BridgeEvent =>
  ({
    seq,
    type,
    artifact: () => ({ json: async () => payload }),
  }) as unknown as BridgeEvent;

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
    trackerPollMs: 60_000,
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

  it('starts the tracker cursor at the newest event and then hands on each new one', async () => {
    const log: TrackerEvent[] = [5, 6].map(
      (seq) => ({ seq, type: 'issue.updated' }) as TrackerEvent,
    );
    const tracker = {
      events: vi.fn(async (after: number) => ({
        data: log.filter((e) => e.seq > after),
        nextCursor: null,
      })),
    } as unknown as Tracker;
    const seen: number[] = [];
    const store = new Store(':memory:');
    const controller = new AbortController();
    const runner = new Runner({
      bridge: { terminals: { list: async () => [] } } as unknown as RunnerOptions['bridge'],
      tracker,
      store,
      sync: {
        rebuild: async () => 0,
        onTracker: async (e: TrackerEvent) => {
          seen.push(e.seq);
        },
      } as unknown as Sync,
      log: silentLogger,
      subscription: 'issues-sync',
      discoveryMs: 60_000,
      trackerPollMs: 5,
      signal: controller.signal,
    });
    const running = runner.run();
    await vi.waitFor(() => expect(store.cursor('tracker.events')).toBe(6));
    log.push({ seq: 9, type: 'issue.created' } as TrackerEvent);
    await vi.waitFor(() => expect(seen).toEqual([9]));
    expect(store.cursor('tracker.events')).toBe(9);
    controller.abort();
    await running;
  });

  it('backs off the tracker poll while idle and returns to the base interval on new events', async () => {
    vi.useFakeTimers();
    try {
      const log: TrackerEvent[] = [];
      const polls: number[] = [];
      const tracker = {
        events: vi.fn(async (after: number) => {
          polls.push(Date.now());
          return { data: log.filter((e) => e.seq > after), nextCursor: null };
        }),
      } as unknown as Tracker;
      const controller = new AbortController();
      const runner = new Runner({
        bridge: { terminals: { list: async () => [] } } as unknown as RunnerOptions['bridge'],
        tracker,
        store: new Store(':memory:'),
        sync: { rebuild: async () => 0, onTracker: async () => {} } as unknown as Sync,
        log: silentLogger,
        subscription: 'issues-sync',
        discoveryMs: 600_000,
        trackerPollMs: 100,
        trackerIdleMaxMs: 400,
        signal: controller.signal,
      });
      const running = runner.run();
      // The first two calls find the head; then the loop polls.
      await vi.advanceTimersByTimeAsync(0);
      const start = polls.length;
      await vi.advanceTimersByTimeAsync(100 + 200 + 400 + 400);
      const gaps = polls
        .slice(start - 1)
        .map((t, i, a) => (i ? t - a[i - 1]! : 0))
        .slice(1);
      expect(gaps).toEqual([100, 200, 400, 400]);
      log.push({ seq: 1, type: 'issue.created' } as TrackerEvent);
      await vi.advanceTimersByTimeAsync(400 + 100 + 100);
      const after = polls.slice(-3);
      expect([after[1]! - after[0]!, after[2]! - after[1]!]).toEqual([100, 100]);
      controller.abort();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });
});
