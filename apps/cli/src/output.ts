import { formatActor, type Issue, readField, type UserSummary } from '@poietic-tech/issues-schema';
import type { OutputFormat } from './config.ts';
import type { CliIO } from './io.ts';

export type Kind =
  | 'issue'
  | 'comment'
  | 'link'
  | 'attachment'
  | 'webhook'
  | 'webhookDelivery'
  | 'linkType'
  | 'project'
  | 'member'
  | 'repo'
  | 'status'
  | 'label'
  | 'view'
  | 'user'
  | 'event'
  | 'field'
  | 'raw';

export type Row = Record<string, unknown>;
/** A table column; `multiline` asks a host that supports it to keep a long text's line breaks in a detail view. */
export type Column = [header: string, get: (row: Row) => unknown, opts?: { multiline?: boolean }];

const PRIORITY = ['—', 'Urgent', 'High', 'Medium', 'Low'];

const handle = (u: unknown) =>
  (u as { handle?: string } | null)?.handle ? `@${(u as { handle: string }).handle}` : '—';
/** An actor by handle, marked when it is an agent: `@opal-bot · agent · owned by @opal`. */
const actor = (u: unknown) =>
  (u as UserSummary | null)?.handle ? formatActor(u as UserSummary, { label: 'handle' }) : '—';
const date = (v: unknown) => (typeof v === 'string' ? v.slice(0, 10) : '—');
const names = (v: unknown) =>
  ((v as Array<{ name: string }> | undefined) ?? []).map((l) => l.name).join(', ') || '—';

/** The table columns of each kind of resource. */
export const COLUMNS: Record<Exclude<Kind, 'raw'>, Column[]> = {
  issue: [
    ['KEY', (r) => r.key],
    ['STATUS', (r) => (r.status as { name: string }).name],
    ['PRI', (r) => PRIORITY[r.priority as number]],
    ['ASSIGNEE', (r) => actor(r.assignee)],
    ['LABELS', (r) => names(r.labels)],
    ['TITLE', (r) => r.title],
  ],
  comment: [
    ['ID', (r) => r.id],
    ['AUTHOR', (r) => actor(r.author)],
    ['CREATED', (r) => date(r.createdAt)],
    ['BODY', (r) => String(r.body).replace(/\s+/g, ' ')],
  ],
  link: [
    ['ID', (r) => r.id],
    ['RELATION', (r) => r.label],
    ['ISSUE', (r) => (r.issue as { key: string }).key],
    ['STATUS', (r) => (r.issue as { status: { name: string } }).status.name],
    ['TITLE', (r) => (r.issue as { title: string }).title],
  ],
  attachment: [
    ['ID', (r) => r.id],
    ['FILENAME', (r) => r.filename],
    ['TYPE', (r) => r.contentType],
    ['SIZE', (r) => r.size],
    ['UPLOADER', (r) => actor(r.uploader)],
    ['CREATED', (r) => date(r.createdAt)],
  ],
  webhook: [
    ['ID', (r) => r.id],
    ['URL', (r) => r.url],
    ['EVENTS', (r) => (r.eventTypes as string[]).join(',')],
    ['ACTIVE', (r) => (r.active ? 'yes' : r.disabledAt ? 'disabled (failures)' : 'no')],
    ['PAYLOAD', (r) => r.payload],
    ['DESCRIPTION', (r) => r.description],
  ],
  webhookDelivery: [
    ['ID', (r) => r.id],
    ['SEQ', (r) => r.eventSeq],
    ['EVENT', (r) => r.eventType],
    ['STATUS', (r) => r.status],
    ['ATTEMPTS', (r) => r.attempts],
    ['HTTP', (r) => r.lastStatusCode ?? '—'],
    ['ERROR', (r) => r.lastError ?? ''],
  ],
  linkType: [
    ['KEY', (r) => r.key],
    ['OUTWARD', (r) => r.outwardLabel],
    ['INWARD', (r) => r.inwardLabel],
    ['SYMMETRIC', (r) => (r.symmetric ? 'yes' : 'no')],
  ],
  project: [
    ['KEY', (r) => r.key],
    ['NAME', (r) => r.name],
    ['VISIBILITY', (r) => r.visibility],
    ['ARCHIVED', (r) => (r.archivedAt ? date(r.archivedAt) : '')],
    ['ID', (r) => r.id],
  ],
  member: [
    ['USER', (r) => actor(r.user)],
    ['ROLE', (r) => r.role],
    ['SINCE', (r) => date(r.createdAt)],
  ],
  repo: [
    ['ID', (r) => r.id],
    ['REPO', (r) => r.fullName],
    ['URL', (r) => r.url],
  ],
  status: [
    ['POS', (r) => r.position],
    ['NAME', (r) => r.name],
    ['CATEGORY', (r) => r.category],
    ['COLOR', (r) => r.color],
    ['ID', (r) => r.id],
  ],
  label: [
    ['NAME', (r) => r.name],
    ['COLOR', (r) => r.color],
    ['DESCRIPTION', (r) => r.description],
    ['ID', (r) => r.id],
  ],
  view: [
    ['NAME', (r) => r.name],
    ['LAYOUT', (r) => r.layout],
    ['SHARED', (r) => (r.ownerId ? 'personal' : 'shared')],
    ['ID', (r) => r.id],
  ],
  user: [
    ['HANDLE', (r) => `@${String(r.handle)}`],
    ['NAME', (r) => r.name],
    ['KIND', (r) => r.kind],
    ['OWNER', (r) => handle(r.owner)],
    ['ROLE', (r) => r.role],
    ['ID', (r) => r.id],
  ],
  event: [
    ['SEQ', (r) => r.seq],
    ['TYPE', (r) => r.type],
    ['ACTOR', (r) => actor(r.actor)],
    ['SUBJECT', (r) => eventSubject(r)],
    ['REASON', (r) => (r.data as { reason?: string }).reason ?? ''],
    ['AT', (r) => String(r.createdAt).replace('T', ' ').slice(0, 19)],
  ],
  field: [
    ['KEY', (r) => r.key],
    ['NAME', (r) => r.name],
    ['TYPE', (r) => r.type],
    [
      'OPTIONS',
      (r) =>
        ((r.options as Array<{ value: string; archivedAt: string | null }> | undefined) ?? [])
          .map((o) => `${o.value}${o.archivedAt ? ' (archived)' : ''}`)
          .join(', '),
    ],
    ['ARCHIVED', (r) => (r.archivedAt ? date(r.archivedAt) : '')],
  ],
};

function eventSubject(e: Row): string {
  const data = e.data as Record<
    string,
    {
      key?: string;
      name?: string;
      handle?: string;
      source?: { key: string };
      target?: { key: string };
    }
  >;
  if (data.issue?.key) return data.issue.key;
  if (data.link) return `${data.link.source?.key} → ${data.link.target?.key}`;
  return data.project?.key ?? data.status?.name ?? data.label?.name ?? data.user?.handle ?? '';
}

/** What a row stands for in the ids format: an issue's key, an event's seq, a member's handle, else its id. */
export function identifier(kind: Kind, row: Row): string {
  if (kind === 'issue' || kind === 'project' || kind === 'linkType' || kind === 'field')
    return String(row.key ?? row.id);
  if (kind === 'event') return String(row.seq);
  if (kind === 'member') return String((row.user as { handle: string }).handle);
  return String(row.id ?? '');
}

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Row)[k] : undefined), obj);
}

/** Projects a row onto `--fields`. Issue fields use the field registry (e.g. `status` → status id). */
export function project(kind: Kind, row: Row, fields: string[] | undefined): Row {
  if (!fields?.length) return row;
  const out: Row = {};
  for (const f of fields) {
    out[f] =
      kind === 'issue' && !f.includes('.') && !(f in row)
        ? readField(row as unknown as Issue, f)
        : getPath(row, f);
  }
  return out;
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderTable(headers: string[], rows: string[][], maxWidth: number | undefined): string {
  if (rows.length === 0) return '';
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  if (maxWidth) {
    // Shrink the last column to fit the terminal.
    const fixed = widths.slice(0, -1).reduce((a, w) => a + w + 2, 0);
    widths[widths.length - 1] = Math.max(10, Math.min(widths.at(-1)!, maxWidth - fixed));
  }
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => {
        const w = widths[i]!;
        const text = c.length > w ? `${c.slice(0, w - 1)}…` : c;
        return i === cells.length - 1 ? text : text.padEnd(w);
      })
      .join('  ');
  return `${[fmt(headers), ...rows.map(fmt)].join('\n')}\n`;
}

/**
 * Renders command results in the requested format. JSON output is exactly the API resource shape
 * (projected by `--fields` when given); lists are `{ data, nextCursor }` or one object per line (ndjson).
 */
export class Output {
  readonly #io: CliIO;
  readonly format: OutputFormat;
  readonly #fields: string[] | undefined;

  constructor(io: CliIO, format: OutputFormat, fields: string[] | undefined) {
    this.#io = io;
    this.format = format;
    this.#fields = fields;
  }

  private write(text: string) {
    this.#io.stdout(text.endsWith('\n') || text === '' ? text : `${text}\n`);
  }

  /** A single resource. */
  item(kind: Kind, value: unknown, human?: (row: Row) => string): void {
    const row = value as Row;
    switch (this.format) {
      case 'json':
        return this.write(JSON.stringify(project(kind, row, this.#fields), null, 2));
      case 'ndjson':
        return this.write(JSON.stringify(project(kind, row, this.#fields)));
      case 'ids':
        return this.write(identifier(kind, row));
      case 'table':
        if (this.#fields?.length) return this.list(kind, [row]);
        if (human) return this.write(human(row));
        if (kind === 'raw') return this.write(JSON.stringify(value, null, 2));
        return this.list(kind, [row]);
    }
  }

  /** A list of resources (a page object or a plain array); `human` renders a non-empty table instead. */
  list(
    kind: Kind,
    value: unknown[] | { data: unknown[]; nextCursor?: string | null },
    human?: (rows: Row[]) => string,
  ): void {
    const page = Array.isArray(value) ? { data: value, nextCursor: null } : value;
    const rows = page.data as Row[];
    switch (this.format) {
      case 'json':
        return this.write(
          JSON.stringify(
            {
              data: rows.map((r) => project(kind, r, this.#fields)),
              nextCursor: page.nextCursor ?? null,
            },
            null,
            2,
          ),
        );
      case 'ndjson':
        return this.write(
          rows.map((r) => JSON.stringify(project(kind, r, this.#fields))).join('\n'),
        );
      case 'ids':
        return this.write(rows.map((r) => identifier(kind, r)).join('\n'));
      case 'table': {
        if (rows.length === 0) return this.#io.stderr('No results.\n');
        if (human && !this.#fields?.length) return this.write(human(rows));
        const columns: Column[] = this.#fields?.length
          ? this.#fields.map((f) => [f.toUpperCase(), (r: Row) => project(kind, r, [f])[f]])
          : kind === 'raw'
            ? Object.keys(rows[0]!).map((k) => [k.toUpperCase(), (r: Row) => r[k]])
            : COLUMNS[kind];
        this.write(
          renderTable(
            columns.map(([h]) => h),
            rows.map((r) => columns.map(([, get]) => cell(get(r)))),
            this.#io.isTTY ? Number(this.#io.env.COLUMNS) || 120 : undefined,
          ),
        );
        if (page.nextCursor)
          this.#io.stderr(`More results: --cursor ${page.nextCursor}  (or --all)\n`);
        return undefined;
      }
    }
  }

  /** A human-only confirmation line (suppressed for machine formats). */
  note(text: string): void {
    if (this.format === 'table') this.#io.stderr(`${text}\n`);
  }
}

export function formatIssue(issue: Row): string {
  const i = issue as unknown as Issue;
  const lines = [
    `${i.key}  ${i.title}${i.deletedAt ? '  [deleted]' : ''}`,
    `Status: ${i.status.name} (${i.status.category}) · Priority: ${PRIORITY[i.priority]} · Assignee: ${actor(i.assignee)}`,
    `Labels: ${names(i.labels)} · Parent: ${i.parent?.key ?? '—'} · Estimate: ${i.estimate ?? '—'} · Due: ${i.dueDate ?? '—'}`,
    ...(Object.keys(i.customFields).length
      ? [
          `Fields: ${Object.entries(i.customFields)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`)
            .join(' · ')}`,
        ]
      : []),
    `Created ${i.createdAt.slice(0, 16).replace('T', ' ')} by ${actor(i.creator)} · Updated ${i.updatedAt.slice(0, 16).replace('T', ' ')} · v${i.version}`,
    `Comments: ${i.commentCount} · Sub-issues: ${i.childCount}`,
  ];
  if (i.description.trim()) lines.push('', i.description.trim());
  return `${lines.join('\n')}\n`;
}
