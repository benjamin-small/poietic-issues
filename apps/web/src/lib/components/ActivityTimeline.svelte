<script lang="ts">
  import { agentNote, formatActor } from '@poietic-tech/issues-schema';
  import { btn } from '../styles.ts';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import type { Comment, Issue, TrackerEvent, User } from '../api.ts';
  import { api, call, errorMessage } from '../api.ts';
  import { PRIORITY_LABELS, relativeTime } from '../format.ts';
  import { fetchers, keys } from '../queries.ts';
  import { toast } from '../toast.svelte.ts';
  import Avatar from './Avatar.svelte';
  import { markdownUploader } from '../attachments.ts';
  import Markdown from './Markdown.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';

  /** `me` is undefined for signed-out visitors; `canWrite`/`canManage` come from the project's `myAccess`. */
  let {
    issue,
    me,
    canWrite,
    canManage,
  }: { issue: Issue; me: User | undefined; canWrite: boolean; canManage: boolean } = $props();
  const qc = useQueryClient();
  const upload = markdownUploader(qc, () => issue.key);
  const comments = createQuery(() => ({
    queryKey: keys.comments(issue.key),
    queryFn: () => fetchers.comments(issue.key),
  }));
  const activity = createQuery(() => ({
    queryKey: keys.activity(issue.key),
    queryFn: () => fetchers.activity(issue.key),
  }));

  type Entry =
    | { kind: 'comment'; at: string; comment: Comment }
    | { kind: 'event'; at: string; event: TrackerEvent };
  const entries = $derived<Entry[]>(
    [
      ...(comments.data ?? []).map((c) => ({
        kind: 'comment' as const,
        at: c.createdAt,
        comment: c,
      })),
      ...(activity.data ?? [])
        .filter((e) => !e.type.startsWith('comment.'))
        .map((e) => ({ kind: 'event' as const, at: e.createdAt, event: e })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
  );

  type Change = { from: unknown; to: unknown };
  const name = (v: unknown) =>
    v && typeof v === 'object' && 'handle' in v && 'kind' in v
      ? formatActor(v as Parameters<typeof formatActor>[0])
      : v && typeof v === 'object' && 'name' in v
        ? String((v as { name: string }).name)
        : v === null || v === undefined
          ? 'none'
          : String(v);

  /** The one-line reason the change was made with (`X-Change-Reason`), if any. */
  const reasonOf = (e: TrackerEvent): string | undefined =>
    typeof e.data.reason === 'string' ? e.data.reason : undefined;

  function describe(e: TrackerEvent): string[] {
    const data = e.data as {
      changes?: Record<string, Change>;
      link?: { type: string; source: { key: string }; target: { key: string } };
      permanent?: boolean;
      attachment?: { filename: string };
    };
    switch (e.type) {
      case 'issue.created':
        return ['created the issue'];
      case 'issue.deleted':
        return ['moved the issue to the trash'];
      case 'issue.restored':
        return ['restored the issue'];
      case 'link.created':
      case 'link.deleted': {
        const l = data.link!;
        const verb = e.type === 'link.created' ? 'linked' : 'unlinked';
        return [`${verb}: ${l.source.key} ${l.type} ${l.target.key}`];
      }
      case 'attachment.created':
        return [`attached ${data.attachment?.filename ?? 'a file'}`];
      case 'attachment.deleted':
        return [`removed attachment ${data.attachment?.filename ?? ''}`.trim()];
      case 'issue.updated': {
        const out: string[] = [];
        for (const [field, c] of Object.entries(data.changes ?? {})) {
          if (field === 'status') out.push(`changed status from ${name(c.from)} to ${name(c.to)}`);
          else if (field === 'priority')
            out.push(`set priority to ${PRIORITY_LABELS[c.to as number]}`);
          else if (field === 'assignee')
            out.push(c.to ? `assigned to ${name(c.to)}` : 'removed the assignee');
          else if (field === 'labels') {
            const before = new Set(((c.from as { name: string }[]) ?? []).map((l) => l.name));
            const after = new Set(((c.to as { name: string }[]) ?? []).map((l) => l.name));
            const added = [...after].filter((l) => !before.has(l));
            const removed = [...before].filter((l) => !after.has(l));
            if (added.length) out.push(`added label ${added.join(', ')}`);
            if (removed.length) out.push(`removed label ${removed.join(', ')}`);
          } else if (field === 'title') out.push(`renamed to “${String(c.to)}”`);
          else if (field === 'description') out.push('updated the description');
          else if (field === 'parent')
            out.push(
              c.to ? `set parent to ${(c.to as { key: string }).key}` : 'removed the parent',
            );
          else if (field === 'estimate') out.push(`set estimate to ${name(c.to)}`);
          else if (field === 'dueDate')
            out.push(c.to ? `set due date to ${String(c.to)}` : 'removed the due date');
          else if (field === 'customFields') out.push('updated custom fields');
          else if (field === 'metadata') out.push('updated metadata');
          else if (field === 'rank' && Object.keys(data.changes ?? {}).length === 1)
            out.push('reordered the issue');
        }
        return out;
      }
      default:
        return [e.type];
    }
  }

  let draft = $state('');
  let posting = $state(false);
  let editing = $state<string | null>(null);
  let editDraft = $state('');

  function refresh() {
    void qc.invalidateQueries({ queryKey: keys.comments(issue.key) });
    void qc.invalidateQueries({ queryKey: keys.issue(issue.key) });
  }

  async function post() {
    if (!draft.trim() || posting) return;
    posting = true;
    try {
      await call(
        api.POST('/issues/{issue}/comments', {
          params: { path: { issue: issue.key } },
          body: { body: draft },
        }),
      );
      draft = '';
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      posting = false;
    }
  }

  async function saveEdit(id: string) {
    try {
      await call(
        api.PATCH('/comments/{id}', { params: { path: { id } }, body: { body: editDraft } }),
      );
      editing = null;
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  async function remove(id: string) {
    try {
      await call(api.DELETE('/comments/{id}', { params: { path: { id } } }));
      refresh();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }
</script>

<section data-testid="activity">
  <h3 class="mb-3 text-sm font-semibold">Activity</h3>
  <ol class="space-y-3">
    {#each entries as entry (entry.kind === 'comment' ? entry.comment.id : entry.event.id)}
      {#if entry.kind === 'event'}
        {#each describe(entry.event) as line, i (i)}
          <li class="flex items-center gap-2 pl-1 text-xs text-fg-subtle">
            <Avatar user={entry.event.actor} size={14} />
            <span
              ><span class="text-fg-muted"
                >{entry.event.actor ? formatActor(entry.event.actor) : 'Someone'}</span
              >
              {line}{#if i === 0 && reasonOf(entry.event)}
                <span class="text-fg-muted" data-testid="change-reason"
                  >— {reasonOf(entry.event)}</span
                >{/if}</span
            >
            <span title={entry.at}>· {relativeTime(entry.at)}</span>
          </li>
        {/each}
      {:else}
        {@const c = entry.comment}
        <li class="rounded-lg border border-border bg-bg" data-testid="comment">
          <div class="flex items-center gap-2 px-3 pt-2 text-xs">
            <Avatar user={c.author} size={18} />
            <span class="font-medium">{c.author.name}</span>
            {#if agentNote(c.author)}<span
                class="rounded bg-bg-muted px-1 text-fg-subtle"
                data-testid="agent-note">{agentNote(c.author)}</span
              >{/if}
            <span class="text-fg-subtle" title={c.createdAt}
              >{relativeTime(c.createdAt)}{c.editedAt ? ' · edited' : ''}</span
            >
            {#if me && canWrite && (me.id === c.authorId || canManage) && editing !== c.id}
              <span class="ml-auto flex gap-2 text-fg-subtle">
                {#if me.id === c.authorId}
                  <button
                    class="hover:text-fg"
                    onclick={() => ((editing = c.id), (editDraft = c.body))}>Edit</button
                  >
                {/if}
                <button class="hover:text-danger" onclick={() => remove(c.id)}>Delete</button>
              </span>
            {/if}
          </div>
          <div class="px-3 pt-1 pb-2">
            {#if editing === c.id}
              <MarkdownEditor
                bind:value={editDraft}
                rows={3}
                autofocus
                onsubmit={() => saveEdit(c.id)}
                oncancel={() => (editing = null)}
                {upload}
              />
              <div class="mt-2 flex justify-end gap-2 text-xs">
                <button class="rounded px-2 py-1 hover:bg-bg-hover" onclick={() => (editing = null)}
                  >Cancel</button
                >
                <button class={btn.primarySm} onclick={() => saveEdit(c.id)}>Save</button>
              </div>
            {:else}
              <Markdown source={c.body} />
            {/if}
          </div>
        </li>
      {/if}
    {/each}
  </ol>
  {#if canWrite}
    <div class="mt-4">
      <MarkdownEditor
        bind:value={draft}
        rows={3}
        placeholder="Leave a comment…"
        onsubmit={post}
        testid="comment-input"
        {upload}
      />
      <div class="mt-2 flex justify-end">
        <button
          class={btn.primary}
          disabled={!draft.trim() || posting}
          onclick={post}
          data-testid="comment-submit">Comment</button
        >
      </div>
    </div>
  {/if}
</section>
