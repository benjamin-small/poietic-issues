import { z } from '@hono/zod-openapi';
import {
  ContentRulesMemo,
  type EventTailer,
  filterEventsForViewer,
  getProjectRow,
  listEvents,
  type ProjectIdSet,
  readableProjectIds,
  writableProjectIds,
} from '@poietic-tech/issues-core';
import type { TrackerEvent } from '@poietic-tech/issues-schema';
import { streamSSE } from 'hono/streaming';
import type { ResolvedDeps, TrackerApp } from '../env.ts';
import { silentLogger } from '../logger.ts';
import { problem } from '../problem.ts';

const HEARTBEAT_MS = 15_000;
const MAX_REPLAY = 1000;
/** Events a connection may have waiting; one more and it gets `reset` and is closed (the client reconnects). */
const MAX_PENDING = 1000;

/** Events after which a viewer's readable projects may differ (membership, visibility, a new project). */
const changesAccess = (e: TrackerEvent) =>
  e.type.startsWith('project.member_') ||
  e.type.startsWith('project.group_grant_') ||
  e.type === 'project.updated' ||
  e.type === 'project.created';

/** A `user.updated` event about the viewer: their role or status may have changed. */
const namesViewer = (e: TrackerEvent, actorId: string) =>
  e.type === 'user.updated' && (e.data.user as { id?: string } | undefined)?.id === actorId;

const canRead = (access: ProjectIdSet, projectId: string) =>
  access === 'all' || access.includes(projectId);

/**
 * An event that can end the viewer's read access to its project: the removal of their own membership, or the
 * project made private. (Access is re-read at the current state, which may already include later changes, so the
 * event itself says whether it concerns the viewer.)
 */
const mayEndAccess = (e: TrackerEvent, actorId: string, groups: readonly string[]) =>
  (e.type === 'project.group_grant_removed' &&
    groups.includes((e.data.grant as { group?: string } | undefined)?.group ?? '')) ||
  (e.type === 'project.member_removed' &&
    (e.data.member as { user?: { id?: string } } | undefined)?.user?.id === actorId) ||
  (e.type === 'project.updated' &&
    (e.data.changes as { visibility?: { to?: string } } | undefined)?.visibility?.to === 'private');

/**
 * An event that ended the viewer's read access to its project, as they still get it: no content, only that it
 * happened. The removal of their membership names them (`member.user.id`), so the client knows its own access
 * changed; a project made private has empty `data`.
 */
const withoutContent = (e: TrackerEvent, actorId: string): TrackerEvent => ({
  ...e,
  data:
    e.type === 'project.member_removed'
      ? { member: { user: { id: actorId } } }
      : e.type === 'project.group_grant_removed'
        ? { grant: { group: (e.data.grant as { group: string }).group } }
        : {},
});

/**
 * `GET /events/stream` — live events as Server-Sent Events.
 *
 * Each message has `id: <seq>`, `event: <type>` and the event JSON as `data`. Browsers reconnect automatically
 * and send `Last-Event-ID`; the server replays what was missed (up to 1000 events — beyond that it sends a
 * `reset` event, telling the client to refetch). Optional `?project=` filters to one project.
 *
 * The tailer fans out every event, so each connection applies its viewer's access (the same rules as
 * `GET /events`): only readable projects, and the readable set is re-read when memberships or a project's
 * visibility change. A connection with more than 1000 events waiting gets `reset` and is closed, and a viewer's
 * stream (with or without `?project=`) is closed after delivering a `user.updated` event about them; the client
 * reconnects as who they are now and resumes. Replay runs on the identity the reconnect authenticated as, so it
 * never closes the stream. A stream also ends when the credential it authenticated with expires (a short SSO session,
 * an identity token), or when the issuer says an identity token's session has ended, so access ended at the issuer
 * does not outlive it here.
 *
 * Readers below write get `issue.deleted` and `attachment.deleted` as content-free tombstones, live and on replay,
 * so open views drop the row. An event that ends the viewer's read access to its project is delivered without its
 * content, and a `?project=` stream on that project is then closed. Connections with the same access share their
 * content lookups (`ContentRulesMemo`).
 */
export function registerStreamRoute(
  app: TrackerApp,
  deps: ResolvedDeps & { tailer?: EventTailer },
) {
  app.openAPIRegistry.registerPath({
    method: 'get',
    path: '/events/stream',
    tags: ['Events'],
    summary: 'Live event stream (Server-Sent Events)',
    description:
      'Streams events as `text/event-stream`: `id` is the event seq, `event` its type, `data` the Event JSON. ' +
      'Reconnect with `Last-Event-ID` (or `?after=<seq>`) to resume without gaps. A `reset` event means the gap ' +
      'was too large to replay: refetch state. Comment lines are heartbeats. The stream ends when the session or ' +
      "identity token it authenticated with expires, or when the issuer says that token's session has ended. " +
      'Readers below write get ' +
      '`issue.deleted` and `attachment.deleted` as tombstones (ids and the issue key only). An event that ends ' +
      "the viewer's read access to its project arrives without content, and a `?project=` stream on it then ends.",
    request: {
      query: z.object({
        project: z
          .string()
          .optional()
          .openapi({ description: 'Only events of this project (key or id).' }),
        after: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .openapi({ description: 'Resume after this seq.' }),
      }),
    },
    responses: {
      200: {
        description: 'Event stream',
        content: { 'text/event-stream': { schema: z.string() } },
      },
    },
  });

  const memo = new ContentRulesMemo();

  app.get('/events/stream', async (c) => {
    const tailer = deps.tailer;
    if (!tailer) return problem(c, 'UNAVAILABLE', 'Live events are not enabled on this server');
    const ctx = c.get('ctx');
    const projectRef = c.req.query('project');
    const projectId = projectRef
      ? (await getProjectRow(ctx, ctx.db.kysely, projectRef, 'read')).id
      : undefined;
    const resumeRaw = c.req.header('last-event-id') ?? c.req.query('after');
    const resume =
      resumeRaw !== undefined && /^\d+$/.test(resumeRaw) ? Number(resumeRaw) : undefined;

    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      const queue: TrackerEvent[] = [];
      let overflowed = false;
      let wake: (() => void) | undefined;
      // A project stream takes that project's events, plus the viewer's own `user.updated` (which has no project),
      // so it ends after it like an unfiltered stream does. Other users' `user.*` events stay off it.
      const matches = (e: TrackerEvent) =>
        !projectId || e.projectId === projectId || namesViewer(e, ctx.actor.id);
      // Subscribe and read the position together, before any await, so nothing committed afterwards is
      // missed (replay and live may overlap; duplicates are dropped by seq).
      const unsubscribe = tailer.subscribe((e) => {
        if (overflowed || !matches(e)) return;
        if (queue.length >= MAX_PENDING) {
          // A connection this far behind is better off starting over than buffering without bound.
          overflowed = true;
          queue.length = 0;
        } else queue.push(e);
        wake?.();
      });
      let last = resume ?? tailer.lastSeq;
      stream.onAbort(unsubscribe);
      let readable: Awaited<ReturnType<typeof readableProjectIds>> = [];
      let writable: Awaited<ReturnType<typeof writableProjectIds>> = [];
      const readAccess = async () => {
        readable = await readableProjectIds(ctx, ctx.db.kysely);
        writable = await writableProjectIds(ctx, ctx.db.kysely);
      };
      /**
       * Takes the next run of queued events that share one access state, catching up on access first when the
       * run starts with an event that changes it, and filters and redacts the run for this viewer in one batch.
       * When that event took away the viewer's read access to its project, it is kept, without its content, so the
       * client learns its open views are gone (`lost`).
       */
      const nextVisible = async () => {
        const first = queue[0]!;
        if (changesAccess(first)) await readAccess();
        const lost =
          first.projectId !== null &&
          mayEndAccess(first, ctx.actor.id, ctx.actor.groups) &&
          !canRead(readable, first.projectId);
        let n = 1;
        while (n < queue.length && !changesAccess(queue[n]!)) n++;
        const run = queue.splice(0, n);
        const visible = await filterEventsForViewer(ctx, run, {
          readable,
          writable,
          tombstones: true,
          memo,
        });
        if (lost) visible.unshift(withoutContent(first, ctx.actor.id));
        return { run, visible, lost };
      };

      const send = async (e: TrackerEvent) => {
        if (e.seq <= last) return;
        last = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
      };
      /** The `reset` event: the client refetches everything and resumes after the newest seq. */
      const reset = async () => {
        last = tailer.lastSeq;
        await stream.writeSSE({
          id: String(last),
          event: 'reset',
          data: JSON.stringify({ seq: last }),
        });
      };

      const onShutdown = () => wake?.();
      // Everything after subscribing runs inside this try, so a failure (even in the access read) unsubscribes.
      try {
        // Read access only after subscribing: any change committed after this read is queued, and
        // re-reads it before the events that follow are filtered. Replayed events were committed before
        // this read, so it already reflects any access they changed.
        await readAccess();
        // Replay runs as whoever reconnected: a `user.updated` about the viewer that it replays happened before
        // this connection authenticated, so it does not end the stream (and a project stream does not replay it).
        if (resume !== undefined) {
          const replay = await listEvents(
            ctx,
            { after: resume, limit: MAX_REPLAY, project: projectId },
            { tombstones: true },
          );
          if (replay.nextCursor) await reset();
          else for (const e of replay.data) await send(e);
        }
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ seq: last }) });
        // The stream ends when the session or identity token it authenticated with does, so a short SSO session (or
        // one the issuer ended) does not keep delivering; the browser reconnects with whatever it holds by then.
        const expiresAt = c.get('credentialExpiresAt')?.getTime();
        const now = () => (deps.clock ?? { now: () => new Date() }).now().getTime();
        const expired = () => expiresAt !== undefined && now() >= expiresAt;
        const stopping = () => stream.aborted || deps.shutdownSignal?.aborted === true || expired();
        // An identity-token stream also re-asks the issuer (cached, so at most one request per cache lifetime) before
        // each delivery and heartbeat, and ends once the token's session has ended or can't be confirmed (fail closed).
        const stillLive = c.get('credentialStillLive');
        const revoked = async () => !!stillLive && !(await stillLive().catch(() => false));
        deps.shutdownSignal?.addEventListener('abort', onShutdown);
        loop: while (!stopping()) {
          if (await revoked()) break;
          while (queue.length) {
            const { run, visible, lost } = await nextVisible();
            // The viewer's role or status changed: end the stream after that event so the client reconnects as who
            // they are now (or as anonymous), instead of keeping the access it connected with.
            const stop = run.find((e) => namesViewer(e, ctx.actor.id));
            for (const v of visible) if (!stop || v.seq <= stop.seq) await send(v);
            if (stop) break loop;
            // A project stream whose project the viewer can no longer read has nothing more to carry (on such a
            // stream, the event that ended their access is about its project).
            if (lost && projectId) break loop;
          }
          if (overflowed) {
            await reset();
            break;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(
              resolve,
              expiresAt === undefined
                ? HEARTBEAT_MS
                : Math.min(HEARTBEAT_MS, Math.max(0, expiresAt - now())),
            );
          });
          wake = undefined;
          if (!queue.length && !overflowed && !stopping()) await stream.write(': heartbeat\n\n');
        }
        if (deps.shutdownSignal?.aborted) {
          // Ask the browser to reconnect soon (to another replica, or this one once restarted).
          await stream.writeSSE({ event: 'shutdown', data: '{}', retry: 1000 });
        }
      } catch (error) {
        (deps.logger ?? silentLogger).error(
          { err: error, requestId: ctx.requestId },
          'live event stream failed; closing it',
        );
      } finally {
        deps.shutdownSignal?.removeEventListener('abort', onShutdown);
        unsubscribe();
      }
    });
  });
}
