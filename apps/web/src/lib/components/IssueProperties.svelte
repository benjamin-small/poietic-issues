<script lang="ts">
  import { formatActor } from '@poietic-tech/issues-schema';
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Issue } from '../api.ts';
  import { relativeTime } from '../format.ts';
  import { editIssue } from '../issues.ts';
  import type { ProjectData } from '../project-data.svelte.ts';
  import AssigneePicker from './AssigneePicker.svelte';
  import Avatar from './Avatar.svelte';
  import DateInput from './DateInput.svelte';
  import LabelPicker from './LabelPicker.svelte';
  import PriorityPicker from './PriorityPicker.svelte';
  import RepoPicker from './RepoPicker.svelte';
  import StatusPicker from './StatusPicker.svelte';
  import type { Snippet } from 'svelte';

  let { issue, project, extra }: { issue: Issue; project: ProjectData; extra?: Snippet } = $props();
  const qc = useQueryClient();
  /** Without write access the properties read as plain text (the server would refuse edits anyway). */
  const readonly = $derived(!project.canWrite);

  function setEstimate(event: Event) {
    const raw = (event.target as HTMLInputElement).value.trim();
    const estimate = raw === '' ? null : Number(raw);
    if (estimate !== null && Number.isNaN(estimate)) return;
    if (estimate !== issue.estimate) void editIssue(qc, issue, { estimate }, { estimate });
  }

  function setDue(dueDate: string | null) {
    if (dueDate !== issue.dueDate) void editIssue(qc, issue, { dueDate }, { dueDate });
  }
</script>

{#snippet row(label: string, content: Snippet)}
  <div class="grid grid-cols-[88px_1fr] items-center gap-2 py-0.5">
    <span class="text-xs text-fg-subtle">{label}</span>
    <div class="min-w-0">{@render content()}</div>
  </div>
{/snippet}

<div class="space-y-0.5 text-sm" data-testid="issue-properties">
  {#snippet status()}<StatusPicker {issue} statuses={project.statuses} {readonly} />{/snippet}
  {#snippet priority()}<PriorityPicker {issue} {readonly} />{/snippet}
  {#snippet assignee()}<AssigneePicker {issue} users={project.users} {readonly} />{/snippet}
  {#snippet labels()}<LabelPicker {issue} labels={project.labels} {readonly} />{/snippet}
  {#snippet repo()}<RepoPicker {issue} repos={project.repos} {readonly} />{/snippet}
  {#snippet estimate()}
    {#if readonly}
      <span class="px-1.5 {issue.estimate === null ? 'text-fg-subtle' : ''}"
        >{issue.estimate ?? 'No estimate'}</span
      >
    {:else}
      <input
        type="number"
        min="0"
        step="0.5"
        value={issue.estimate ?? ''}
        placeholder="Set estimate"
        aria-label="Estimate"
        onchange={setEstimate}
        class="w-full rounded bg-transparent px-1.5 py-1 placeholder:text-fg-subtle hover:bg-bg-hover focus:bg-bg-hover focus:outline-none"
      />
    {/if}
  {/snippet}
  {#snippet due()}
    <DateInput
      value={issue.dueDate}
      label="Due date"
      placeholder={readonly ? 'No due date' : 'Set due date'}
      testid="due-date"
      overdue={!['completed', 'canceled'].includes(issue.status.category)}
      disabled={!!issue.deletedAt || readonly}
      onchange={setDue}
    />
  {/snippet}
  {#snippet creator()}
    <span class="inline-flex items-center gap-1.5 px-1.5 text-fg-muted"
      ><Avatar user={issue.creator} size={16} />{formatActor(issue.creator)} · {relativeTime(
        issue.createdAt,
      )}</span
    >
  {/snippet}
  {@render row('Status', status)}
  {@render row('Priority', priority)}
  {@render row('Assignee', assignee)}
  {@render row('Labels', labels)}
  {#if project.repos.length || issue.repo}{@render row('Repository', repo)}{/if}
  {@render row('Estimate', estimate)}
  {@render row('Due date', due)}
  {@render extra?.()}
  {@render row('Created by', creator)}
</div>
