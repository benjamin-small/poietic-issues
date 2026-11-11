import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, UpdateIssueInput } from './api.ts';
import { createEditQueue, EDIT_DELAY_MS, mergePatch, pruneUnchanged } from './issue-edits.ts';

const issue = (over: Partial<Issue> = {}): Issue =>
  ({
    key: 'PIB-1',
    title: 'T',
    description: '',
    priority: 0,
    estimate: null,
    dueDate: null,
    repo: null,
    assigneeId: null,
    statusId: 'sts_a',
    labelIds: ['lbl_a'],
    customFields: {},
    ...over,
  }) as Issue;

describe('mergePatch', () => {
  it('lets later fields win and merges custom fields', () => {
    expect(
      mergePatch(
        { estimate: 1, customFields: { a: 1 } },
        { estimate: null, customFields: { b: 2 } },
      ),
    ).toEqual({ estimate: null, customFields: { a: 1, b: 2 } });
  });

  it('cancels a label add against a later remove', () => {
    expect(mergePatch({ addLabels: ['x'] }, { removeLabels: ['x'] })).toEqual({
      addLabels: [],
      removeLabels: ['x'],
    });
  });
});

describe('pruneUnchanged', () => {
  it('drops fields back at their starting value', () => {
    const base = issue({ estimate: 2, assigneeId: 'usr_a', customFields: { sev: 'high' } });
    expect(
      pruneUnchanged(
        {
          estimate: 2,
          assignee: 'usr_a',
          status: 'sts_a',
          priority: 3,
          customFields: { sev: 'high', team: null },
          addLabels: ['lbl_a'],
          removeLabels: ['lbl_b'],
        },
        base,
      ),
    ).toEqual({ priority: 3 });
  });

  it('keeps real changes', () => {
    const patch: UpdateIssueInput = {
      estimate: null,
      customFields: { sev: 'low' },
      addLabels: ['lbl_b'],
      removeLabels: ['lbl_a'],
    };
    expect(pruneUnchanged(patch, issue({ estimate: 1, customFields: { sev: 'high' } }))).toEqual(
      patch,
    );
  });
});

describe('createEditQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends nothing when an edit is undone within the delay', async () => {
    const send = vi.fn();
    const q = createEditQueue({ send });
    const base = issue();
    const a = q.push(base, { estimate: 3 });
    const b = q.push(issue({ estimate: 3 }), { estimate: null });
    await vi.advanceTimersByTimeAsync(EDIT_DELAY_MS);
    expect(send).not.toHaveBeenCalled();
    expect(await a).toBe(base);
    expect(await b).toBe(base);
  });

  it('merges quick edits into one send, pruned against the first base', async () => {
    const saved = issue({ estimate: 2, priority: 1 });
    const send = vi.fn(async () => saved);
    const q = createEditQueue({ send });
    const base = issue();
    void q.push(base, { estimate: 1 });
    await vi.advanceTimersByTimeAsync(EDIT_DELAY_MS - 1);
    void q.push(issue({ estimate: 1 }), { estimate: 2 });
    const last = q.push(issue({ estimate: 2 }), { priority: 1 });
    await vi.advanceTimersByTimeAsync(EDIT_DELAY_MS);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(base, { estimate: 2, priority: 1 });
    expect(await last).toBe(saved);
  });

  it('keeps issues apart, and flushAll sends at once', async () => {
    const send = vi.fn(async (b: Issue) => b);
    const q = createEditQueue({ send });
    void q.push(issue(), { priority: 2 });
    void q.push(issue({ key: 'PIB-2' }), { priority: 3 });
    q.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('runs sends for one issue in order', async () => {
    const order: string[] = [];
    let release!: () => void;
    const send = vi.fn(async (_b: Issue, p: UpdateIssueInput) => {
      if (p.priority === 1) await new Promise<void>((r) => (release = r));
      order.push(String(p.priority));
      return undefined;
    });
    const q = createEditQueue({ send });
    void q.push(issue(), { priority: 1 });
    q.flushAll();
    void q.push(issue({ priority: 1 }), { priority: 2 });
    q.flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['1', '2']);
  });
});
