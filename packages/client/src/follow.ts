import { type ApiClient, type Schemas, unwrap } from './index.ts';

/**
 * Following the event log from a saved cursor. An agent reads `GET /events` as itself, so the tracker's access rules
 * decide what it sees; a pushed notice (from the bridge) only says when to read, never what happened. A follower
 * never polls on its own: it reads when `run()` is called or when its wake source fires.
 */

type Event = Schemas['Event'];

export interface ChangesQuery {
  /** The cursor: read events after this seq. */
  after: number;
  /** One project, by key or id. A role watching several reads them all and filters with `concerns`. */
  project?: string;
  types?: readonly Event['type'][];
  /** Page size (1–1000; the server's default is 100). */
  limit?: number;
}

export interface ChangesPage {
  events: Event[];
  /** The cursor to save once `events` are handled. */
  through: number;
  /** Whether another page follows. */
  more: boolean;
}

/**
 * One page of events after `after`. `through` is `nextCursor` while more follow, and on the last page (where the
 * server sends none) the last seq returned, or `after` when the page is empty. A cursor that would not move forward
 * is an error: following it would read the same page forever, or read backwards.
 */
export async function changes(api: ApiClient, query: ChangesQuery): Promise<ChangesPage> {
  const page = unwrap(
    await api.GET('/events', {
      params: {
        query: {
          after: query.after,
          ...(query.project !== undefined && { project: query.project }),
          ...(query.types?.length && { types: query.types.join(',') }),
          ...(query.limit !== undefined && { limit: query.limit }),
        },
      },
    }),
  );
  const events = page.data;
  const more = page.nextCursor !== null;
  const through = more ? Number(page.nextCursor) : (events.at(-1)?.seq ?? query.after);
  if (!Number.isInteger(through) || through < query.after || (more && through === query.after))
    throw new Error(
      `The event cursor did not move forward (after ${query.after}, next ${String(page.nextCursor)})`,
    );
  return { events, through, more };
}

/** Where a follower keeps its place. Save it with the work `onBatch` did (one transaction) when you can. */
export interface Cursor {
  load(): Promise<number>;
  save(through: number): Promise<void>;
}

/** Subscribes to wake-ups and returns an unsubscribe function. A bridge listener adapts to this (persistent-agents). */
export type WakeSource = (wake: () => void) => () => void;

interface FollowBase extends Omit<ChangesQuery, 'after'> {
  cursor: Cursor;
  /** Handles a page of events. The cursor is saved only after it resolves, so a crash re-reads, never skips. */
  onBatch(events: Event[], through: number): Promise<void>;
}

// A wake-driven run has no caller to reject to, so a follower with `wake` must say where its errors go.
export type FollowOptions = FollowBase &
  ({ wake?: undefined } | { wake: WakeSource; onError(error: unknown): void });

export interface Follower {
  /** Reads every page after the saved cursor; resolves to the cursor reached. Joins a run already in flight. */
  run(): Promise<number>;
  /** Stops listening to the wake source. A run in flight finishes. */
  stop(): void;
}

export function follow(api: ApiClient, options: FollowOptions): Follower {
  const { cursor, onBatch, wake, ...query } = options;
  let inFlight: Promise<number> | null = null;
  let rerun = false;
  let stopped = false;

  async function drain(): Promise<number> {
    let after = await cursor.load();
    for (;;) {
      const page = await changes(api, { ...query, after });
      if (page.events.length) await onBatch(page.events, page.through);
      if (page.through !== after) await cursor.save(page.through);
      after = page.through;
      if (!page.more) return after;
    }
  }

  function run(): Promise<number> {
    // The caller may know of events the run in flight has already read past: read once more after it.
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        let reached = await drain();
        while (rerun && !stopped) {
          rerun = false;
          reached = await drain();
        }
        return reached;
      } finally {
        rerun = false;
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const onError = (options as { onError?: (error: unknown) => void }).onError;
  const unsubscribe = wake?.(() => {
    if (stopped) return;
    run().catch((error: unknown) => {
      // Nothing above a wake-up can catch: a throwing (or missing) handler must not become an unhandled rejection.
      try {
        onError?.(error);
      } catch {
        /* the handler failed too; the follower keeps listening */
      }
    });
  });

  return {
    run,
    stop() {
      stopped = true;
      unsubscribe?.();
    },
  };
}
