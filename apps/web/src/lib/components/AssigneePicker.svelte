<script lang="ts">
  import { formatActor } from '@poietic-tech/issues-schema';
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Issue, User } from '../api.ts';
  import { editIssue } from '../issues.ts';
  import Avatar from './Avatar.svelte';
  import Picker from './Picker.svelte';

  let {
    issue,
    users,
    showLabel = true,
    readonly = false,
  }: { issue: Issue; users: User[]; showLabel?: boolean; readonly?: boolean } = $props();
  const qc = useQueryClient();
  const NONE = '__none__';
  const items = $derived([
    { value: NONE, label: 'No assignee', user: null },
    ...users
      .filter((u) => !u.deactivatedAt)
      .map((u) => ({ value: u.id, label: u.name, keywords: [u.handle], user: u })),
  ]);

  function select(value: string) {
    const user = users.find((u) => u.id === value) ?? null;
    if ((user?.id ?? null) === issue.assigneeId) return;
    void editIssue(
      qc,
      issue,
      { assignee: user?.id ?? null },
      {
        assigneeId: user?.id ?? null,
        assignee: user
          ? {
              id: user.id,
              handle: user.handle,
              name: user.name,
              kind: user.kind,
              avatarUrl: user.avatarUrl,
              owner: user.owner ?? null,
            }
          : null,
      },
    );
  }
</script>

<Picker
  {items}
  selected={[issue.assigneeId ?? NONE]}
  onselect={select}
  triggerLabel="Change assignee"
  testid="assignee-picker"
  {readonly}
>
  {#snippet trigger()}
    <Avatar user={issue.assignee} />
    {#if showLabel}<span class="truncate {issue.assignee ? '' : 'text-fg-subtle'}"
        >{issue.assignee ? formatActor(issue.assignee) : 'Unassigned'}</span
      >{/if}
  {/snippet}
  {#snippet item(it)}
    <Avatar user={it.user} />
    <span class="truncate">{it.label}</span>
    {#if it.user}<span class="truncate text-xs text-fg-subtle"
        >{formatActor(it.user, { label: 'handle' })}</span
      >{/if}
  {/snippet}
</Picker>
