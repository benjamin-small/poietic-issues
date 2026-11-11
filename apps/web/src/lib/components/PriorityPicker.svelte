<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Issue } from '../api.ts';
  import { PRIORITY_LABELS, PRIORITY_ORDER } from '../format.ts';
  import { editIssue } from '../issues.ts';
  import Picker from './Picker.svelte';
  import PriorityIcon from './PriorityIcon.svelte';

  let {
    issue,
    showLabel = true,
    readonly = false,
  }: { issue: Issue; showLabel?: boolean; readonly?: boolean } = $props();
  const qc = useQueryClient();
  const items = PRIORITY_ORDER.map((p) => ({
    value: String(p),
    label: PRIORITY_LABELS[p],
    priority: p,
  }));

  function select(value: string) {
    const priority = Number(value);
    if (priority !== issue.priority) void editIssue(qc, issue, { priority }, { priority });
  }
</script>

<Picker
  {items}
  selected={[String(issue.priority)]}
  onselect={select}
  triggerLabel="Change priority"
  testid="priority-picker"
  {readonly}
>
  {#snippet trigger()}
    <PriorityIcon priority={issue.priority} />
    {#if showLabel}<span class="truncate {issue.priority ? '' : 'text-fg-subtle'}"
        >{PRIORITY_LABELS[issue.priority]}</span
      >{/if}
  {/snippet}
  {#snippet item(it)}
    <PriorityIcon priority={it.priority} />
    <span>{it.label}</span>
  {/snippet}
</Picker>
