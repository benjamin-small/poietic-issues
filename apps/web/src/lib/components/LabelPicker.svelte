<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import Tag from '@lucide/svelte/icons/tag';
  import type { Issue, Label } from '../api.ts';
  import { editIssue } from '../issues.ts';
  import LabelChip from './LabelChip.svelte';
  import Picker from './Picker.svelte';

  let {
    issue,
    labels,
    readonly = false,
  }: { issue: Issue; labels: Label[]; readonly?: boolean } = $props();
  const qc = useQueryClient();
  const items = $derived(labels.map((l) => ({ value: l.id, label: l.name, color: l.color })));

  function toggle(id: string) {
    const has = issue.labelIds.includes(id);
    const next = has ? issue.labelIds.filter((x) => x !== id) : [...issue.labelIds, id];
    const summaries = labels
      .filter((l) => next.includes(l.id))
      .map((l) => ({ id: l.id, name: l.name, color: l.color }))
      .sort((a, b) => a.name.localeCompare(b.name));
    void editIssue(qc, issue, has ? { removeLabels: [id] } : { addLabels: [id] }, {
      labelIds: next,
      labels: summaries,
    });
  }
</script>

<Picker
  {items}
  selected={issue.labelIds}
  multiple
  onselect={toggle}
  triggerLabel="Change labels"
  placeholder="Labels…"
  testid="label-picker"
  {readonly}
>
  {#snippet trigger()}
    {#if issue.labels.length}
      <span class="flex flex-wrap gap-1"
        >{#each issue.labels as l (l.id)}<LabelChip label={l} />{/each}</span
      >
    {:else if readonly}
      <span class="text-fg-subtle">No labels</span>
    {:else}
      <Tag size={14} class="text-fg-subtle" /><span class="text-fg-subtle">Add labels</span>
    {/if}
  {/snippet}
  {#snippet item(it)}
    <span class="size-2.5 shrink-0 rounded-full" style:background={it.color}></span>
    <span class="truncate">{it.label}</span>
  {/snippet}
</Picker>
