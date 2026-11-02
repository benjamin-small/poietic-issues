<script lang="ts">
  import { btn } from '../styles.ts';
  import { page } from '$app/state';
  import { current, href, navigate, pushPageState, signInPath } from '$lib/nav.ts';
  import { createQuery } from '@tanstack/svelte-query';
  import type { View } from '../api.ts';
  import { useProjectData } from '../project-data.svelte.ts';
  import { fetchers, keys } from '../queries.ts';
  import { openCreateIssue, ui } from '../ui.svelte.ts';
  import { clearSelection } from '../selection.svelte.ts';
  import SelectionBar from './SelectionBar.svelte';
  import {
    decodeConfig,
    defaultViewConfig,
    encodeConfig,
    migrateViewConfig,
    sameConfig,
    type ViewConfig,
  } from '../views.ts';
  import Board from './Board.svelte';
  import FilterBar from './FilterBar.svelte';
  import IssueDetail from './IssueDetail.svelte';
  import FolderX from '@lucide/svelte/icons/folder-x';
  import Inbox from '@lucide/svelte/icons/inbox';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import EmptyState from './EmptyState.svelte';
  import IssueList from './IssueList.svelte';
  import ViewConfigPanel from './ViewConfigPanel.svelte';
  import ViewMenu from './ViewMenu.svelte';
  import {
    clampPeekWidth,
    loadPeekWidth,
    maxPeekWidth,
    PEEK_DEFAULT,
    PEEK_GUTTER,
    PEEK_MIN,
    PEEK_STEP,
    savePeekWidth,
  } from '../peek-width.ts';

  /**
   * A project's issues through a view: the saved view's config, overridden by an unsaved `?v=` config in the URL
   * (shareable). Renders the list or the board, with the issue peek panel on the side.
   */
  let {
    projectKey,
    layout,
    viewId,
  }: { projectKey: string; layout: 'list' | 'board'; viewId?: string } = $props();

  const project = useProjectData(() => projectKey);
  const view = $derived<View | undefined>(
    viewId
      ? project.views.find((v) => v.id === viewId)
      : (project.views.find((v) => v.layout === layout && v.ownerId === null) ??
          project.views.find((v) => v.layout === layout)),
  );
  const saved = $derived<ViewConfig>(
    view ? migrateViewConfig(view.config) : defaultViewConfig(layout),
  );
  const config = $derived<ViewConfig>(decodeConfig(current().params.get('v')) ?? saved);
  const effectiveLayout = $derived(view?.layout ?? layout);
  const dirty = $derived(!sameConfig(config, saved));

  function setConfig(next: ViewConfig) {
    const { path, params } = current();
    if (sameConfig(next, saved)) params.delete('v');
    else params.set('v', encodeConfig(next));
    const query = params.toString();
    void navigate(query ? `${path}?${query}` : path, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }

  const listQuery = $derived({ filter: config.filter, sort: config.sort });
  const issues = createQuery(() => ({
    queryKey: keys.issueList(projectKey, listQuery),
    queryFn: () => fetchers.issues(projectKey, listQuery),
    enabled: project.loaded,
  }));

  const peek = $derived(page.state.peek);
  // Shortcuts and the command menu open issues the way this view does: in the peek panel.
  $effect(() => {
    ui.opener = open;
    return () => {
      if (ui.opener === open) ui.opener = null;
    };
  });
  // A new project or layout starts with nothing selected.
  $effect(() => {
    void projectKey;
    void effectiveLayout;
    clearSelection();
  });
  function open(key: string) {
    pushPageState({ peek: key });
  }
  function closePeek() {
    history.back();
  }

  // The peek panel's width (sm and up): dragged by its left border or moved with the arrow keys, remembered per browser.
  let peekWidth = $state(loadPeekWidth());
  let resizing = $state(false);
  let container: HTMLDivElement | undefined = $state();
  let aside: HTMLElement | undefined = $state();
  const peekMax = () => maxPeekWidth(container?.clientWidth ?? Infinity);
  function setPeekWidth(width: number, save = false) {
    peekWidth = clampPeekWidth(width, peekMax());
    if (save) savePeekWidth(peekWidth);
  }
  function startResize(e: PointerEvent) {
    if (e.button !== 0 || !aside) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    // Relative to where the drag began, so grabbing anywhere on the handle doesn't make the panel jump.
    const startWidth = aside.getBoundingClientRect().width;
    const startX = e.clientX;
    resizing = true;
    const move = (ev: PointerEvent) => setPeekWidth(startWidth + startX - ev.clientX);
    const end = () => {
      resizing = false;
      savePeekWidth(peekWidth);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  function resizeByKey(e: KeyboardEvent) {
    const next =
      e.key === 'ArrowLeft'
        ? peekWidth + PEEK_STEP
        : e.key === 'ArrowRight'
          ? peekWidth - PEEK_STEP
          : e.key === 'Home'
            ? PEEK_MIN
            : e.key === 'End'
              ? peekMax()
              : null;
    if (next === null) return;
    e.preventDefault();
    setPeekWidth(next, true);
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- A missing or failed project has no view to configure: only its message shows. -->
  {#if !project.notFound && !project.error}
    <header
      class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2 sm:px-4"
    >
      <div class="flex items-center">
        <ViewMenu {project} {view} {config} layout={effectiveLayout} {dirty} />
        {#if dirty}<span class="ml-1 text-xs text-fg-subtle" data-testid="view-modified"
            >· modified</span
          >{/if}
      </div>
      <!-- Narrow screens: filters get their own scrolling row under the view name. -->
      <div
        class="order-last -mx-3 w-[calc(100%+1.5rem)] overflow-x-auto px-3 sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0"
      >
        <FilterBar
          filter={config.filter}
          {project}
          issues={issues.data}
          onchange={(filter) => setConfig({ ...config, filter })}
        />
      </div>
      <div class="ml-auto flex items-center gap-2">
        {#if dirty}
          <button
            class="text-xs text-fg-subtle hover:text-fg"
            onclick={() => setConfig(saved)}
            data-testid="view-reset">Reset</button
          >
        {/if}
        <span class="text-xs text-fg-subtle" data-testid="issue-count"
          >{issues.data?.length ?? '…'} issues</span
        >
        <ViewConfigPanel {config} layout={effectiveLayout} {project} onchange={setConfig} />
      </div>
    </header>
  {/if}

  <div class="relative flex min-h-0 flex-1" class:select-none={resizing} bind:this={container}>
    {#if project.notFound}
      <EmptyState icon={FolderX} title="Project {projectKey} not found" testid="project-not-found">
        {project.signedIn
          ? 'It may not exist, or it may be private to its members.'
          : 'It may not exist, or it may be private. Sign in to see the projects you belong to.'}
        {#snippet actions()}
          {#if !project.signedIn}
            <button class={btn.primary} onclick={() => navigate(signInPath())}>Sign in</button>
          {:else}
            <a href={href('/')} class={btn.secondary}>Go to your projects</a>
          {/if}
        {/snippet}
      </EmptyState>
    {:else if project.error}
      <EmptyState
        icon={TriangleAlert}
        tone="danger"
        title="Couldn’t load {projectKey}"
        testid="project-error"
      >
        {project.error.message}
        {#snippet actions()}
          <button class={btn.secondary} onclick={() => project.retry()}>Try again</button>
        {/snippet}
      </EmptyState>
    {:else if issues.isError}
      <EmptyState icon={TriangleAlert} tone="danger" title="Couldn’t load issues">
        {issues.error.message}
        {#snippet actions()}
          <button class={btn.secondary} onclick={() => issues.refetch()}>Try again</button>
        {/snippet}
      </EmptyState>
    {:else if !issues.data}
      <div class="flex-1 space-y-px" aria-busy="true" aria-label="Loading issues">
        {#each [70, 55, 80, 45, 65, 50] as width, i (i)}
          <div class="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <div class="h-3 w-12 animate-pulse rounded bg-bg-muted"></div>
            <div class="h-3 animate-pulse rounded bg-bg-muted" style:width="{width}%"></div>
          </div>
        {/each}
      </div>
    {:else}
      {#if effectiveLayout === 'board'}
        <Board issues={issues.data} {config} {project} onopen={open} active={peek} />
      {:else if issues.data.length === 0}
        <EmptyState
          icon={Inbox}
          title={config.filter.conditions.length
            ? 'No issues match these filters'
            : 'No issues yet'}
          testid="empty-list"
        >
          {#if !project.canWrite}
            {config.filter.conditions.length ? 'Try removing a filter.' : 'Nothing here yet.'}
          {:else}
            {config.filter.conditions.length
              ? 'Try removing a filter, or create an issue that fits.'
              : 'Create the first issue for this project.'}
          {/if}
          {#snippet actions()}
            {#if dirty}
              <button class={btn.secondary} onclick={() => setConfig(saved)}>Reset view</button>
            {/if}
            {#if project.canWrite}
              <button class={btn.primary} onclick={() => openCreateIssue(projectKey)}
                >New issue</button
              >
            {/if}
          {/snippet}
        </EmptyState>
      {:else}
        <IssueList issues={issues.data} {config} {project} onopen={open} active={peek} />
      {/if}
    {/if}

    {#if project.canWrite}<SelectionBar />{/if}

    {#if peek}
      <aside
        class="absolute inset-y-0 right-0 z-20 w-full border-border bg-bg shadow-xl sm:w-(--peek-width) sm:border-l"
        style:--peek-width="min({peekWidth}px, max({PEEK_MIN}px, 100% - {PEEK_GUTTER}px), 100%)"
        data-testid="peek-panel"
        bind:this={aside}
      >
        <!-- A focusable separator is the ARIA window-splitter pattern, which Svelte's a11y rules don't know. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize issue panel"
          aria-valuenow={peekWidth}
          aria-valuemin={PEEK_MIN}
          aria-valuemax={peekMax()}
          tabindex="0"
          title="Drag to resize; double-click to reset"
          class="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent data-[resizing]:after:bg-accent sm:block"
          data-resizing={resizing || undefined}
          data-testid="peek-resize"
          onpointerdown={startResize}
          onkeydown={resizeByKey}
          ondblclick={() => setPeekWidth(PEEK_DEFAULT, true)}
        ></div>
        {#key peek}
          <IssueDetail issueKey={peek} onopen={open} onclose={closePeek} panel />
        {/key}
      </aside>
    {/if}
  </div>
</div>
