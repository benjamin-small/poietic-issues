<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { Issue, Project } from '../api.ts';
  import { repoUrl } from '../format.ts';
  import { editIssue } from '../issues.ts';
  import Picker from './Picker.svelte';

  /** Picks which of the project's linked GitHub repositories an issue belongs to. Read-only, it is a plain link. */
  let {
    issue,
    repos,
    readonly = false,
  }: { issue: Issue; repos: Project['repos']; readonly?: boolean } = $props();
  const qc = useQueryClient();
  const NONE = '__none__';
  const items = $derived([
    { value: NONE, label: 'No repository' },
    ...repos.map((r) => ({ value: r.fullName, label: r.fullName })),
  ]);
  const href = $derived(issue.repo ? repoUrl(repos, issue.repo) : null);

  function select(value: string) {
    const repo = value === NONE ? null : value;
    if (repo === issue.repo) return;
    void editIssue(qc, issue, { repo }, { repo });
  }
</script>

{#if readonly}
  {#if issue.repo}
    <a
      {href}
      target="_blank"
      rel="noreferrer"
      class="inline-flex items-center gap-1.5 px-1.5 py-1 hover:underline"
      ><GitBranch size={14} /><span class="truncate">{issue.repo}</span></a
    >
  {:else}
    <span class="px-1.5 text-fg-subtle">No repository</span>
  {/if}
{:else}
  <span class="flex min-w-0 items-center">
    <Picker {items} selected={[issue.repo ?? NONE]} onselect={select} triggerLabel="Repository">
      {#snippet trigger()}
        <GitBranch size={14} />
        <span class="truncate {issue.repo ? '' : 'text-fg-subtle'}"
          >{issue.repo ?? 'Set repository'}</span
        >
      {/snippet}
    </Picker>
    {#if href}
      <a
        {href}
        target="_blank"
        rel="noreferrer"
        aria-label="Open {issue.repo} on GitHub"
        title="Open on GitHub"
        class="shrink-0 rounded p-1 text-fg-subtle hover:bg-bg-hover hover:text-fg"
        ><ExternalLink size={13} /></a
      >
    {/if}
  </span>
{/if}
