import type { Schemas } from './index.ts';

/**
 * Typed tracker events and the helpers agents use to decide what an event means to them. Events are read from
 * `GET /events` as the agent itself (see `follow.ts`); nothing here trusts a pushed notice.
 */

type Event = Schemas['Event'];

/** A changed field's previous and new value, as in `data.changes`. */
export type Change<T = unknown> = { from: T; to: T };

/** What every event's `data` may carry besides its snapshot. */
export type EventMeta = { requestId?: string; reason?: string };

type IssueType = 'issue.created' | 'issue.updated' | 'issue.deleted' | 'issue.restored';
type CommentType = 'comment.created' | 'comment.updated' | 'comment.deleted';

export type IssueEvent = Omit<Event, 'type' | 'data'> & {
  type: IssueType;
  data: EventMeta & {
    issue: Schemas['Issue'];
    changes?: Partial<Record<keyof Schemas['Issue'], Change>>;
  };
};

export type CommentEvent = Omit<Event, 'type' | 'data'> & {
  type: CommentType;
  data: EventMeta & { comment: Schemas['Comment']; issue: Schemas['IssueRef'] };
};

export type OtherEvent = Omit<Event, 'type' | 'data'> & {
  type: Exclude<Event['type'], IssueType | CommentType>;
  data: EventMeta & Record<string, unknown>;
};

export type TypedEvent = IssueEvent | CommentEvent | OtherEvent;

/** The event with its `data` typed by `type` (no copy: the API already sends these shapes). */
export function typed(event: Event): TypedEvent {
  return event as TypedEvent;
}

const isIssueEvent = (e: TypedEvent): e is IssueEvent => e.type.startsWith('issue.');
const isCommentEvent = (e: TypedEvent): e is CommentEvent => e.type.startsWith('comment.');

/** Longest reason the tracker accepts, in characters. */
export const REASON_MAX = 200;

/**
 * Headers that give a write its one-line reason, for any call: `api.PATCH(path, { ..., headers: reasonHeaders(r) })`.
 * Percent-encoded, since header values cannot hold most non-ASCII text. Throws a `RangeError` for what the server
 * would refuse (more than 200 characters, or more than one line); a blank reason sends nothing.
 */
export function reasonHeaders(reason: string | undefined): Record<string, string> {
  const trimmed = reason?.trim();
  if (!trimmed) return {};
  if ([...trimmed].length > REASON_MAX)
    throw new RangeError(`A change reason is at most ${REASON_MAX} characters`);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmed)) throw new RangeError('A change reason is one line');
  return { 'x-change-reason': encodeURIComponent(trimmed) };
}

/** Who "me" is, for deciding what an event means to an agent. */
export interface Self {
  /** The agent's tracker user id. */
  userId: string;
  /** Whether a request id is one this agent generated (see `ClientOptions.requestId`). */
  ownRequest?: (requestId: string) => boolean;
  /** Projects the agent works in. */
  projectIds?: readonly string[];
  /** Issues the agent holds (assigned to it), for comments, whose events carry no assignee. */
  issueIds?: ReadonlySet<string>;
}

/** Whether the event is the agent's own write, so it does not wake itself up. */
export function isOwnWrite(event: Event, me: Pick<Self, 'userId' | 'ownRequest'>): boolean {
  if (event.actorId === me.userId) return true;
  const requestId = typed(event).data.requestId;
  return requestId !== undefined && me.ownRequest !== undefined && me.ownRequest(requestId);
}

/** Why an event concerns the agent, most specific first. */
export type Concern = 'newly_assigned' | 'assigned' | 'comment_on_mine' | 'in_my_project';

const userIdOf = (value: unknown): string | null =>
  value && typeof value === 'object' && 'id' in value ? String(value.id) : null;

/** Why the event concerns the agent, or null when it does not. */
export function concerns(event: Event, me: Self): Concern | null {
  const e = typed(event);
  if (isIssueEvent(e)) {
    const assignee = e.data.changes?.assignee;
    if (assignee && userIdOf(assignee.to) === me.userId) return 'newly_assigned';
    if (e.data.issue?.assigneeId === me.userId) return 'assigned';
  }
  if (isCommentEvent(e) && me.issueIds?.has(e.data.issue.id)) return 'comment_on_mine';
  if (e.projectId !== null && me.projectIds?.includes(e.projectId)) return 'in_my_project';
  return null;
}

/** Each issue's events, in seq order. Events about no issue are left out. */
export function byIssue(events: readonly Event[]): Map<string, Event[]> {
  const grouped = new Map<string, Event[]>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.issueId === null) continue;
    const list = grouped.get(e.issueId);
    if (list) list.push(e);
    else grouped.set(e.issueId, [e]);
  }
  return grouped;
}
