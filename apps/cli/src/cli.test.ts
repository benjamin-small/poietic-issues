import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createProject, LocalDiskBlobStore } from '@poietic-tech/issues-core';
import { createTestContext, grant, type TestContext } from '@poietic-tech/issues-core/testing';
import { latestMigrationName } from '@poietic-tech/issues-db';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { createApp } from '@poietic-tech/issues-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliIO } from './io.ts';
import type { Command } from 'commander';
import { buildProgram, run } from './admin.ts';

let t: TestContext;
let appFetch: (r: Request) => Promise<Response>;
const dir = mkdtempSync(join(tmpdir(), 'tracker-cli-'));

/** Runs the CLI in-process against the test database (as `admin`), capturing output. */
async function cli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string>; fetch?: CliIO['fetch'] | null } = {},
) {
  let stdout = '';
  let stderr = '';
  const io: CliIO = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, 'config'),
      POIETIC_ISSUES_PROJECT: 'CLI',
      ...opts.env,
    },
    cwd: dir,
    readStdin: async () => opts.stdin ?? '',
    isTTY: false,
    ...(opts.fetch !== null && { fetch: opts.fetch ?? appFetch }),
  };
  const code = await run(args, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

/** An IO that writes nowhere, for building the program without running it. */
function processLessIO(): CliIO {
  return {
    stdout: () => {},
    stderr: () => {},
    env: {},
    cwd: dir,
    readStdin: async () => '',
    isTTY: false,
  };
}

beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'CLI', name: 'CLI' });
  const app = createApp({
    db: t.db,
    auth: { mode: 'trusted', actor: 'admin' },
    blobStore: new LocalDiskBlobStore(join(dir, 'blobs')),
    webhooks: {
      allowPrivate: false,
      send: async (req) =>
        req.url.includes('down')
          ? { statusCode: null, response: null, error: 'connect ECONNREFUSED', durationMs: 1 }
          : { statusCode: 204, response: '', error: null, durationMs: 1 },
    },
  });
  appFetch = (r) => Promise.resolve(app.fetch(r));
});
afterAll(async () => {
  await t.destroy();
  rmSync(dir, { recursive: true, force: true });
});

describe(`tracker CLI (${testDialect()})`, () => {
  it('creates issues and prints JSON, ids or tables', async () => {
    const created = await cli(['issue', 'create', '-t', 'First from CLI', '-p', 'high', '--json']);
    expect(created.code).toBe(0);
    expect(created.json()).toMatchObject({ key: 'CLI-1', priority: 2, title: 'First from CLI' });

    const quiet = await cli(['issue', 'create', '--title', 'Second', '-q']);
    expect(quiet.stdout).toBe('CLI-2\n');

    const table = await cli(['issue', 'list', '--sort', 'key']);
    expect(table.stdout.split('\n')[0]).toMatch(/^KEY\s+STATUS\s+PRI\s+ASSIGNEE\s+LABELS\s+TITLE$/);
    expect(table.stdout).toContain('CLI-1');
  });

  it('reads descriptions and full payloads from stdin', async () => {
    const res = await cli(['issue', 'create', '-t', 'From stdin', '--body-file', '-', '--json'], {
      stdin: '# Heading\n\nBody',
    });
    expect(res.json().description).toBe('# Heading\n\nBody');
    const input = await cli(['issue', 'create', '--input', '-', '--json'], {
      stdin: JSON.stringify({ title: 'Payload', priority: 4, metadata: { 'agent.run': 7 } }),
    });
    expect(input.json()).toMatchObject({
      title: 'Payload',
      priority: 4,
      metadata: { 'agent.run': 7 },
    });
  });

  it('filters, projects fields and paginates', async () => {
    const label = await cli(['label', 'create', 'bug', '--color', '#ff0000']);
    expect(label.stderr).toBe('');
    const edited = await cli([
      'issue',
      'edit',
      'CLI-1',
      '--add-label',
      'bug',
      '--assignee',
      'me',
      '-s',
      'In Progress',
    ]);
    expect(edited.stderr).toBe('');
    expect(edited.code).toBe(0);
    const filtered = await cli([
      'issue',
      'list',
      '--label',
      'bug',
      '--assignee',
      'me',
      '--json',
      '--fields',
      'key,status,labels,assignee.handle',
    ]);
    expect(filtered.json()).toEqual({
      data: [
        {
          key: 'CLI-1',
          status: expect.objectContaining({ name: 'In Progress' }),
          labels: [expect.objectContaining({ name: 'bug' })],
          'assignee.handle': 'admin',
        },
      ],
      nextCursor: null,
    });
    const where = await cli([
      'issue',
      'list',
      '-w',
      'priority.gte=2',
      '-w',
      'title.contains=from',
      '-q',
    ]);
    expect(where.stdout.trim().split('\n')).toEqual(['CLI-1']);
    const page = await cli(['issue', 'list', '--limit', '2', '--sort', 'key', '--json']);
    expect(page.json().data).toHaveLength(2);
    expect(page.json().nextCursor).toBeTruthy();
    const all = await cli([
      'issue',
      'list',
      '--limit',
      '2',
      '--sort',
      'key',
      '--all',
      '--format',
      'ndjson',
    ]);
    expect(
      all.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).key),
    ).toEqual(['CLI-1', 'CLI-2', 'CLI-3', 'CLI-4']);
  });

  it('maps API errors to documented exit codes and problem JSON on stderr', async () => {
    const missing = await cli(['issue', 'view', 'CLI-999', '--json']);
    expect(missing.code).toBe(3);
    expect(missing.stdout).toBe('');
    expect(JSON.parse(missing.stderr)).toMatchObject({ code: 'NOT_FOUND' });

    const stale = await cli(['issue', 'edit', 'CLI-1', '-t', 'x', '--if-version', '1']);
    expect(stale.code).toBe(4);
    expect(stale.stderr).toMatch(/VERSION_MISMATCH/);

    const invalid = await cli(['issue', 'create', '-t', 'x', '--label', 'nope']);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toMatch(/Unknown label/);

    const usage = await cli(['issue', 'create', '--priority', 'extreme']);
    expect(usage.code).toBe(2);
    const unknown = await cli(['issue', 'frobnicate']);
    expect(unknown.code).toBe(2);
    expect((await cli(['--version'])).code).toBe(0);
    expect((await cli(['issue', 'list'], { env: { POIETIC_ISSUES_PROJECT: '' } })).stderr).toMatch(
      /No project given/,
    );
  });

  it('edits several issues atomically, moves, deletes and restores', async () => {
    const bulk = await cli(['issue', 'edit', 'CLI-2', 'CLI-3', '--priority', 'low', '--json']);
    expect(bulk.json().data.map((i: { priority: number }) => i.priority)).toEqual([4, 4]);
    const moved = await cli(['issue', 'move', 'CLI-2', '--status', 'Done', '--json']);
    expect(moved.json().status.name).toBe('Done');
    expect((await cli(['issue', 'delete', 'CLI-4', '--json'])).json().deletedAt).not.toBeNull();
    expect((await cli(['issue', 'restore', 'CLI-4', '--json'])).json().deletedAt).toBeNull();
  });

  it('comments and links with natural aliases', async () => {
    const comment = await cli(['comment', 'add', 'CLI-1', 'Looks', 'good', '--json']);
    expect(comment.json().body).toBe('Looks good');
    const fromStdin = await cli(['comment', 'add', 'CLI-1', '--body-file', '-', '-q'], {
      stdin: 'piped',
    });
    expect(fromStdin.stdout).toMatch(/^cmt_/);
    expect((await cli(['comment', 'list', 'CLI-1', '--json'])).json().data).toHaveLength(2);

    const link = await cli(['link', 'add', 'CLI-2', 'blocked-by', 'CLI-1', '--json']);
    expect(link.json()).toMatchObject({ label: 'is blocked by', issue: { key: 'CLI-1' } });
    const fromOther = await cli(['link', 'list', 'CLI-1', '--json']);
    expect(fromOther.json().data[0]).toMatchObject({ label: 'blocks', issue: { key: 'CLI-2' } });
  });

  it('reads the event log and tails it', async () => {
    const events = await cli(['event', 'list', '--json', '--limit', '1000']);
    const seqs = events.json().data.map((e: { seq: number }) => e.seq);
    const tail = await cli(['event', 'tail', '--after', String(seqs.at(-3)), '--max', '2']);
    expect(
      tail.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).seq),
    ).toEqual(seqs.slice(-2));
    const history = await cli(['issue', 'activity', 'CLI-1', '--json']);
    expect(history.json().data.map((e: { type: string }) => e.type)).toContain('comment.created');
  });

  it('never shadows a global option in a subcommand (commander would swallow it)', () => {
    const program = buildProgram({ ...processLessIO(), env: {} });
    const flags = (s: string) => s.split(/[ ,|]+/).filter((f) => f.startsWith('-'));
    const globals = new Set(program.options.flatMap((o) => flags(o.flags)));
    const clashes: string[] = [];
    const walk = (cmd: Command, path: string[]) => {
      for (const sub of cmd.commands) {
        const name = [...path, sub.name()];
        for (const o of sub.options)
          for (const f of flags(o.flags))
            if (globals.has(f)) clashes.push(`${name.join(' ')} ${f}`);
        walk(sub, name);
      }
    };
    walk(program, []);
    expect(clashes).toEqual([]);
  });

  it('prints schemas and help', async () => {
    const schema = await cli(['schema', 'issue-create']);
    expect(JSON.parse(schema.stdout).required).toEqual(['title']);
    const live = await cli(['project', 'schema']);
    expect(JSON.parse(live.stdout).create.properties.labels.items.enum).toEqual(['bug']);
    const help = await cli(['issue', 'create', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--body-file <path>');
  });

  it('defines custom fields and sets/filters them', async () => {
    const created = await cli([
      'field',
      'create',
      'severity',
      '--type',
      'select',
      '--option',
      'low,high',
      '--json',
    ]);
    expect(created.json()).toMatchObject({
      key: 'severity',
      type: 'select',
      options: [{ value: 'low' }, { value: 'high' }],
    });
    await cli(['field', 'create', 'points', '--type', 'number', '-n', 'Points']);
    const issue = await cli([
      'issue',
      'create',
      '-t',
      'With fields',
      '--set',
      'severity=high',
      '--set',
      'points=3',
      '--json',
    ]);
    expect(issue.json().customFields).toEqual({ severity: 'high', points: 3 });
    const found = await cli([
      'issue',
      'list',
      '-w',
      'cf.severity=high',
      '-w',
      'cf.points.gte=2',
      '-q',
    ]);
    expect(found.stdout.trim()).toBe(issue.json().key);
    const bad = await cli(['issue', 'edit', issue.json().key, '--set', 'severity=medium']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/unknown option "medium"/);
    await cli(['field', 'option-add', 'severity', 'medium']);
    expect((await cli(['issue', 'edit', issue.json().key, '--set', 'severity=medium'])).code).toBe(
      0,
    );
    const list = await cli(['field', 'list']);
    expect(list.stdout).toContain('severity  severity  [select]');
    expect(list.stdout).toContain('options: low, high, medium');
  });

  it('calls arbitrary endpoints with `api`', async () => {
    const res = await cli(['api', 'GET', '/issues/CLI-1']);
    expect(JSON.parse(res.stdout).key).toBe('CLI-1');
    const created = await cli(['api', 'POST', '/projects/CLI/labels', '-f', 'name=api-made']);
    expect(JSON.parse(created.stdout).name).toBe('api-made');
    expect((await cli(['api', 'GET', '/issues/NOPE-1'])).code).toBe(3);
  });

  it('uploads, lists, downloads and removes attachments', async () => {
    const issue = (await cli(['issue', 'create', '-t', 'With files', '--json'])).json();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(join(dir, 'dot.png'), png);
    writeFileSync(join(dir, 'notes.txt'), 'hello attachments');

    const added = await cli(['attachment', 'add', issue.key, 'dot.png', 'notes.txt', '--json']);
    expect(added.code).toBe(0);
    const [image, text] = added.json().data;
    expect(image).toMatchObject({
      filename: 'dot.png',
      contentType: 'image/png',
      size: png.length,
    });
    expect(text).toMatchObject({ filename: 'notes.txt', contentType: 'text/plain' });

    const fromStdin = await cli(['attach', 'add', issue.key, '-', '--name', 'log.txt', '-q'], {
      stdin: 'piped',
    });
    expect(fromStdin.stdout).toMatch(/^att_/);

    const list = await cli(['attachment', 'list', issue.key]);
    expect(list.stdout.split('\n')[0]).toMatch(
      /^ID\s+FILENAME\s+TYPE\s+SIZE\s+UPLOADER\s+CREATED$/,
    );
    expect(list.stdout).toContain('notes.txt');

    const out = await cli(['attachment', 'download', image.id, '-o', 'copy.png']);
    expect(out.code).toBe(0);
    expect(readFileSync(join(dir, 'copy.png'))).toEqual(png);
    expect((await cli(['attachment', 'get', text.id, '-o', '-'])).stdout).toBe('hello attachments');

    expect((await cli(['attachment', 'rm', text.id])).stdout).toBe('Deleted notes.txt\n');
    const missing = await cli(['attachment', 'view', text.id]);
    expect(missing.code).toBe(3);
    expect((await cli(['attachment', 'add', issue.key, 'nope.bin'])).code).toBe(2);
  });

  it('manages webhooks', async () => {
    const created = await cli([
      'webhook',
      'create',
      'https://example.com/hook',
      '--events',
      'issue.*,comment.created',
      '--scope',
      'CLI',
      '--description',
      'CI bot',
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/Signing secret .*\nwhsec_/);
    const id = /Created webhook (whk_\w+)/.exec(created.stdout)![1]!;

    const listed = await cli(['webhook', 'ls']);
    expect(listed.stdout.split('\n')[0]).toMatch(
      /^ID\s+URL\s+EVENTS\s+ACTIVE\s+PAYLOAD\s+DESCRIPTION$/,
    );
    expect(listed.stdout).toContain('issue.*,comment.created');

    const edited = await cli(['webhook', 'edit', id, '--scope', 'all', '--disable', '--json']);
    expect(edited.json()).toMatchObject({ projectId: null, active: false });
    expect((await cli(['webhook', 'test', id])).stdout).toMatch(/^OK: HTTP 204/);
    expect((await cli(['webhook', 'deliveries', id, '--json'])).json()).toEqual({
      data: [],
      nextCursor: null,
    });
    const rotated = await cli(['webhook', 'rotate-secret', id, '--json']);
    expect(rotated.json().secret).toMatch(/^whsec_/);

    const insecure = await cli(['webhook', 'create', 'http://127.0.0.1:8080/x']);
    expect(insecure.code).toBe(2);
    const down = await cli(['webhook', 'create', 'https://down.example.com/', '-q']);
    const ping = await cli(['webhook', 'test', down.stdout.trim()]);
    expect(ping.code).toBe(6);
    expect(ping.stderr).toMatch(/ECONNREFUSED/);
    expect((await cli(['webhook', 'rm', id])).stdout).toBe(`Deleted webhook ${id}\n`);

    const notice = await cli([
      'webhook',
      'create',
      'https://example.com/notices',
      '--payload',
      'notice',
      '--json',
    ]);
    expect(notice.json()).toMatchObject({ payload: 'notice' });
    const full = await cli(['webhook', 'edit', notice.json().id, '--payload', 'full', '--json']);
    expect(full.json()).toMatchObject({ payload: 'full' });
    expect(
      (await cli(['webhook', 'create', 'https://example.com/x', '--payload', 'all'])).code,
    ).toBe(2);

    const secret = 'whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=';
    const supplied = await cli(
      ['webhook', 'create', 'https://example.com/bridge', '--secret-stdin', '--json'],
      { stdin: `${secret}\n` },
    );
    expect(supplied.code).toBe(0);
    // The caller already holds a supplied secret: it is never printed back.
    expect(supplied.json()).toMatchObject({ url: 'https://example.com/bridge' });
    expect(supplied.stdout).not.toContain(secret);
    const human = await cli(
      ['webhook', 'create', 'https://example.com/bridge2', '--secret-stdin'],
      {
        stdin: secret,
      },
    );
    expect(human.code).toBe(0);
    expect(human.stdout + human.stderr).not.toContain(secret);
    expect(human.stdout).toMatch(/whk_/);
    const empty = await cli(['webhook', 'create', 'https://example.com/y', '--secret-stdin'], {
      stdin: '',
    });
    expect(empty.code).toBe(2);
    const bad = await cli(['webhook', 'create', 'https://example.com/z', '--secret-stdin'], {
      stdin: 'whsec_tooshort=',
    });
    expect(bad.code).toBe(2);
    expect(bad.stderr).not.toContain('tooshort');
  });
});

describe(`project access commands (${testDialect()})`, () => {
  it('manages members, repos, visibility and issue repos', async () => {
    const added = await cli([
      'project',
      'members',
      'add',
      '@member',
      '--role',
      'editor',
      '-P',
      'CLI',
      '--json',
    ]);
    expect(added.stderr).toBe('');
    expect(added.code).toBe(0);
    expect(added.json()).toMatchObject({ user: { handle: 'member' }, role: 'editor' });
    expect((await cli(['project', 'members', 'add', 'member', '--role', 'viewer'])).code).toBe(4);
    expect((await cli(['project', 'members', 'add', 'member'])).code).toBe(2);
    expect((await cli(['project', 'members', 'add', 'member', '--role', 'boss'])).code).toBe(2);

    const set = await cli(['project', 'members', 'set', 'member', '--role', 'manager', '--json']);
    expect(set.json()).toMatchObject({ user: { handle: 'member' }, role: 'manager' });
    const table = await cli(['project', 'members', 'list']);
    expect(table.stdout.split('\n')[0]).toMatch(/^USER\s+ROLE\s+SINCE$/);
    expect(table.stdout).toMatch(/@member\s+manager/);
    expect((await cli(['project', 'members', 'list', '-q'])).stdout).toBe('member\n');
    expect((await cli(['project', 'members', 'list', '--json'])).json().data).toHaveLength(1);

    const repo = await cli([
      'project',
      'repo',
      'add',
      'https://github.com/acme/app',
      '-P',
      'CLI',
      '--json',
    ]);
    expect(repo.json()).toMatchObject({ fullName: 'acme/app', url: 'https://github.com/acme/app' });
    expect((await cli(['project', 'repo', 'add', 'acme/app'])).code).toBe(4);
    await cli(['project', 'repo', 'add', 'acme/docs']);
    const repos = await cli(['project', 'repo', 'list', '--json']);
    expect(repos.json().data.map((r: { fullName: string }) => r.fullName)).toEqual([
      'acme/app',
      'acme/docs',
    ]);
    expect((await cli(['project', 'repo', 'list'])).stdout).toMatch(/^ID\s+REPO\s+URL/);

    const vis = await cli(['project', 'edit', 'CLI', '--visibility', 'public', '--json']);
    expect(vis.json()).toMatchObject({ visibility: 'public' });
    expect((await cli(['project', 'edit', 'CLI', '--visibility', 'secret'])).code).toBe(2);
    const created = await cli([
      'project',
      'create',
      '-k',
      'PUB',
      '-n',
      'Public',
      '--visibility',
      'public',
      '--json',
    ]);
    expect(created.json()).toMatchObject({ key: 'PUB', visibility: 'public' });

    const issue = await cli([
      'issue',
      'create',
      '-t',
      'Needs a repo',
      '--repo',
      'acme/app',
      '--json',
    ]);
    expect(issue.json()).toMatchObject({ repo: 'acme/app' });
    const key = issue.json().key as string;
    const moved = await cli(['issue', 'edit', key, '--repo', 'acme/docs', '--json']);
    expect(moved.json()).toMatchObject({ repo: 'acme/docs' });
    const cleared = await cli(['issue', 'edit', key, '--repo', '', '--json']);
    expect(cleared.json()).toMatchObject({ repo: null });
    expect((await cli(['issue', 'edit', key, '--repo', 'acme/nope'])).code).toBe(2);

    const removedRepo = await cli(['project', 'repo', 'remove', 'acme/docs']);
    expect(removedRepo.stdout).toMatch(/Unlinked/);
    expect(removedRepo.code).toBe(0);
    expect((await cli(['project', 'repo', 'remove', 'acme/docs'])).code).toBe(3);
    const byUrl = await cli(['project', 'repo', 'remove', 'https://github.com/acme/app', '--json']);
    expect(byUrl.json()).toEqual({ id: 'https://github.com/acme/app', removed: true });
    expect((await cli(['project', 'repo', 'list', '--json'])).json().data).toEqual([]);
    const removed = await cli(['project', 'members', 'remove', '@member']);
    expect(removed.code).toBe(0);
    expect((await cli(['project', 'members', 'remove', '@member'])).code).toBe(3);
    expect((await cli(['project', 'members', 'list', '--json'])).json().data).toEqual([]);
  });
});

describe(`project access commands without manage (${testDialect()})`, () => {
  it('exits with 5 when a non-manager changes members, and 3 when the project is hidden', async () => {
    await createProject(t.ctx, { key: 'CLIB', name: 'Members guard' });
    await createProject(t.ctx, { key: 'CLIH', name: 'Hidden' });
    await grant(t, 'CLIB', t.member, 'viewer');
    await grant(t, 'CLIB', t.agent, 'editor');
    const asActor = (actor: string) => {
      const app = createApp({ db: t.db, auth: { mode: 'trusted', actor } });
      const fetch: CliIO['fetch'] = (r) => Promise.resolve(app.fetch(r as Request));
      return (args: string[]) => cli(args, { fetch });
    };

    for (const actor of ['member', 'bot']) {
      const as = asActor(actor);
      const add = await as([
        'project',
        'members',
        'add',
        '@admin',
        '--role',
        'viewer',
        '-P',
        'CLIB',
      ]);
      expect(add.code, `${actor} adding`).toBe(5);
      expect(add.stderr).toMatch(/Only project managers can do this/);
      expect(add.stdout).toBe('');
      const json = await as([
        'project',
        'members',
        'add',
        '@admin',
        '--role',
        'viewer',
        '-P',
        'CLIB',
        '--json',
      ]);
      expect(json.code).toBe(5);
      expect(JSON.parse(json.stderr)).toMatchObject({ code: 'FORBIDDEN' });
      expect(
        (await as(['project', 'members', 'set', '@bot', '--role', 'manager', '-P', 'CLIB'])).code,
      ).toBe(5);
      expect((await as(['project', 'members', 'remove', '@member', '-P', 'CLIB'])).code).toBe(5);
      expect((await as(['project', 'repo', 'add', 'acme/guarded', '-P', 'CLIB'])).code).toBe(5);
      // Readers can still look.
      expect((await as(['project', 'members', 'list', '-P', 'CLIB', '-q'])).stdout).toBe(
        'bot\nmember\n',
      );
    }

    // A project the actor cannot read is not found (3), not forbidden (5).
    const hidden = await asActor('member')([
      'project',
      'members',
      'add',
      '@bot',
      '--role',
      'viewer',
      '-P',
      'CLIH',
    ]);
    expect(hidden.code).toBe(3);

    // Nothing changed.
    const members = await cli(['project', 'members', 'list', '-P', 'CLIB', '-q']);
    expect(members.stdout).toBe('bot\nmember\n');
    expect((await cli(['project', 'repo', 'list', '-P', 'CLIB', '--json'])).json().data).toEqual(
      [],
    );
  });
});

describe.runIf(testDialect() === 'sqlite')('local mode (real transport)', () => {
  it('runs in-process against a local SQLite file', async () => {
    const db = join(dir, 'local.db');
    const env = { POIETIC_ISSUES_DATABASE_URL: `sqlite:${db}` };
    const unmigrated = await cli(['issue', 'list'], { env, fetch: null });
    expect(unmigrated.code).toBe(6);
    expect(unmigrated.stderr).toMatch(/poietic-issues-admin db migrate/);
    expect((await cli(['db', 'migrate'], { env, fetch: null })).stdout).toMatch(
      /Applied: 0001_init, 0002_webhook_delivery_details/,
    );
    const fresh = { POIETIC_ISSUES_DATABASE_URL: `sqlite:${join(dir, 'fresh.db')}` };
    const boot = await cli(['db', 'bootstrap', '--handle', 'root', '--name', 'Root', '--json'], {
      env: fresh,
      fetch: null,
    });
    expect(boot.json()).toMatchObject({ user: { handle: 'root', role: 'admin' } });
    expect(boot.json()).not.toHaveProperty('token');
    const again = await cli(['db', 'bootstrap', '--handle', 'x', '--name', 'X'], {
      env: fresh,
      fetch: null,
    });
    expect(again.code).toBe(4);
    expect((await cli(['whoami', '-q'], { env: fresh, fetch: null })).stdout).toMatch(/usr_/);
    const seeded = await cli(['db', 'seed', '--json'], { env, fetch: null });
    expect(seeded.json()).toEqual({ users: ['ada', 'grace', 'margaret', 'claude'] });
    const list = await cli(['issue', 'list', '--project', 'ENG', '-q', '--sort', 'key'], {
      env,
      fetch: null,
    });
    expect(list.stdout.trim().split('\n')[0]).toBe('ENG-1');
    const me = await cli(['whoami', '--json'], {
      env: { ...env, POIETIC_ISSUES_ACTOR: 'claude' },
      fetch: null,
    });
    expect(me.json()).toMatchObject({ handle: 'claude', kind: 'agent' });
  });

  it('manages project access in local mode too', async () => {
    const env = { POIETIC_ISSUES_DATABASE_URL: `sqlite:${join(dir, 'access.db')}` };
    const local = (args: string[]) => cli(args, { env, fetch: null });
    expect((await local(['db', 'migrate'])).code).toBe(0);
    expect((await local(['db', 'seed'])).code).toBe(0);
    expect((await local(['user', 'create', '--handle', 'zed', '--name', 'Zed'])).code).toBe(0);
    const added = await local([
      'project',
      'members',
      'add',
      '@zed',
      '--role',
      'editor',
      '-P',
      'ENG',
      '--json',
    ]);
    expect(added.stderr).toBe('');
    expect(added.json()).toMatchObject({ user: { handle: 'zed' }, role: 'editor' });
    expect((await local(['project', 'repo', 'add', 'acme/app', '-P', 'ENG', '-q'])).code).toBe(0);
    // The seeded ENG project is already public (and has the demo repo), so flip it to private.
    const project = await local(['project', 'edit', 'ENG', '--visibility', 'private', '--json']);
    expect(project.json()).toMatchObject({ visibility: 'private', myAccess: 'manage' });
    // Exactly the seeded demo repo and the one added above (listed by owner, then name).
    expect(project.json().repos.map((r: { fullName: string }) => r.fullName)).toEqual([
      'acme/app',
      'poietic-tech/poietic-issues',
    ]);
    expect((await local(['project', 'members', 'list', '-P', 'ENG', '-q'])).stdout).toContain(
      'zed',
    );
  });

  it('reverts the newest migration one step at a time, keeping the data', async () => {
    const env = { POIETIC_ISSUES_DATABASE_URL: `sqlite:${join(dir, 'down.db')}` };
    const local = (args: string[]) => cli(args, { env, fetch: null });
    const latest = latestMigrationName();
    expect((await local(['db', 'seed'])).code).toBe(0);
    const down = await local(['db', 'migrate', '--down', '--json']);
    expect(down.stderr).toBe('');
    expect(down.code).toBe(0);
    expect(down.json()).toMatchObject({ reverted: [latest], latest });
    expect((await local(['db', 'status', '--json'])).json()).toMatchObject({
      pending: [latest],
      upToDate: false,
    });
    // Commands refuse to run on a database that is behind, then migrating forward again works.
    expect((await local(['issue', 'list', '-P', 'ENG'])).code).toBe(6);
    expect((await local(['db', 'migrate'])).stdout).toBe(`Applied: ${latest}\n`);
    const issues = await local(['issue', 'list', '-P', 'ENG', '-q', '--sort', 'key']);
    expect(issues.stdout.trim().split('\n')[0]).toBe('ENG-1');
    expect((await local(['db', 'migrate', '--down'])).stdout).toBe(`Reverted: ${latest}\n`);
  });

  it('never reverts the first migration, and never creates a database to revert', async () => {
    const file = join(dir, 'floor.db');
    const local = (args: string[], url = `sqlite:${file}`) =>
      cli(args, { env: { POIETIC_ISSUES_DATABASE_URL: url }, fetch: null });
    expect((await local(['db', 'migrate'])).code).toBe(0);
    for (;;) {
      const { applied } = (await local(['db', 'status', '--json'])).json() as { applied: string[] };
      if (applied.length === 1) break;
      expect((await local(['db', 'migrate', '--down'])).code).toBe(0);
    }
    const refused = await local(['db', 'migrate', '--down']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('Refusing to revert 0001_init');
    expect((await local(['db', 'status', '--json'])).json()).toMatchObject({
      applied: ['0001_init'],
    });

    const missing = join(dir, 'no-such', 'typo.db');
    for (const args of [
      ['db', 'migrate', '--down'],
      ['db', 'status'],
    ]) {
      const result = await local(args, `sqlite:${missing}`);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('No database at');
    }
    expect(existsSync(missing)).toBe(false);
  });

  it('creates the SQLite file’s directory, like the server does', async () => {
    const env = {
      POIETIC_ISSUES_DATABASE_URL: `sqlite:${join(dir, 'missing', 'nested', 'dev.db')}`,
    };
    const migrated = await cli(['db', 'migrate'], { env, fetch: null });
    expect(migrated.stderr).toBe('');
    expect(migrated.code).toBe(0);
  });

  it('works as a spawned binary', async () => {
    const bin = fileURLToPath(new URL('./admin-bin.ts', import.meta.url));
    const exec = promisify(execFile);
    const version = await exec(process.execPath, [bin, '--version']);
    expect(version.stdout.trim()).toBe('0.1.0');
    const failure = await exec(process.execPath, [bin, 'issue', 'view', 'ENG-999', '--json'], {
      env: {
        ...process.env,
        POIETIC_ISSUES_DATABASE_URL: `sqlite:${join(dir, 'local.db')}`,
        HOME: dir,
      },
    }).catch((e: { code: number; stderr: string }) => e);
    expect(failure).toMatchObject({ code: 3 });
    expect(JSON.parse((failure as { stderr: string }).stderr).code).toBe('NOT_FOUND');
  }, 30_000);
});

describe('the operator tool poietic-issues-admin', () => {
  it('has no remote mode: --server and --token are unknown options', async () => {
    for (const args of [
      ['--server', 'https://x', 'issue', 'list'],
      ['--token', 't', 'issue', 'list'],
    ]) {
      const res = await cli(args);
      expect(res.code, args[0]).toBe(2);
      expect(res.stderr, args[0]).toMatch(/unknown option/);
    }
  });

  it('has no auth command', async () => {
    const res = await cli(['auth', 'status']);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/unknown command/);
  });

  it('still runs the tree through the injected fetch', async () => {
    const res = await cli(['issue', 'create', '-t', 'Through the admin tool', '--json']);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({ title: 'Through the admin tool' });
  });

  it('names itself poietic-issues-admin', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: poietic-issues-admin /);
    expect(help.stdout).not.toMatch(/--server|--token|\bauth\b/);
  });
});
