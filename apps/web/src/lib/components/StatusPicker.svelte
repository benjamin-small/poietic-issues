<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Issue, Status } from '../api.ts';
  import { editIssue } from '../issues.ts';
  import Picker from './Picker.svelte';
  import StatusIcon from './StatusIcon.svelte';

  let {
    issue,
    statuses,
    showLabel = true,
    readonly = false,
  }: { issue: Issue; statuses: Status[]; showLabel?: boolean; readonly?: boolean } = $props();
  const qc = useQueryClient();
  const items = $derived(statuses.map((s) => ({ value: s.id, label: s.name, status: s })));

  function select(id: string) {
    const s = statuses.find((x) => x.id === id);
    if (!s || s.id === issue.statusId) return;
    void editIssue(
      qc,
      issue,
      { status: s.id },
      {
        statusId: s.id,
        status: { id: s.id, name: s.name, category: s.category, color: s.color },
      },
    );
  }
</script>

<Picker
  {items}
  selected={[issue.statusId]}
  onselect={select}
  triggerLabel="Change status"
  testid="status-picker"
  {readonly}
>
  {#snippet trigger()}
    <StatusIcon category={issue.status.category} color={issue.status.color} />
    {#if showLabel}<span class="truncate">{issue.status.name}</span>{/if}
  {/snippet}
  {#snippet item(it)}
    <StatusIcon category={it.status.category} color={it.status.color} />
    <span class="truncate">{it.label}</span>
  {/snippet}
</Picker>
