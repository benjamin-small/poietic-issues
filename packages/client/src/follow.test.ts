import { describe, expect, it } from 'vitest';
import { changes, follow, type Cursor, type WakeSource } from './follow.ts';
import { createClient, type Schemas } from './index.ts';

type Event = Schemas['Event'];

const ev = (seq: number): Event => ({
  seq,
  id: `evt_${seq}`,
  type: 'issue.updated',
  actorId: 'usr_pm',
  actor: null,
  projectId: 'prj_a',
  issueId: 'iss_1',
  data: {},
  createdAt: '2026-11-01T12:00:00.000Z',
});

/** A client whose `/events` answers come from `pages`, keyed by `after`; records each query string. */
function fakeApi(pages: Record<number, { data: Event[]; nextCursor: string | null }>) {
  const queries: string[] = [];
  const api = createClient({
    baseUrl: 'http://t',
    fetch: async (request) => {
      const url = new URL(request.url);
      queries.push(url.search);
      const after = Number(url.searchParams.get('after') ?? 0);
      const page = pages[after] ?? { data: [], nextCursor: null };
      return Response.json(page);
    },
  });
  return { api, queries };
}

function memoryCursor(start = 0): Cursor & { saved: number[] } {
  let value = start;
  const saved: number[] = [];
  return {
    saved,
    load: async () => value,
    save: async (through) => {
      saved.push(through);
      value = through;
    },
  };
}

function manualWake(): WakeSource & { fire(): void; unsubscribed: boolean } {
  let listener: (() => void) | null = null;
  const source = ((wake: () => void) => {
    listener = wake;
    return () => {
      source.unsubscribed = true;
      listener = null;
    };
  }) as WakeSource & { fire(): void; unsubscribed: boolean };
  source.unsubscribed = false;
  source.fire = () => listener?.();
  return source;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('changes', () => {
  it('through is nextCursor when there is more', async () => {
    const { api } = fakeApi({ 100: { data: [ev(101)], nextCursor: '120' } });
    expect(await changes(api, { after: 100 })).toMatchObject({ through: 120, more: true });
  });

  it('through is the last seq on the last page', async () => {
    const { api } = fakeApi({ 100: { data: [ev(101), ev(105)], nextCursor: null } });
    const page = await changes(api, { after: 100 });
    expect(page).toMatchObject({ through: 105, more: false });
    expect(page.events.map((e) => e.seq)).toEqual([101, 105]);
  });

  it('an empty last page keeps the cursor', async () => {
    const { api } = fakeApi({});
    expect(await changes(api, { after: 100 })).toEqual({ events: [], through: 100, more: false });
  });

  it('a cursor that moves backwards is an error', async () => {
    const { api } = fakeApi({ 100: { data: [], nextCursor: '90' } });
    await expect(changes(api, { after: 100 })).rejects.toThrow(/backwards|forward/);
  });

  it('a page that claims more but does not advance is an error', async () => {
    const { api } = fakeApi({ 100: { data: [], nextCursor: '100' } });
    await expect(changes(api, { after: 100 })).rejects.toThrow(/forward/);
  });

  it('project and types reach the query', async () => {
    const { api, queries } = fakeApi({});
    await changes(api, { after: 3, project: 'ENG', types: ['issue.created', 'issue.updated'] });
    const q = new URLSearchParams(queries[0]);
    expect(q.get('after')).toBe('3');
    expect(q.get('project')).toBe('ENG');
    expect(q.get('types')).toBe('issue.created,issue.updated');
  });

  it('a failing request is an ApiError', async () => {
    const api = createClient({
      baseUrl: 'http://t',
      fetch: async () =>
        Response.json(
          { code: 'UNAUTHENTICATED', status: 401, title: 'x', type: 'x' },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    await expect(changes(api, { after: 0 })).rejects.toMatchObject({ status: 401 });
  });
});

describe('follow', () => {
  const threePages = {
    0: { data: [ev(1), ev(2)], nextCursor: '2' },
    2: { data: [ev(3)], nextCursor: '5' },
    5: { data: [ev(6)], nextCursor: null },
  };

  it('run drains every page, then saves after each batch', async () => {
    const { api } = fakeApi(threePages);
    const cursor = memoryCursor();
    const batches: number[][] = [];
    const follower = follow(api, {
      cursor,
      onBatch: async (events, through) => {
        expect(cursor.saved.at(-1) ?? 0).toBeLessThan(through); // not saved before onBatch resolves
        batches.push(events.map((e) => e.seq));
      },
    });
    expect(await follower.run()).toBe(6);
    expect(batches).toEqual([[1, 2], [3], [6]]);
    expect(cursor.saved).toEqual([2, 5, 6]);
  });

  it('an empty page with more still saves its cursor, without calling onBatch', async () => {
    const { api } = fakeApi({
      0: { data: [], nextCursor: '40' },
      40: { data: [ev(41)], nextCursor: null },
    });
    const cursor = memoryCursor();
    const batches: number[][] = [];
    await follow(api, {
      cursor,
      onBatch: async (events) => void batches.push(events.map((e) => e.seq)),
    }).run();
    expect(batches).toEqual([[41]]);
    expect(cursor.saved).toEqual([40, 41]);
  });

  it('a failing onBatch does not save, and the next run reads the batch again', async () => {
    const { api } = fakeApi(threePages);
    const cursor = memoryCursor();
    let fail = true;
    const seen: number[] = [];
    const follower = follow(api, {
      cursor,
      onBatch: async (events) => {
        if (events[0]!.seq === 3 && fail) throw new Error('boom');
        seen.push(...events.map((e) => e.seq));
      },
    });
    await expect(follower.run()).rejects.toThrow('boom');
    expect(cursor.saved).toEqual([2]);
    fail = false;
    expect(await follower.run()).toBe(6);
    expect(seen).toEqual([1, 2, 3, 6]);
  });

  it('no wake, no requests', async () => {
    const { api, queries } = fakeApi(threePages);
    follow(api, { cursor: memoryCursor(), onBatch: async () => {} });
    await tick();
    expect(queries).toHaveLength(0);
  });

  it('wakes during a run coalesce into one more run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api, queries } = fakeApi({ 0: { data: [ev(1)], nextCursor: null } });
    const wake = manualWake();
    let first = true;
    follow(api, {
      cursor: memoryCursor(),
      wake,
      onError: () => {},
      onBatch: async () => {
        if (first) {
          first = false;
          await gate;
        }
      },
    });
    wake.fire();
    await tick();
    wake.fire();
    wake.fire();
    wake.fire();
    release();
    await tick();
    await tick();
    // The first run read one page; the rerun read from the saved cursor, once.
    expect(queries).toHaveLength(2);
  });

  it('a run() during a run joins it', async () => {
    const { api, queries } = fakeApi(threePages);
    const follower = follow(api, { cursor: memoryCursor(), onBatch: async () => {} });
    const [a, b] = await Promise.all([follower.run(), follower.run()]);
    expect(a).toBe(6);
    expect(b).toBe(6);
    // Three pages, then one more read from the saved cursor for the joining caller.
    expect(queries).toHaveLength(4);
  });

  it('a run() called while a run finishes reads again, so nothing announced waits', async () => {
    const pages: Record<number, { data: Event[]; nextCursor: string | null }> = {
      0: { data: [ev(50)], nextCursor: null },
    };
    const { api } = fakeApi(pages);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: number[] = [];
    const follower = follow(api, {
      cursor: memoryCursor(),
      onBatch: async (events) => {
        if (events[0]!.seq === 50) await gate;
        seen.push(...events.map((e) => e.seq));
      },
    });
    const first = follower.run();
    await tick();
    // Seq 51 commits, and its notice calls run() while the first run is still handling 50.
    pages[50] = { data: [ev(51)], nextCursor: null };
    const second = follower.run();
    release();
    expect(await second).toBe(51);
    expect(await first).toBe(51);
    expect(seen).toEqual([50, 51]);
  });

  it('an onError that throws does not escape the follower', async () => {
    const { api } = fakeApi(threePages);
    const wake = manualWake();
    let calls = 0;
    follow(api, {
      cursor: memoryCursor(),
      wake,
      onError: () => {
        throw new Error('the handler broke too');
      },
      onBatch: async () => {
        calls++;
        throw new Error('batch failed');
      },
    });
    wake.fire();
    await tick();
    wake.fire();
    await tick();
    expect(calls).toBe(2);
  });

  it('stop unsubscribes', async () => {
    const { api, queries } = fakeApi(threePages);
    const wake = manualWake();
    const follower = follow(api, {
      cursor: memoryCursor(),
      wake,
      onError: () => {},
      onBatch: async () => {},
    });
    follower.stop();
    expect(wake.unsubscribed).toBe(true);
    wake.fire();
    await tick();
    expect(queries).toHaveLength(0);
  });

  it('a wake-driven failure goes to onError and the follower lives', async () => {
    const { api } = fakeApi(threePages);
    const wake = manualWake();
    const errors: unknown[] = [];
    let fail = true;
    const seen: number[] = [];
    follow(api, {
      cursor: memoryCursor(),
      wake,
      onError: (e) => errors.push(e),
      onBatch: async (events) => {
        if (fail) {
          fail = false;
          throw new Error('once');
        }
        seen.push(...events.map((e) => e.seq));
      },
    });
    wake.fire();
    await tick();
    expect(errors).toHaveLength(1);
    wake.fire();
    await tick();
    await tick();
    expect(seen).toEqual([1, 2, 3, 6]);
  });
});
