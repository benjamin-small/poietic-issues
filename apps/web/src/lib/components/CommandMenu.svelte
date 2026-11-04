<script lang="ts">
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { Command, Dialog } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import type { Issue } from '../api.ts';
  import { PRIORITY_LABELS, PRIORITY_ORDER } from '../format.ts';
  import { bulkUpdate, cachedIssues, deleteIssues, projectKeyOf, toggleLabel } from '../issues.ts';
  import { navigate, shareUrl, signInPath } from '../nav.ts';
  import { useProjectData } from '../project-data.svelte.ts';
  import { canWrite, fetchers, isAdmin as isAdminMe, isSignedIn, keys } from '../queries.ts';
  import { signOut } from '../session.ts';
  import { clearSelection } from '../selection.svelte.ts';
  import { applyTheme } from '../theme.ts';
  import { toast } from '../toast.svelte.ts';
  import { type CommandMode, openCreateIssue, ui } from '../ui.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Kbd from './Kbd.svelte';
  import PriorityIcon from './PriorityIcon.svelte';
  import StatusIcon from './StatusIcon.svelte';

  /** ⌘K: every action in one searchable place. Issue actions apply to `ui.command.targets`. */
  let { currentProject }: { currentProject: string } = $props();
  const qc = useQueryClient();
  const me = createQuery(() => ({ queryKey: keys.me, queryFn: fetchers.me, staleTime: 300_000 }));
  const projects = createQuery(() => ({ queryKey: keys.projects, queryFn: fetchers.projects }));

  let search = $state('');
  let listEl = $state<HTMLElement | null>(null);
  const mode = $derived(ui.command.mode);
  const targets = $derived(cachedIssues(qc, ui.command.targets));
  const targetProject = $derived(targets[0] ? projectKeyOf(targets[0].key) : currentProject);
  const project = useProjectData(() => targetProject);
  const isAdmin = $derived(isAdminMe(me.data));
  /** New issues go to the current project, so creating needs write access there. */
  const canCreateIssue = $derived(
    canWrite(projects.data?.find((p) => p.key === currentProject)?.myAccess),
  );

  const TITLES: Record<CommandMode, string> = {
    root: '',
    status: 'Change status',
    assignee: 'Assign to',
    priority: 'Set priority',
    labels: 'Labels',
  };

  const describeTargets = $derived(
    targets.length === 1 ? `${targets[0]!.key} ${targets[0]!.title}` : `${targets.length} issues`,
  );

  /** Issues on screen for "jump to issue" (whatever lists are cached for the current project). */
  const searchable = $derived.by(() => {
    const seen: Record<string, Issue> = {};
    for (const [, list] of qc.getQueriesData<Issue[]>({
      queryKey: keys.issueLists(currentProject),
    }))
      for (const issue of list ?? []) if (!issue.deletedAt) seen[issue.key] = issue;
    return Object.values(seen);
  });
  const keyQuery = $derived(
    /^[a-z][a-z0-9]*-\d+$/i.test(search.trim()) ? search.trim().toUpperCase() : null,
  );

  function close() {
    ui.command.open = false;
  }
  function setMode(next: CommandMode) {
    ui.command.mode = next;
    search = '';
    listEl?.scrollTo({ top: 0 });
  }
  function run(action: () => unknown) {
    close();
    void action();
  }
  function openIssue(key: string) {
    run(() => (ui.opener ? ui.opener(key) : navigate(`/i/${key}`)));
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Backspace' && search === '' && mode !== 'root') {
      event.preventDefault();
      setMode('root');
    }
  }

  $effect(() => {
    if (ui.command.open) search = '';
  });
  // Field shortcuts (s, a, p, l) are disabled without write access; never show their edit modes then.
  const readOnly = $derived(project.access !== undefined && !project.canWrite);
  $effect(() => {
    if (mode !== 'root' && readOnly) ui.command.mode = 'root';
  });

  const targetKeys = () => targets.map((t) => t.key);
  const allHaveLabel = (id: string) =>
    targets.length > 0 && targets.every((t) => t.labelIds.includes(id));
  const item =
    'flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm data-selected:bg-bg-hover';
  const heading = 'px-2.5 pt-2 pb-1 text-xs font-medium text-fg-subtle';
</script>

<Dialog.Root open={ui.command.open} onOpenChange={(open) => !open && close()}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/30" />
    <Dialog.Content
      class="fixed top-[14vh] left-1/2 z-50 w-[min(600px,94vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-bg shadow-2xl"
      data-testid="command-menu"
    >
      <Dialog.Title class="sr-only">Command menu</Dialog.Title>
      <Command.Root loop>
        <div class="flex items-center gap-2 border-b border-border px-3">
          {#if mode !== 'root'}
            <button
              class="rounded p-0.5 text-fg-subtle hover:bg-bg-hover hover:text-fg"
              aria-label="Back"
              onclick={() => setMode('root')}><ChevronLeft size={16} /></button
            >
            <span class="shrink-0 rounded bg-bg-muted px-1.5 py-0.5 text-xs text-fg-muted"
              >{TITLES[mode]}</span
            >
          {/if}
          <Command.Input
            bind:value={search}
            onkeydown={keydown}
            placeholder={mode === 'root'
              ? targets.length
                ? `Actions for ${describeTargets}…`
                : 'Type a command or search issues…'
              : 'Filter…'}
            class="w-full bg-transparent py-3 text-sm outline-none placeholder:text-fg-subtle"
            data-testid="command-input"
          />
        </div>
        <Command.List class="max-h-[min(420px,60vh)] overflow-y-auto p-1.5" bind:ref={listEl}>
          <Command.Empty class="px-3 py-6 text-center text-sm text-fg-subtle"
            >No results</Command.Empty
          >

          {#if mode === 'root'}
            {#if targets.length}
              <Command.Group>
                <Command.GroupHeading class={heading}>{describeTargets}</Command.GroupHeading>
                <Command.GroupItems>
                  {#if project.canWrite}
                    <Command.Item
                      class={item}
                      value="Change status"
                      onSelect={() => setMode('status')}
                      >Change status…<Kbd class="ml-auto">S</Kbd></Command.Item
                    >
                    <Command.Item
                      class={item}
                      value="Assign to"
                      keywords={['assignee', 'owner']}
                      onSelect={() => setMode('assignee')}
                      >Assign to…<Kbd class="ml-auto">A</Kbd></Command.Item
                    >
                    <Command.Item
                      class={item}
                      value="Set priority"
                      onSelect={() => setMode('priority')}
                      >Set priority…<Kbd class="ml-auto">P</Kbd></Command.Item
                    >
                    <Command.Item
                      class={item}
                      value="Labels"
                      keywords={['tag']}
                      onSelect={() => setMode('labels')}
                      >Add or remove labels…<Kbd class="ml-auto">L</Kbd></Command.Item
                    >
                  {/if}
                  {#if targets.length === 1}
                    <Command.Item
                      class={item}
                      value="Open issue"
                      onSelect={() => openIssue(targets[0]!.key)}
                      >Open {targets[0]!.key}<Kbd class="ml-auto">↵</Kbd></Command.Item
                    >
                    <Command.Item
                      class={item}
                      value="Copy link"
                      onSelect={() =>
                        run(async () => {
                          await navigator.clipboard
                            ?.writeText(shareUrl(`/i/${targets[0]!.key}`))
                            .catch(() => {});
                          toast(`Copied link to ${targets[0]!.key}`, 'success');
                        })}>Copy link</Command.Item
                    >
                  {/if}
                  {#if project.canWrite}
                    <Command.Item
                      class="{item} text-danger"
                      value="Delete"
                      keywords={['trash', 'remove']}
                      onSelect={() =>
                        run(async () => {
                          await deleteIssues(qc, targets);
                          clearSelection();
                        })}
                      >Delete {targets.length === 1 ? 'issue' : `${targets.length} issues`}<Kbd
                        class="ml-auto">⌫</Kbd
                      ></Command.Item
                    >
                  {/if}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if (currentProject && canCreateIssue) || isAdmin}
              <Command.Group>
                <Command.GroupHeading class={heading}>Create</Command.GroupHeading>
                <Command.GroupItems>
                  {#if currentProject && canCreateIssue}
                    <Command.Item
                      class={item}
                      value="New issue"
                      keywords={['create']}
                      onSelect={() => run(() => openCreateIssue(currentProject))}
                      >New issue<Kbd class="ml-auto">C</Kbd></Command.Item
                    >
                  {/if}
                  {#if isAdmin}
                    <Command.Item
                      class={item}
                      value="New project"
                      onSelect={() => run(() => (ui.createProject = true))}
                      >New project</Command.Item
                    >
                  {/if}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if keyQuery}
              <Command.Group>
                <Command.GroupHeading class={heading}>Open</Command.GroupHeading>
                <Command.GroupItems>
                  <Command.Item
                    class={item}
                    value={`Open ${keyQuery}`}
                    keywords={[search]}
                    onSelect={() => openIssue(keyQuery!)}
                    >Open <span class="font-mono">{keyQuery}</span></Command.Item
                  >
                </Command.GroupItems>
              </Command.Group>
            {/if}

            {#if searchable.length}
              <Command.Group>
                <Command.GroupHeading class={heading}>Issues</Command.GroupHeading>
                <Command.GroupItems>
                  {#each searchable as issue (issue.id)}
                    <Command.Item
                      class={item}
                      value={`issue ${issue.key}`}
                      keywords={[issue.key, issue.title]}
                      onSelect={() => openIssue(issue.key)}
                    >
                      <StatusIcon category={issue.status.category} color={issue.status.color} />
                      <span class="font-mono text-xs text-fg-subtle">{issue.key}</span>
                      <span class="truncate">{issue.title}</span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/if}

            <Command.Group>
              <Command.GroupHeading class={heading}>Go to</Command.GroupHeading>
              <Command.GroupItems>
                {#each projects.data ?? [] as p (p.id)}
                  <Command.Item
                    class={item}
                    value={`${p.name} issues`}
                    keywords={[p.key, 'list']}
                    onSelect={() => run(() => navigate(`/p/${p.key}`))}
                    >{p.name}: Issues{#if p.key === currentProject}<Kbd class="ml-auto">G I</Kbd
                      >{/if}</Command.Item
                  >
                  <Command.Item
                    class={item}
                    value={`${p.name} board`}
                    keywords={[p.key, 'kanban']}
                    onSelect={() => run(() => navigate(`/p/${p.key}/board`))}
                    >{p.name}: Board{#if p.key === currentProject}<Kbd class="ml-auto">G B</Kbd
                      >{/if}</Command.Item
                  >
                  {#if canWrite(p.myAccess)}
                    <Command.Item
                      class={item}
                      value={`${p.name} settings`}
                      keywords={[p.key, 'workflow', 'labels', 'fields']}
                      onSelect={() => run(() => navigate(`/p/${p.key}/settings`))}
                      >{p.name}: Settings{#if p.key === currentProject}<Kbd class="ml-auto">G S</Kbd
                        >{/if}</Command.Item
                    >
                  {/if}
                {/each}
                {#if isAdmin}
                  <Command.Item
                    class={item}
                    value="Webhooks"
                    keywords={['integrations']}
                    onSelect={() => run(() => navigate('/settings/webhooks'))}
                    >Webhooks</Command.Item
                  >
                {/if}
                <Command.Item
                  class={item}
                  value="Keyboard shortcuts"
                  keywords={['help', 'keys']}
                  onSelect={() => run(() => (ui.shortcutsOpen = true))}
                  >Keyboard shortcuts<Kbd class="ml-auto">?</Kbd></Command.Item
                >
              </Command.GroupItems>
            </Command.Group>

            <Command.Group>
              <Command.GroupHeading class={heading}>Preferences</Command.GroupHeading>
              <Command.GroupItems>
                <Command.Item
                  class={item}
                  value="Toggle dark mode"
                  keywords={['theme', 'light']}
                  onSelect={() =>
                    run(() =>
                      applyTheme(
                        document.documentElement.classList.contains('dark') ? 'light' : 'dark',
                      ),
                    )}>Toggle dark mode</Command.Item
                >
                {#if isSignedIn(me.data)}
                  <Command.Item
                    class={item}
                    value="Sign out"
                    keywords={['log out']}
                    onSelect={() => run(() => signOut(qc))}>Sign out</Command.Item
                  >
                {:else}
                  <Command.Item
                    class={item}
                    value="Sign in"
                    keywords={['log in']}
                    onSelect={() => run(() => navigate(signInPath()))}>Sign in</Command.Item
                  >
                {/if}
              </Command.GroupItems>
            </Command.Group>
          {:else if readOnly}
            <!-- Edit modes need write access (the effect above returns to the root). -->
          {:else if mode === 'status'}
            {#each project.statuses as s (s.id)}
              <Command.Item
                class={item}
                value={s.name}
                onSelect={() =>
                  run(() => bulkUpdate(qc, targetKeys(), { status: s.id }, `Status → ${s.name}`))}
              >
                <StatusIcon category={s.category} color={s.color} />{s.name}
                {#if targets.length && targets.every((t) => t.statusId === s.id)}<Check
                    size={14}
                    class="ml-auto text-accent"
                  />{/if}
              </Command.Item>
            {/each}
          {:else if mode === 'assignee'}
            <Command.Item
              class={item}
              value="Unassigned"
              keywords={['nobody', 'none']}
              onSelect={() =>
                run(() => bulkUpdate(qc, targetKeys(), { assignee: null }, 'Unassigned'))}
              >Unassigned</Command.Item
            >
            {#each project.users as u (u.id)}
              <Command.Item
                class={item}
                value={u.name}
                keywords={[u.handle]}
                onSelect={() =>
                  run(() =>
                    bulkUpdate(qc, targetKeys(), { assignee: u.id }, `Assigned to ${u.name}`),
                  )}
              >
                <Avatar user={u} size={18} />{u.name}<span class="text-fg-subtle">@{u.handle}</span>
                {#if targets.length && targets.every((t) => t.assigneeId === u.id)}<Check
                    size={14}
                    class="ml-auto text-accent"
                  />{/if}
              </Command.Item>
            {/each}
          {:else if mode === 'priority'}
            {#each PRIORITY_ORDER as p (p)}
              <Command.Item
                class={item}
                value={PRIORITY_LABELS[p]}
                onSelect={() =>
                  run(() =>
                    bulkUpdate(
                      qc,
                      targetKeys(),
                      { priority: p },
                      `Priority → ${PRIORITY_LABELS[p]}`,
                    ),
                  )}
              >
                <PriorityIcon priority={p} />{PRIORITY_LABELS[p]}<Kbd class="ml-auto">{p}</Kbd>
              </Command.Item>
            {/each}
          {:else if mode === 'labels'}
            {#each project.labels as l (l.id)}
              <Command.Item
                class={item}
                value={l.name}
                onSelect={() => run(() => toggleLabel(qc, targets, l.id, l.name))}
              >
                <span class="size-2.5 rounded-full" style:background={l.color}></span>{l.name}
                {#if allHaveLabel(l.id)}<Check size={14} class="ml-auto text-accent" />{/if}
              </Command.Item>
            {/each}
          {/if}
        </Command.List>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
