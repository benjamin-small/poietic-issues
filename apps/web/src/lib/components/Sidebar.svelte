<script lang="ts">
  import { asset } from '$app/paths';
  import { useQueryClient } from '@tanstack/svelte-query';
  import KanbanSquare from '@lucide/svelte/icons/square-kanban';
  import List from '@lucide/svelte/icons/list';
  import LogIn from '@lucide/svelte/icons/log-in';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Moon from '@lucide/svelte/icons/moon';
  import Plus from '@lucide/svelte/icons/plus';
  import Settings from '@lucide/svelte/icons/settings';
  import Sun from '@lucide/svelte/icons/sun';
  import { MediaQuery } from 'svelte/reactivity';
  import Webhook from '@lucide/svelte/icons/webhook';
  import type { Project } from '../api.ts';
  import { live } from '../live.svelte.ts';
  import { current, href } from '../nav.ts';
  import { canWrite, isAdmin as isAdminMe, isSignedIn, type Me } from '../queries.ts';
  import { signOut } from '../session.ts';
  import { applyTheme } from '../theme.ts';
  import { openCreateIssue, ui } from '../ui.svelte.ts';
  import Avatar from './Avatar.svelte';

  let {
    me,
    projects,
    currentProject,
    onsignin,
  }: { me: Me; projects: Project[]; currentProject: string; onsignin: () => void } = $props();
  const qc = useQueryClient();
  let dark = $state(document.documentElement.classList.contains('dark'));

  function toggleTheme() {
    dark = !dark;
    applyTheme(dark ? 'dark' : 'light');
  }

  const logout = () => signOut(qc);

  const path = $derived(current().path);
  const wide = new MediaQuery('min-width: 768px');
  const isAdmin = $derived(isAdminMe(me));
  const access = $derived(projects.find((p) => p.key === currentProject)?.myAccess);
  const link = (active: boolean) =>
    `flex items-center gap-2 rounded-md px-2 py-1 text-sm ${active ? 'bg-bg-hover text-fg font-medium' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'}`;
</script>

<nav
  class="flex w-64 shrink-0 flex-col border-r border-border bg-bg-subtle max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-xl max-md:transition-transform md:w-56 {ui.sidebarOpen
    ? ''
    : 'max-md:-translate-x-full'}"
  aria-label="Main"
  inert={!wide.current && !ui.sidebarOpen}
>
  <div class="flex items-center gap-2 px-3 py-3">
    <img src={asset('/favicon.svg')} alt="" class="size-5" />
    <span class="font-semibold">Issues</span>
    <span
      class="ml-auto inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] {live.connected
        ? 'text-fg-subtle'
        : 'bg-bg-muted text-fg-muted'}"
      title={live.connected
        ? 'Changes by others appear as they happen'
        : 'Reconnecting… changes by others appear when you reload'}
      role="status"
      data-testid="live-indicator"
      data-connected={live.connected}
    >
      <span
        class="size-1.5 rounded-full {live.connected
          ? 'bg-success'
          : 'animate-pulse bg-border-strong'}"
      ></span>
      {live.connected ? 'Live' : 'Offline'}
    </span>
  </div>
  {#if canWrite(access)}
    <div class="px-2 pb-2">
      <button
        class="flex w-full items-center gap-2 rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg-muted shadow-xs hover:text-fg disabled:opacity-50"
        disabled={!currentProject}
        onclick={() => openCreateIssue(currentProject)}
        data-testid="new-issue"
      >
        <Plus size={15} /> New issue
        <kbd class="ml-auto rounded border border-border px-1 font-mono text-[10px] text-fg-subtle"
          >C</kbd
        >
      </button>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto px-2">
    <div class="flex items-center px-2 pt-2 pb-1">
      <p class="text-xs font-medium text-fg-subtle">Projects</p>
      {#if isAdmin}
        <button
          class="ml-auto rounded p-0.5 text-fg-subtle hover:bg-bg-hover hover:text-fg"
          aria-label="New project"
          title="New project"
          data-testid="new-project"
          onclick={() => (ui.createProject = true)}><Plus size={14} /></button
        >
      {/if}
    </div>
    {#each projects as p (p.id)}
      <div class="mb-1">
        <a href={href(`/p/${p.key}`)} class={link(false)} class:!text-fg={p.key === currentProject}>
          <span
            class="inline-flex size-5 items-center justify-center rounded bg-bg-muted font-mono text-[10px] font-semibold"
            >{p.key.slice(0, 3)}</span
          >
          <span class="truncate">{p.name}</span>
        </a>
        {#if p.key === currentProject}
          <div class="ml-4 border-l border-border pl-2">
            <a href={href(`/p/${p.key}`)} class={link(path === `/p/${p.key}`)}
              ><List size={14} /> Issues</a
            >
            <a
              href={href(`/p/${p.key}/board`)}
              class={link(path === `/p/${p.key}/board`)}
              data-testid="nav-board"><KanbanSquare size={14} /> Board</a
            >
            {#if canWrite(p.myAccess)}
              <a
                href={href(`/p/${p.key}/settings`)}
                class={link(path.startsWith(`/p/${p.key}/settings`))}
                ><Settings size={14} /> Settings</a
              >
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <p class="px-2 text-xs text-fg-subtle">
        {isSignedIn(me) ? 'No projects yet.' : 'No public projects.'}
      </p>
    {/each}
    {#if isAdmin}
      <p class="px-2 pt-4 pb-1 text-xs font-medium text-fg-subtle">Workspace</p>
      <a
        href={href('/settings/webhooks')}
        class={link(path.startsWith('/settings/webhooks'))}
        data-testid="nav-webhooks"><Webhook size={14} /> Webhooks</a
      >
    {/if}
  </div>

  <div class="flex items-center gap-2 border-t border-border px-3 py-2">
    {#if isSignedIn(me)}
      <Avatar user={me} size={22} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">{me.name}</div>
        <div class="truncate text-xs text-fg-subtle">@{me.handle}</div>
      </div>
    {:else}
      <button
        class="flex flex-1 items-center gap-2 rounded-md px-1 py-1 text-sm font-medium text-fg-muted hover:bg-bg-hover hover:text-fg"
        onclick={onsignin}
        data-testid="sign-in"><LogIn size={15} /> Sign in</button
      >
    {/if}
    <button
      class="rounded p-1 text-fg-subtle hover:bg-bg-hover hover:text-fg"
      onclick={toggleTheme}
      aria-label="Toggle theme"
    >
      {#if dark}<Sun size={15} />{:else}<Moon size={15} />{/if}
    </button>
    {#if isSignedIn(me)}
      <button
        class="rounded p-1 text-fg-subtle hover:bg-bg-hover hover:text-fg"
        onclick={logout}
        aria-label="Sign out"
        data-testid="logout"
      >
        <LogOut size={15} />
      </button>
    {/if}
  </div>
</nav>
