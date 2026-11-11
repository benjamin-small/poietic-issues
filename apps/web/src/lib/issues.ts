import type { QueryClient } from '@tanstack/svelte-query';
import {
  api,
  call,
  type CreateIssueInput,
  errorMessage,
  type Issue,
  type UpdateIssueInput,
} from './api.ts';
import { createEditQueue } from './issue-edits.ts';
import { keys } from './queries.ts';
import { toast } from './toast.svelte.ts';

export const projectKeyOf = (issueKey: string) => issueKey.split('-')[0]!;

/** Writes an issue snapshot into the detail cache and every cached list that contains it. */
export function upsertIssue(qc: QueryClient, issue: Issue) {
  qc.setQueryData(keys.issue(issue.key), issue);
  for (const [key, list] of qc.getQueriesData<Issue[]>({
    queryKey: keys.issueLists(projectKeyOf(issue.key)),
  })) {
    if (list?.some((i) => i.id === issue.id))
      qc.setQueryData(
        key,
        list.map((i) => (i.id === issue.id ? issue : i)),
      );
  }
  for (const [key, list] of qc.getQueriesData<Issue[]>({ queryKey: ['children'] })) {
    if (list?.some((i) => i.id === issue.id))
      qc.setQueryData(
        key,
        list.map((i) => (i.id === issue.id ? issue : i)),
      );
  }
}

function snapshot(qc: QueryClient, issue: Issue) {
  const detail = qc.getQueryData<Issue>(keys.issue(issue.key));
  const lists = qc.getQueriesData<Issue[]>({ queryKey: keys.issueLists(projectKeyOf(issue.key)) });
  return () => {
    qc.setQueryData(keys.issue(issue.key), detail);
    for (const [key, data] of lists) qc.setQueryData(key, data);
  };
}

function afterChange(qc: QueryClient, issue: Issue) {
  void qc.invalidateQueries({ queryKey: keys.activity(issue.key) });
  void qc.invalidateQueries({ queryKey: keys.issueLists(projectKeyOf(issue.key)) });
  if (issue.parent) void qc.invalidateQueries({ queryKey: keys.children(issue.parent.key) });
}

/**
 * PATCHes an issue. `optimistic` fields are applied to caches immediately and rolled back on failure.
 * Returns the server's issue, or undefined if the update failed (an error toast is shown).
 */
export async function updateIssue(
  qc: QueryClient,
  issue: Issue,
  patch: UpdateIssueInput,
  optimistic?: Partial<Issue>,
): Promise<Issue | undefined> {
  const rollback = snapshot(qc, issue);
  if (optimistic) upsertIssue(qc, { ...issue, ...optimistic });
  try {
    const updated = await call(
      api.PATCH('/issues/{issue}', { params: { path: { issue: issue.key } }, body: patch }),
    );
    upsertIssue(qc, updated);
    afterChange(qc, updated);
    return updated;
  } catch (error) {
    rollback();
    toast(`Couldn't update ${issue.key}: ${errorMessage(error)}`, 'error');
    return undefined;
  }
}

const edits = createEditQueue({
  async send(base, patch) {
    try {
      const updated = await call(
        api.PATCH('/issues/{issue}', { params: { path: { issue: base.key } }, body: patch }),
      );
      upsertIssue(qc(), updated);
      afterChange(qc(), updated);
      return updated;
    } catch (error) {
      upsertIssue(qc(), base);
      toast(`Couldn't update ${base.key}: ${errorMessage(error)}`, 'error');
      return undefined;
    }
  },
});
let editClient: QueryClient | undefined;
const qc = () => editClient!;
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => edits.flushAll());

/**
 * An inline edit to one issue (a picker or a property field). It shows at once, and edits made within
 * `EDIT_DELAY_MS` of each other are saved as one PATCH, without the fields that ended back where they started
 * (PIB-1). On failure the issue is put back as it was before the first of those edits.
 */
export function editIssue(
  client: QueryClient,
  issue: Issue,
  patch: UpdateIssueInput,
  optimistic?: Partial<Issue>,
): Promise<Issue | undefined> {
  editClient = client;
  if (optimistic) upsertIssue(client, { ...issue, ...optimistic });
  return edits.push(issue, patch);
}

export interface MovePlacement {
  status?: string;
  afterId?: string | null;
  beforeId?: string | null;
  position?: 'top' | 'bottom';
}

/** Moves an issue on the board (status + position). Optimistic fields are applied first. */
export async function moveIssue(
  qc: QueryClient,
  issue: Issue,
  placement: MovePlacement,
  optimistic?: Partial<Issue>,
): Promise<Issue | undefined> {
  const rollback = snapshot(qc, issue);
  if (optimistic) upsertIssue(qc, { ...issue, ...optimistic });
  try {
    const moved = await call(
      api.POST('/issues/{issue}/move', { params: { path: { issue: issue.key } }, body: placement }),
    );
    upsertIssue(qc, moved);
    afterChange(qc, moved);
    return moved;
  } catch (error) {
    rollback();
    toast(`Couldn't move ${issue.key}: ${errorMessage(error)}`, 'error');
    return undefined;
  }
}

export async function createIssue(
  qc: QueryClient,
  project: string,
  input: CreateIssueInput,
): Promise<Issue | undefined> {
  try {
    const issue = await call(
      api.POST('/projects/{project}/issues', { params: { path: { project } }, body: input }),
    );
    qc.setQueryData(keys.issue(issue.key), issue);
    afterChange(qc, issue);
    return issue;
  } catch (error) {
    toast(`Couldn't create the issue: ${errorMessage(error)}`, 'error');
    return undefined;
  }
}

export async function deleteIssue(qc: QueryClient, issue: Issue): Promise<Issue | undefined> {
  try {
    const deleted = await call(
      api.DELETE('/issues/{issue}', { params: { path: { issue: issue.key }, query: {} } }),
    );
    upsertIssue(qc, deleted);
    afterChange(qc, deleted);
    toast(`${issue.key} moved to the trash`, 'info', {
      label: 'Undo',
      run: () => void restoreIssue(qc, deleted),
    });
    return deleted;
  } catch (error) {
    toast(`Couldn't delete ${issue.key}: ${errorMessage(error)}`, 'error');
    return undefined;
  }
}

export async function restoreIssue(qc: QueryClient, issue: Issue): Promise<Issue | undefined> {
  try {
    const restored = await call(
      api.POST('/issues/{issue}/restore', { params: { path: { issue: issue.key } } }),
    );
    upsertIssue(qc, restored);
    afterChange(qc, restored);
    return restored;
  } catch (error) {
    toast(`Couldn't restore ${issue.key}: ${errorMessage(error)}`, 'error');
    return undefined;
  }
}

/** Applies one update to several issues atomically (the bulk endpoint), then refreshes caches. */
export async function bulkUpdate(
  qc: QueryClient,
  issueKeys: string[],
  patch: Omit<UpdateIssueInput, 'expectedVersion'>,
  description: string,
): Promise<Issue[] | undefined> {
  if (issueKeys.length === 0) return [];
  try {
    const { data } = await call(api.POST('/issues/bulk', { body: { issues: issueKeys, patch } }));
    for (const issue of data) {
      upsertIssue(qc, issue);
      afterChange(qc, issue);
    }
    toast(
      issueKeys.length === 1
        ? `${issueKeys[0]}: ${description}`
        : `${description} on ${issueKeys.length} issues`,
      'success',
    );
    return data;
  } catch (error) {
    toast(`Couldn't update: ${errorMessage(error)}`, 'error');
    return undefined;
  }
}

/** Adds a label to every issue, or removes it from all of them if they all have it already. */
export async function toggleLabel(
  qc: QueryClient,
  issues: Issue[],
  labelId: string,
  labelName: string,
): Promise<void> {
  const remove = issues.every((i) => i.labelIds.includes(labelId));
  await bulkUpdate(
    qc,
    issues.map((i) => i.key),
    remove ? { removeLabels: [labelId] } : { addLabels: [labelId] },
    remove ? `Removed ${labelName}` : `Added ${labelName}`,
  );
}

/** Moves several issues to the trash, with one Undo that restores all of them. */
export async function deleteIssues(qc: QueryClient, issues: Issue[]): Promise<void> {
  if (issues.length === 1) return void (await deleteIssue(qc, issues[0]!));
  const deleted: Issue[] = [];
  for (const issue of issues) {
    try {
      const result = await call(
        api.DELETE('/issues/{issue}', { params: { path: { issue: issue.key }, query: {} } }),
      );
      upsertIssue(qc, result);
      afterChange(qc, result);
      deleted.push(result);
    } catch (error) {
      toast(`Couldn't delete ${issue.key}: ${errorMessage(error)}`, 'error');
    }
  }
  if (deleted.length)
    toast(`${deleted.length} issues moved to the trash`, 'info', {
      label: 'Undo',
      run: () => void Promise.all(deleted.map((issue) => restoreIssue(qc, issue))),
    });
}

/** Finds cached issue snapshots for keys (detail cache first, then any cached list). */
export function cachedIssues(qc: QueryClient, issueKeys: string[]): Issue[] {
  const found = new Map<string, Issue>();
  for (const key of issueKeys) {
    const detail = qc.getQueryData<Issue>(keys.issue(key));
    if (detail) found.set(key, detail);
  }
  if (found.size < issueKeys.length)
    for (const [, list] of qc.getQueriesData<Issue[]>({ queryKey: ['issues'] }))
      for (const issue of list ?? [])
        if (issueKeys.includes(issue.key) && !found.has(issue.key)) found.set(issue.key, issue);
  return issueKeys.map((k) => found.get(k)).filter((i): i is Issue => !!i);
}
