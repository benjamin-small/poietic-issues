<script lang="ts">
  import { useQueryClient } from '@tanstack/svelte-query';
  import type { CustomField, Issue, User } from '../api.ts';
  import { findPerson, unknownUserLabel } from '../format.ts';
  import { editIssue } from '../issues.ts';
  import Avatar from './Avatar.svelte';
  import DateInput from './DateInput.svelte';
  import Picker from './Picker.svelte';

  /** Inline editor for one custom field on an issue (optimistic, like the core properties). */
  let { issue, field, users }: { issue: Issue; field: CustomField; users: User[] } = $props();
  const qc = useQueryClient();
  const value = $derived(issue.customFields[field.key]);
  const activeOptions = $derived(field.options.filter((o) => !o.archivedAt));
  const NONE = '__none__';

  function set(next: string | number | boolean | string[] | null) {
    const same = JSON.stringify(next ?? null) === JSON.stringify(value ?? null);
    if (same) return;
    const customFields = { ...issue.customFields };
    if (next === null || (Array.isArray(next) && next.length === 0)) delete customFields[field.key];
    else customFields[field.key] = next;
    void editIssue(qc, issue, { customFields: { [field.key]: next } }, { customFields });
  }

  const setLabel = $derived(`Set ${field.name.toLowerCase()}`);
  const inline =
    'w-full rounded bg-transparent px-1.5 py-1 text-sm placeholder:text-fg-subtle hover:bg-bg-hover focus:bg-bg-hover focus:outline-none';
  const optionOf = (v: unknown) => field.options.find((o) => o.value === v);
</script>

{#if field.type === 'select'}
  <Picker
    items={[
      { value: NONE, label: 'None', color: 'transparent' },
      ...activeOptions.map((o) => ({ value: o.value, label: o.label, color: o.color })),
    ]}
    selected={[typeof value === 'string' ? value : NONE]}
    onselect={(v) => set(v === NONE ? null : v)}
    triggerLabel={field.name}
    testid="cf-{field.key}"
  >
    {#snippet trigger()}
      {#if typeof value === 'string'}
        <span class="size-2.5 rounded-full" style:background={optionOf(value)?.color}
        ></span>{optionOf(value)?.label ?? value}
      {:else}<span class="text-fg-subtle">{setLabel}</span>{/if}
    {/snippet}
    {#snippet item(it)}<span
        class="size-2.5 rounded-full border border-border"
        style:background={it.color}
      ></span>{it.label}{/snippet}
  </Picker>
{:else if field.type === 'multi_select'}
  {@const current = Array.isArray(value) ? value : []}
  <Picker
    items={activeOptions.map((o) => ({ value: o.value, label: o.label, color: o.color }))}
    selected={current}
    multiple
    onselect={(v) => set(current.includes(v) ? current.filter((x) => x !== v) : [...current, v])}
    triggerLabel={field.name}
    testid="cf-{field.key}"
  >
    {#snippet trigger()}
      {#if current.length}{current.map((v) => optionOf(v)?.label ?? v).join(', ')}{:else}<span
          class="text-fg-subtle">{setLabel}</span
        >{/if}
    {/snippet}
    {#snippet item(it)}<span class="size-2.5 rounded-full" style:background={it.color}
      ></span>{it.label}{/snippet}
  </Picker>
{:else if field.type === 'user'}
  {@const u = findPerson(value, users, [issue.assignee, issue.creator]) ?? null}
  <Picker
    items={[
      { value: NONE, label: 'None', u: null },
      ...users.map((x) => ({ value: x.id, label: x.name, keywords: [x.handle], u: x })),
    ]}
    selected={[typeof value === 'string' ? value : NONE]}
    onselect={(v) => set(v === NONE ? null : v)}
    triggerLabel={field.name}
    testid="cf-{field.key}"
  >
    {#snippet trigger()}<Avatar
        user={u}
        size={16}
      />{#if u}{u.name}{:else if typeof value === 'string'}<span title={value}
          >{unknownUserLabel(value)}</span
        >{:else}<span class="text-fg-subtle">{setLabel}</span>{/if}{/snippet}
    {#snippet item(it)}<Avatar user={it.u} size={16} />{it.label}{/snippet}
  </Picker>
{:else if field.type === 'boolean'}
  <label class="flex items-center gap-2 px-1.5 py-1">
    <input
      type="checkbox"
      checked={value === true}
      onchange={(e) => set(e.currentTarget.checked)}
      data-testid="cf-{field.key}"
    />
  </label>
{:else if field.type === 'number'}
  <input
    type="number"
    class={inline}
    value={typeof value === 'number' ? value : ''}
    placeholder={setLabel}
    aria-label={field.name}
    data-testid="cf-{field.key}"
    onchange={(e) => set(e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
  />
{:else if field.type === 'date'}
  <DateInput
    value={typeof value === 'string' ? value : null}
    label={field.name}
    placeholder={setLabel}
    testid="cf-{field.key}"
    onchange={set}
  />
{:else}
  <input
    type={field.type === 'url' ? 'url' : 'text'}
    class={inline}
    value={typeof value === 'string' ? value : ''}
    placeholder={field.type === 'url' ? 'https://…' : setLabel}
    aria-label={field.name}
    data-testid="cf-{field.key}"
    onchange={(e) => set(e.currentTarget.value.trim() || null)}
  />
{/if}
