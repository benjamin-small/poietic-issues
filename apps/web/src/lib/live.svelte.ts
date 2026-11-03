import type { QueryClient } from '@tanstack/svelte-query';
import {
  compareIssues,
  FieldRegistry,
  type IssueFilter,
  matchesFilter,
  type SortSpec,
} from '@poietic-tech/issues-schema';
import { type Issue, ownRequestIds, type TrackerEvent } from './api.ts';
import { projectKeyOf } from './issues.ts';
import { type IssueListQuery, isSignedIn, keys, type Me } from './queries.ts';

/** Connection state, shown in the UI. */
export const live = $state({ connected: false });

type IssueRef = { id: string; key: string };

/**
 * Applies an issue snapshot from a live event to every cached query: the detail cache, and each cached list —
 * inserting, updating or removing the issue according to that list's filter (`matchesFilter`, the same
 * semantics as the server) and re-sorting with the list's sort.
 */
export function applyIssueSnapshot(
  qc: QueryClient,
  issue: Issue,
  meId: string | undefined,
  registry = new FieldRegistry(),
) {
  qc.setQueryData(keys.issue(issue.key), issue);
  for (const [key, list] of qc.getQueriesData<Issue[]>({
    queryKey: keys.issueLists(projectKeyOf(issue.key)),
  })) {
    if (!list) continue;
    const query = key[2] as IssueListQuery | undefined;
    if (!query) continue;
    const belongs =
      (query.includeDeleted || issue.deletedAt === null) &&
      matchesFilter(issue as never, query.filter as IssueFilter, { meId: meId ?? null, registry });
    const without = list.filter((i) => i.id !== issue.id);
    const next = belongs
      ? [...without, issue].sort(compareIssues(query.sort as SortSpec[]) as never)
      : without;
    if (belongs || without.length !== list.length) qc.setQueryData(key, next);
  }
}

/**
 * Removes an issue from every cached list of its project and refetches its page, for a deletion that came without
 * a snapshot to apply: a reader's tombstone, or a permanent delete.
 */
export function removeIssue(qc: QueryClient, issue: IssueRef) {
  for (const [key, list] of qc.getQueriesData<Issue[]>({
    queryKey: keys.issueLists(projectKeyOf(issue.key)),
  })) {
    if (list?.some((i) => i.id === issue.id))
      qc.setQueryData(
        key,
        list.filter((i) => i.id !== issue.id),
      );
  }
  void qc.invalidateQueries({ queryKey: keys.issue(issue.key) });
  void qc.invalidateQueries({ queryKey: ['children'] });
}

function handle(qc: QueryClient, event: TrackerEvent, meId: string | undefined) {
  const data = event.data as {
    requestId?: string;
    issue?: Issue | IssueRef;
    link?: { source: IssueRef; target: IssueRef };
    permanent?: boolean;
  };
  const own = data.requestId !== undefined && ownRequestIds.has(data.requestId);

  // A project event without content: it ended the viewer's access to that project (it was made private), and the
  // server sends nothing more about it. Refetch everything; its open pages now report not found.
  if (event.type.startsWith('project.') && Object.keys(data).length === 0) {
    void qc.invalidateQueries();
    return;
  }
  // A deletion without a snapshot: readers below write get only the issue's id and key (a tombstone), and a
  // permanent delete has nothing left to show either way.
  if (
    event.type === 'issue.deleted' &&
    data.issue &&
    (!('status' in data.issue) || data.permanent)
  ) {
    removeIssue(qc, data.issue);
    return;
  }

  if (event.type.startsWith('issue.') && data.issue && 'status' in data.issue) {
    const issue = data.issue;
    if (!own) applyIssueSnapshot(qc, issue, meId);
    void qc.invalidateQueries({ queryKey: keys.activity(issue.key) });
    void qc.invalidateQueries({ queryKey: ['children'] });
    return;
  }
  if (event.type.startsWith('comment.') && data.issue) {
    if (!own) void qc.invalidateQueries({ queryKey: keys.comments(data.issue.key) });
    void qc.invalidateQueries({ queryKey: keys.issue(data.issue.key) }); // comment count
    void qc.invalidateQueries({ queryKey: keys.activity(data.issue.key) });
    return;
  }
  if (event.type.startsWith('attachment.') && data.issue) {
    void qc.invalidateQueries({ queryKey: keys.attachments(data.issue.key) });
    void qc.invalidateQueries({ queryKey: keys.activity(data.issue.key) });
    return;
  }
  if (event.type.startsWith('link.') && data.link) {
    for (const ref of [data.link.source, data.link.target]) {
      void qc.invalidateQueries({ queryKey: keys.links(ref.key) });
      void qc.invalidateQueries({ queryKey: keys.activity(ref.key) });
    }
    return;
  }
  // Membership changed: the viewer's own level (`myAccess`) may differ, so refetch it (the controls that depend on
  // it follow) and the members list. Nothing else about the project changed. A group grant is the same kind of
  // change; its event names a group, not a user, so it cannot say whether it concerns the viewer.
  const groupGrant = event.type.startsWith('project.group_grant_');
  if (event.type.startsWith('project.member_') || groupGrant) {
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: keys.projects });
    void qc.invalidateQueries({ queryKey: ['members'] });
    // The viewer's own role changed: what they may see changed too (a former writer loses the trash), so open
    // lists and issue pages refetch.
    const member = (event.data as { member?: { user?: { id?: string } } }).member;
    if (groupGrant || (meId && member?.user?.id === meId)) {
      void qc.invalidateQueries({ queryKey: ['issues'] });
      void qc.invalidateQueries({ queryKey: ['issue'] });
    }
    return;
  }
  // Workflow, labels, projects, users: reference data changed (and issue snapshots embed some of it).
  if (
    event.type.startsWith('status.') ||
    event.type.startsWith('label.') ||
    event.type.startsWith('project.')
  ) {
    void qc.invalidateQueries({ queryKey: ['statuses'] });
    void qc.invalidateQueries({ queryKey: ['labels'] });
    void qc.invalidateQueries({ queryKey: keys.projects });
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: ['issues'] });
    // A visibility change can change the viewer's level too (the project and projects refetch above).
    if (event.type === 'project.updated') void qc.invalidateQueries({ queryKey: ['members'] });
    // Issues that named an unlinked repo lose it, open issue pages included.
    if (event.type === 'project.repo_removed') void qc.invalidateQueries({ queryKey: ['issue'] });
  } else if (event.type.startsWith('field.')) {
    // Field definitions changed: refetch them and anything embedding custom field values.
    void qc.invalidateQueries({ queryKey: ['fields'] });
    void qc.invalidateQueries({ queryKey: ['issues'] });
    void qc.invalidateQueries({ queryKey: ['issue'] });
  } else if (event.type.startsWith('user.')) {
    const user = (event.data as { user?: { id?: string } }).user;
    // The viewer's own account changed: their global role or status may differ, and with it `me` (admin-only
    // controls), every project's `myAccess` and what they can read. Refetch everything. The server also ends the
    // stream after this event; the browser reconnects as who they are now.
    if (meId && user?.id === meId) void qc.invalidateQueries();
    else void qc.invalidateQueries({ queryKey: keys.users });
  }
}

/**
 * Subscribes to live events over SSE (cookie-authenticated, same origin): one stream for every project the viewer
 * can read, filtered by the server (signed-out visitors get the public projects'), so any page stays current,
 * including the project list when a project is created or renamed. The browser reconnects automatically and
 * resumes with Last-Event-ID; a `reset` means the gap was too large, so everything refetches. Returns a function
 * that closes the connection.
 */
export function connectLive(qc: QueryClient): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource('/api/v1/events/stream');
  const meId = () => {
    const me = qc.getQueryData<Me>(keys.me);
    return isSignedIn(me) ? me.id : undefined;
  };
  let opened = false;

  source.addEventListener('ready', () => {
    live.connected = true;
    // After a reconnect we may have missed updates made while offline: refresh lists once.
    if (opened) {
      void qc.invalidateQueries({ queryKey: ['issues'] });
      void qc.invalidateQueries({ queryKey: keys.projects });
    }
    opened = true;
  });
  source.addEventListener('reset', () => void qc.invalidateQueries());
  // The server is restarting; the browser reconnects on its own (and replays from Last-Event-ID).
  source.addEventListener('shutdown', () => (live.connected = false));
  source.onerror = () => {
    live.connected = false;
  };
  source.onmessage = () => {};
  const onEvent = (message: MessageEvent<string>) => {
    try {
      handle(qc, JSON.parse(message.data) as TrackerEvent, meId());
    } catch (error) {
      console.error('live event failed', error);
    }
  };
  for (const type of [
    'issue.created',
    'issue.updated',
    'issue.deleted',
    'issue.restored',
    'comment.created',
    'comment.updated',
    'comment.deleted',
    'link.created',
    'link.deleted',
    'attachment.created',
    'attachment.deleted',
    'project.created',
    'project.updated',
    'project.member_added',
    'project.member_changed',
    'project.member_removed',
    'project.group_grant_added',
    'project.group_grant_changed',
    'project.group_grant_removed',
    'project.repo_added',
    'project.repo_removed',
    'status.created',
    'status.updated',
    'status.deleted',
    'label.created',
    'label.updated',
    'label.deleted',
    'user.created',
    'user.updated',
    'field.created',
    'field.updated',
    'field.deleted',
  ])
    source.addEventListener(type, onEvent);

  return () => {
    source.close();
    live.connected = false;
  };
}
