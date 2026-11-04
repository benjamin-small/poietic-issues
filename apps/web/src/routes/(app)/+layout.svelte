<script lang="ts">
  import { page } from '$app/state';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { connectLive } from '$lib/live.svelte.ts';
  import { ApiError } from '$lib/api.ts';
  import { canWrite, fetchers, isAdmin, isSignedIn, keys } from '$lib/queries.ts';
  import { openCommand, openCreateIssue, ui } from '$lib/ui.svelte.ts';
  import { PRIORITY_LABELS } from '$lib/format.ts';
  import { bulkUpdate, cachedIssues, deleteIssues } from '$lib/issues.ts';
  import { navigate, signInPath } from '$lib/nav.ts';
  import {
    attemptSso,
    keepSsoSession,
    markSilentSsoDone,
    silentSsoAllowed,
    ssoSessionHeld,
  } from '$lib/session.ts';
  import { clearSelection, moveFocus, selection, toggleSelected } from '$lib/selection.svelte.ts';
  import CommandMenu from '$components/CommandMenu.svelte';
  import ConfirmDialog from '$components/ConfirmDialog.svelte';
  import ShortcutsDialog from '$components/ShortcutsDialog.svelte';
  import LogIn from '@lucide/svelte/icons/log-in';
  import Menu from '@lucide/svelte/icons/menu';
  import Plus from '@lucide/svelte/icons/plus';
  import CreateIssueDialog from '$components/CreateIssueDialog.svelte';
  import CreateProjectDialog from '$components/CreateProjectDialog.svelte';
  import Sidebar from '$components/Sidebar.svelte';

  let { children } = $props();

  const me = createQuery(() => ({ queryKey: keys.me, queryFn: fetchers.me, staleTime: 300_000 }));
  const projects = createQuery(() => ({ queryKey: keys.projects, queryFn: fetchers.projects }));

  const qc = useQueryClient();

  // A signed-out visitor may still be signed in to the SSO issuer: make one silent attempt per browser session
  // (never after signing out), as the login page's automatic attempt does. The page waits for it, so a private
  // project doesn't flash "not found" before the visitor is signed in; if it fails they browse anonymously.
  let silentSso = $state<'pending' | 'running' | 'done'>(silentSsoAllowed() ? 'pending' : 'done');
  const anonymous = $derived(!!me.data && !isSignedIn(me.data));
  const signedIn = $derived(!!me.data && isSignedIn(me.data));
  const authConfig = createQuery(() => ({
    queryKey: keys.authConfig,
    queryFn: fetchers.authConfig,
    enabled: (anonymous && silentSso === 'pending') || signedIn,
  }));

  // An SSO session is short: renew it while the app is open, so it ends soon after the issuer's session does.
  const ssoConfig = $derived(authConfig.data?.sso);
  $effect(() => {
    if (!signedIn || !ssoConfig || !ssoSessionHeld()) return;
    return keepSsoSession(ssoConfig, {
      // The old session expired before the renewal: refetch what may have been read as anonymous.
      lapsed: () => void qc.invalidateQueries(),
      // The issuer ended the session: show the visitor as signed out.
      ended: () => void qc.invalidateQueries(),
    });
  });
  $effect(() => {
    if (!anonymous || silentSso !== 'pending') return;
    const { isError, data } = authConfig;
    if (!isError && !data) return;
    markSilentSsoDone();
    const sso = data?.sso;
    if (!sso) {
      silentSso = 'done';
      return;
    }
    silentSso = 'running';
    void attemptSso(sso)
      // Signed in: drop everything cached for the anonymous visitor and fetch it again as the user.
      .then((result) => (result.ok ? qc.resetQueries() : undefined))
      .catch(() => undefined)
      .finally(() => (silentSso = 'done'));
  });
  const waitingForSso = $derived(anonymous && silentSso !== 'done');

  /** Current project from the URL (`/p/ENG…` or `/i/ENG-42`), else the first project. */
  const currentProject = $derived(
    (page.params.key && /^[A-Za-z][A-Za-z0-9]*$/.test(page.params.key)
      ? page.params.key.toUpperCase()
      : undefined) ??
      page.params.issueKey?.split('-')[0]?.toUpperCase() ??
      projects.data?.[0]?.key ??
      '',
  );

  /** The caller's level on the current project: write shortcuts and create actions need `write`. */
  const access = $derived(projects.data?.find((p) => p.key === currentProject)?.myAccess);
  const writable = $derived(canWrite(access));

  /** Signed-out visitors browse public projects; signing in comes back to the same page. */
  function signIn() {
    void navigate(signInPath());
  }

  // Close the navigation drawer whenever the page changes.
  $effect(() => {
    void page.url.href;
    ui.sidebarOpen = false;
  });

  // One live event stream for every project the viewer can read, kept across navigation. Signed-out visitors
  // get one too: the server sends each viewer only what they may read.
  $effect(() => {
    if (!me.data || waitingForSso) return;
    return connectLive(qc);
  });

  /** What issue shortcuts act on: the selection, else the open issue, else the focused row or card. */
  function issueTargets(): string[] {
    if (selection.selected.length) return [...selection.selected];
    if (ui.openIssue) return [ui.openIssue];
    if (selection.focused) return [selection.focused];
    return [];
  }

  function reveal(key: string | null) {
    if (!key) return;
    document
      .querySelector(
        `[data-testid="issue-row"][data-key="${key}"], [data-testid="issue-card"][data-key="${key}"]`,
      )
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  let pendingG: ReturnType<typeof setTimeout> | undefined;
  const GO: Record<string, string> = { i: '', b: '/board', s: '/settings' };

  function onkeydown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (ui.command.open) ui.command.open = false;
      else openCommand('root', issueTargets());
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (
      target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') ||
      ui.command.open ||
      ui.createIssue.open ||
      ui.createProject ||
      ui.shortcutsOpen
    )
      return;

    if (mod && (event.key === 'Backspace' || event.key === 'Delete')) {
      if (!writable) return;
      const targets = cachedIssues(qc, issueTargets());
      if (targets.length) {
        event.preventDefault();
        void deleteIssues(qc, targets).then(clearSelection);
      }
      return;
    }
    if (mod || event.altKey) return;

    if (pendingG) {
      clearTimeout(pendingG);
      pendingG = undefined;
      const suffix = GO[event.key.toLowerCase()];
      if (suffix === '/settings' && !canWrite(access)) return;
      if (suffix !== undefined && currentProject) {
        event.preventDefault();
        void navigate(`/p/${currentProject}${suffix}`);
      }
      return;
    }

    const targets = issueTargets();
    switch (event.key) {
      case 'c':
        if (!currentProject || !writable) return;
        openCreateIssue(currentProject);
        break;
      case 'g':
        pendingG = setTimeout(() => (pendingG = undefined), 1000);
        break;
      case '?':
        ui.shortcutsOpen = true;
        break;
      case '/': {
        const search = document.querySelector<HTMLInputElement>('[data-testid="search"]');
        if (!search) return;
        search.focus();
        search.select();
        break;
      }
      case 'j':
      case 'ArrowDown':
        if (!selection.order.length) return;
        reveal(moveFocus(1));
        break;
      case 'k':
      case 'ArrowUp':
        if (!selection.order.length) return;
        reveal(moveFocus(-1));
        break;
      case 'Enter':
      case 'o':
        // Enter on a real control keeps its own meaning.
        if (!selection.focused || (event.key === 'Enter' && target.closest('button, a'))) return;
        (ui.opener ?? ((key: string) => navigate(`/i/${key}`)))(selection.focused);
        break;
      case 'x':
        if (!selection.focused) return;
        toggleSelected(selection.focused);
        break;
      case 'Escape':
        if (selection.selected.length) clearSelection();
        else if (page.state.peek) history.back();
        else if (selection.focused) selection.focused = null;
        else return;
        break;
      case 's':
      case 'a':
      case 'p':
      case 'l':
        if (!targets.length || !writable) return;
        openCommand(
          ({ s: 'status', a: 'assignee', p: 'priority', l: 'labels' } as const)[event.key],
          targets,
        );
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4': {
        if (!targets.length || !writable) return;
        const priority = Number(event.key);
        void bulkUpdate(qc, targets, { priority }, `Priority → ${PRIORITY_LABELS[priority]}`);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }
</script>

<svelte:window {onkeydown} />

{#if me.data && !waitingForSso}
  <div class="flex h-dvh overflow-hidden">
    <Sidebar me={me.data} projects={projects.data ?? []} {currentProject} onsignin={signIn} />
    {#if ui.sidebarOpen}
      <button
        class="fixed inset-0 z-30 bg-black/30 md:hidden"
        aria-label="Close menu"
        onclick={() => (ui.sidebarOpen = false)}
      ></button>
    {/if}
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Narrow screens: the sidebar becomes a drawer opened from this bar. -->
      <div class="flex items-center gap-2 border-b border-border px-2 py-1.5 md:hidden">
        <button
          class="rounded-md p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
          aria-label="Open menu"
          aria-expanded={ui.sidebarOpen}
          data-testid="open-menu"
          onclick={() => (ui.sidebarOpen = true)}><Menu size={18} /></button
        >
        <span class="truncate text-sm font-medium"
          >{projects.data?.find((p) => p.key === currentProject)?.name ?? 'Issues'}</span
        >
        {#if !isSignedIn(me.data)}
          <button
            class="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-fg-muted hover:bg-bg-hover hover:text-fg"
            onclick={signIn}><LogIn size={16} /> Sign in</button
          >
        {:else if currentProject && writable}
          <button
            class="ml-auto rounded-md p-1.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
            aria-label="New issue"
            onclick={() => openCreateIssue(currentProject)}><Plus size={18} /></button
          >
        {/if}
      </div>
      {@render children()}
    </main>
  </div>
  {#if ui.createIssue.open}<CreateIssueDialog />{/if}
  {#if ui.createProject && isAdmin(me.data)}<CreateProjectDialog />{/if}
  <CommandMenu {currentProject} />
  <ShortcutsDialog />
  <ConfirmDialog />
{:else if me.isError}
  <div class="p-8 text-sm text-fg-muted">
    {me.error instanceof ApiError && me.error.status === 401
      ? 'Redirecting to sign in…'
      : `Couldn’t load: ${me.error.message}`}
  </div>
{:else}
  <div class="p-8 text-sm text-fg-subtle">Loading…</div>
{/if}
