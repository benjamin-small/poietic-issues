/**
 * Coalescing for inline issue edits (PIB-1). Edits to one issue that land close together are merged into one PATCH,
 * and fields that end up back at their starting value are dropped, so setting and clearing a value records nothing.
 */
import type { Issue, UpdateIssueInput } from './api.ts';

/** How long an issue's edits wait for more before they are sent. */
export const EDIT_DELAY_MS = 500;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Merges a later patch into an earlier one: later fields win, and label adds and removes cancel each other. */
export function mergePatch(a: UpdateIssueInput, b: UpdateIssueInput): UpdateIssueInput {
  const merged: UpdateIssueInput = { ...a, ...b };
  if (a.customFields || b.customFields)
    merged.customFields = { ...a.customFields, ...b.customFields };
  if (a.addLabels || a.removeLabels || b.addLabels || b.removeLabels) {
    const add = new Set(a.addLabels);
    const remove = new Set(a.removeLabels);
    for (const id of b.addLabels ?? []) {
      remove.delete(id);
      add.add(id);
    }
    for (const id of b.removeLabels ?? []) {
      add.delete(id);
      remove.add(id);
    }
    merged.addLabels = [...add];
    merged.removeLabels = [...remove];
  }
  return merged;
}

/** Drops the parts of a patch that would leave `base` unchanged. Fields it can't compare are kept. */
export function pruneUnchanged(patch: UpdateIssueInput, base: Issue): UpdateIssueInput {
  const out: UpdateIssueInput = { ...patch };
  const scalar = ['title', 'description', 'priority', 'estimate', 'dueDate', 'repo'] as const;
  for (const f of scalar) if (f in out && same(out[f], base[f])) delete out[f];
  if ('assignee' in out && same(out.assignee, base.assigneeId)) delete out.assignee;
  if ('status' in out && out.status === base.statusId) delete out.status;
  if (out.customFields) {
    const cf = Object.fromEntries(
      Object.entries(out.customFields).filter(([k, v]) => !same(v, base.customFields[k])),
    );
    if (Object.keys(cf).length) out.customFields = cf;
    else delete out.customFields;
  }
  if (out.addLabels) {
    const add = out.addLabels.filter((id) => !base.labelIds.includes(id));
    if (add.length) out.addLabels = add;
    else delete out.addLabels;
  }
  if (out.removeLabels) {
    const remove = out.removeLabels.filter((id) => base.labelIds.includes(id));
    if (remove.length) out.removeLabels = remove;
    else delete out.removeLabels;
  }
  return out;
}

interface Pending {
  base: Issue;
  patch: UpdateIssueInput;
  timer: ReturnType<typeof setTimeout>;
  waiters: ((issue: Issue | undefined) => void)[];
}

/**
 * Per-issue edit queue. `push` merges an edit into the issue's pending patch and restarts its timer. When the timer
 * fires, the patch is pruned against the issue as it was before the first pending edit, then sent (or skipped when
 * nothing is left). Sends for one issue run in order.
 */
export function createEditQueue(opts: {
  delay?: number;
  send: (base: Issue, patch: UpdateIssueInput) => Promise<Issue | undefined>;
}) {
  const delay = opts.delay ?? EDIT_DELAY_MS;
  const pending = new Map<string, Pending>();
  const inFlight = new Map<string, Promise<unknown>>();

  function flush(key: string) {
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    clearTimeout(p.timer);
    const patch = pruneUnchanged(p.patch, p.base);
    const run = (inFlight.get(key) ?? Promise.resolve()).then(() =>
      Object.keys(patch).length ? opts.send(p.base, patch) : p.base,
    );
    const settled = run.then(
      (issue) => p.waiters.forEach((w) => w(issue)),
      () => p.waiters.forEach((w) => w(undefined)),
    );
    inFlight.set(key, settled);
    void settled.then(() => {
      if (inFlight.get(key) === settled) inFlight.delete(key);
    });
  }

  return {
    /** Queues an edit; resolves with the saved issue (or the unchanged base when nothing was sent). */
    push(base: Issue, patch: UpdateIssueInput): Promise<Issue | undefined> {
      const key = base.key;
      const existing = pending.get(key);
      if (existing) clearTimeout(existing.timer);
      const entry: Pending = existing
        ? { ...existing, patch: mergePatch(existing.patch, patch) }
        : { base, patch, timer: undefined as never, waiters: [] };
      entry.timer = setTimeout(() => flush(key), delay);
      pending.set(key, entry);
      return new Promise((resolve) => entry.waiters.push(resolve));
    },
    /** Sends every pending edit now (for example when the page is being hidden). */
    flushAll() {
      for (const key of [...pending.keys()]) flush(key);
    },
  };
}
