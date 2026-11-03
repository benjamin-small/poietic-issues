<script lang="ts">
  import { agentNote } from '@poietic-tech/issues-schema';
  import { btn, input } from '../styles.ts';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import {
    api,
    call,
    errorMessage,
    type Project,
    type ProjectMember,
    type ProjectRole,
  } from '../api.ts';
  import { fetchers, isSignedIn, keys } from '../queries.ts';
  import { confirmAction } from '../confirm.svelte.ts';
  import { toast } from '../toast.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Select from './Select.svelte';

  /**
   * Who can see a project and who can work in it: visibility, plus the members and their roles.
   * Managers edit; other readers get the same lists read-only.
   */
  let { projectKey, readonly = false }: { projectKey: string; readonly?: boolean } = $props();
  const qc = useQueryClient();

  const me = createQuery(() => ({ queryKey: keys.me, queryFn: fetchers.me, staleTime: 300_000 }));
  const project = createQuery(() => ({
    queryKey: keys.project(projectKey),
    queryFn: () => fetchers.project(projectKey),
  }));
  const members = createQuery(() => ({
    queryKey: keys.members(projectKey),
    queryFn: () => fetchers.members(projectKey),
  }));
  const myId = $derived(isSignedIn(me.data) ? me.data.id : undefined);

  const VISIBILITY: { value: Project['visibility']; label: string; text: string }[] = [
    {
      value: 'private',
      label: 'Private',
      text: 'Only members, holders of a group grant, and admins can see it.',
    },
    {
      value: 'public',
      label: 'Public',
      text: 'Anyone with the link can read it, even signed out. Only members can change it.',
    },
  ];
  const ROLES: { value: ProjectRole; label: string; hint: string }[] = [
    { value: 'viewer', label: 'Viewer', hint: 'can read' },
    { value: 'editor', label: 'Editor', hint: 'can edit issues' },
    { value: 'manager', label: 'Manager', hint: 'can manage settings and members' },
  ];
  const roleLabel = (role: ProjectRole) => ROLES.find((r) => r.value === role)?.label ?? role;

  /** What the radios show while a change is being saved. */
  let pendingVisibility = $state<Project['visibility']>();
  const visibility = $derived(pendingVisibility ?? project.data?.visibility);

  /** Runs a change, then refreshes everything that depends on it (the caller's own access included). */
  async function run<T>(action: Promise<T>, saved?: string): Promise<T | undefined> {
    try {
      const result = await action;
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.members(projectKey) }),
        qc.invalidateQueries({ queryKey: keys.project(projectKey) }),
        qc.invalidateQueries({ queryKey: keys.projects }),
      ]);
      if (saved) toast(saved, 'success');
      return result;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return undefined;
    }
  }

  async function setVisibility(value: Project['visibility']) {
    if (value === project.data?.visibility) return;
    pendingVisibility = value;
    await run(
      call(
        api.PATCH('/projects/{project}', {
          params: { path: { project: projectKey } },
          body: { visibility: value },
        }),
      ),
      'Saved',
    );
    pendingVisibility = undefined;
  }

  async function setRole(m: ProjectMember, role: ProjectRole) {
    // Only a demotion from manager can take away the caller's own access to these settings.
    if (m.user.id === myId && m.role === 'manager' && role !== 'manager') {
      const ok = await confirmAction({
        title: 'Change your own role?',
        body: `You become ${roleLabel(role).toLowerCase()} and may no longer be able to change these settings.`,
        confirmLabel: 'Change role',
        danger: true,
      });
      if (!ok) return;
    }
    await run(
      call(
        api.PATCH('/projects/{project}/members/{user}', {
          params: { path: { project: projectKey, user: m.user.id } },
          body: { role },
        }),
      ),
      `@${m.user.handle} is now ${roleLabel(role).toLowerCase()}`,
    );
  }

  async function remove(m: ProjectMember) {
    const self = m.user.id === myId;
    const ok = await confirmAction({
      title: self ? 'Remove yourself from this project?' : `Remove @${m.user.handle}?`,
      body: self
        ? 'You lose the access this membership gave you, and may not be able to add yourself back.'
        : 'They lose the access this membership gave them.',
      confirmLabel: 'Remove member',
      danger: true,
    });
    if (!ok) return;
    await run(
      call(
        api.DELETE('/projects/{project}/members/{user}', {
          params: { path: { project: projectKey, user: m.user.id } },
        }),
      ),
      `Removed @${m.user.handle}`,
    );
  }

  let newHandle = $state('');
  let newRole = $state<ProjectRole>('editor');
  async function add(event: SubmitEvent) {
    event.preventDefault();
    const user = newHandle.trim();
    if (!user) return;
    const added = await run(
      call(
        api.POST('/projects/{project}/members', {
          params: { path: { project: projectKey } },
          body: { user, role: newRole },
        }),
      ),
      `Added ${user.startsWith('@') ? user : `@${user}`}`,
    );
    if (added) newHandle = '';
  }
</script>

<section data-testid="settings-access">
  <h2 class="mb-1 font-medium">Access</h2>
  <p class="mb-3 text-sm text-fg-muted">Who can see this project, and who can work in it.</p>

  {#if project.data}
    {#if readonly}
      <p class="text-sm" data-testid="visibility-readonly">
        <span class="font-medium"
          >{VISIBILITY.find((v) => v.value === project.data?.visibility)?.label}.</span
        >
        <span class="text-fg-muted"
          >{VISIBILITY.find((v) => v.value === project.data?.visibility)?.text}</span
        >
      </p>
    {:else}
      <fieldset class="space-y-2">
        <legend class="sr-only">Visibility</legend>
        {#each VISIBILITY as v (v.value)}
          <label class="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="radio"
              name="visibility"
              class="mt-0.5 accent-accent"
              value={v.value}
              checked={visibility === v.value}
              disabled={pendingVisibility !== undefined}
              onchange={() => setVisibility(v.value)}
            />
            <span>
              <span class="font-medium">{v.label}</span>
              <span class="block text-fg-muted">{v.text}</span>
            </span>
          </label>
        {/each}
      </fieldset>
    {/if}
  {/if}

  <h3 class="mt-6 mb-2 text-sm font-medium">Members</h3>
  <ul class="divide-y divide-border rounded-lg border border-border" data-testid="member-list">
    {#each members.data ?? [] as m (m.user.id)}
      <li class="flex items-center gap-3 px-3 py-2" data-member={m.user.handle}>
        <Avatar user={m.user} size={22} />
        <span class="min-w-0 flex-1 truncate text-sm">
          <span class="text-fg-muted">@{m.user.handle}</span>
          {#if m.user.name !== m.user.handle}<span class="ml-1.5 text-fg-subtle">{m.user.name}</span
            >{/if}
          {#if agentNote(m.user)}<span
              class="ml-1.5 rounded bg-bg-muted px-1 text-xs text-fg-subtle"
              >{agentNote(m.user)}</span
            >{/if}
        </span>
        {#if readonly}
          <span class="text-sm text-fg-muted">{roleLabel(m.role)}</span>
        {:else}
          <Select
            class="w-32"
            size="sm"
            label="Role of @{m.user.handle}"
            value={m.role}
            items={ROLES}
            onchange={(v) => setRole(m, v as ProjectRole)}
          />
          <button
            class="rounded p-1 text-fg-subtle hover:bg-bg-hover hover:text-danger"
            aria-label="Remove @{m.user.handle}"
            title="Remove member"
            onclick={() => remove(m)}><Trash2 size={14} /></button
          >
        {/if}
      </li>
    {:else}
      <li class="px-3 py-3 text-sm text-fg-subtle">
        {members.isSuccess ? 'No members yet. Admins can always manage this project.' : 'Loading…'}
      </li>
    {/each}
  </ul>

  {#if !readonly}
    <form class="mt-3 flex gap-2" onsubmit={add}>
      <input
        class="{input} min-w-0 flex-1"
        placeholder="@handle"
        aria-label="User to add"
        bind:value={newHandle}
      />
      <Select
        class="w-32"
        label="Role of new member"
        value={newRole}
        items={ROLES}
        onchange={(v) => (newRole = v as ProjectRole)}
      />
      <button class={btn.primary} disabled={!newHandle.trim()}>Add member</button>
    </form>
  {/if}
</section>
