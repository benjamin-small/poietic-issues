import type { Change } from './events.ts';
import { type ApiClient, type Schemas, unwrap } from './index.ts';

/**
 * An issue's history from the event log, for review by people and for agents that want context, and the provenance
 * of its fields: which event (so which verified actor) last set them. Issue metadata alone proves nothing, since any
 * project writer can edit it; the event's `actorId` comes from the writer's verified identity and cannot be forged.
 */

type Event = Schemas['Event'];

export interface HistoryEntry {
  seq: number;
  type: Event['type'];
  at: string;
  actorId: string | null;
  actor: Event['actor'];
  /** `data.changes`: `{}` for events that carry none (creations, comments). */
  changes: Record<string, Change>;
  reason: string | null;
  requestId: string | null;
}

function toEntry(e: Event): HistoryEntry {
  const data = e.data as { changes?: Record<string, Change>; reason?: string; requestId?: string };
  return {
    seq: e.seq,
    type: e.type,
    at: e.createdAt,
    actorId: e.actorId,
    actor: e.actor,
    changes: data.changes ?? {},
    reason: data.reason ?? null,
    requestId: data.requestId ?? null,
  };
}

async function activity(api: ApiClient, issue: string): Promise<Event[]> {
  const events: Event[] = [];
  let after: number | undefined;
  for (;;) {
    const page = unwrap(
      await api.GET('/issues/{issue}/activity', {
        params: { path: { issue }, query: { ...(after !== undefined && { after }), limit: 200 } },
      }),
    );
    events.push(...page.data);
    if (page.nextCursor === null) return events;
    const next = Number(page.nextCursor);
    if (!Number.isInteger(next) || (after !== undefined && next <= after))
      throw new Error(`The activity cursor did not move forward (next ${page.nextCursor})`);
    after = next;
  }
}

/** The issue's activity (changes, comments, links), oldest first, with reasons. */
export async function history(api: ApiClient, issue: string): Promise<HistoryEntry[]> {
  return (await activity(api, issue)).map(toEntry);
}

/** `'assignee'`, or `'metadata.<key>'` for one metadata key. */
export type ProvenanceField = 'assignee' | `metadata.${string}`;

const METADATA = 'metadata.';

/** Whether `event` set `field`. A creation sets every field it gives a value; an update, every field it changed. */
function sets(event: Event, field: ProvenanceField): boolean {
  const data = event.data as {
    issue?: { assignee?: unknown; metadata?: Record<string, unknown> };
    changes?: Record<string, Change<Record<string, unknown> | null>>;
  };
  const key = field.startsWith(METADATA) ? field.slice(METADATA.length) : null;
  if (event.type === 'issue.created') {
    const value = key === null ? data.issue?.assignee : data.issue?.metadata?.[key];
    return value !== null && value !== undefined;
  }
  if (event.type !== 'issue.updated') return false;
  if (key === null) return data.changes?.assignee !== undefined;
  const metadata = data.changes?.metadata;
  return (
    metadata !== undefined &&
    JSON.stringify(metadata.from?.[key]) !== JSON.stringify(metadata.to?.[key])
  );
}

/**
 * For each field, the latest event that set it, or null if none did. A hand-off is proven when both of its fields
 * point at the same event and that event's actor is the one expected (persistent-agents checks the manager).
 */
export async function provenance(
  api: ApiClient,
  issue: string,
  fields: readonly ProvenanceField[],
): Promise<Record<ProvenanceField, HistoryEntry | null>> {
  const events = await activity(api, issue);
  const found = {} as Record<ProvenanceField, HistoryEntry | null>;
  for (const field of fields) {
    const last = events.findLast((e) => sets(e, field));
    found[field] = last ? toEntry(last) : null;
  }
  return found;
}
