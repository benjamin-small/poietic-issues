import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgTimestampToIso } from './dialect.ts';
import { latestMigrationName, migrateDown, migrateToLatest, migrationStatus } from './migrate.ts';
import { createTestDb, type TestDb, testDialect } from './testing.ts';
import { withWriteTx } from './tx.ts';
import { fromJson, likeContains, toBool, toJson } from './values.ts';

const NOW = '2026-09-26T13:49:00.123Z';
const dialect = testDialect();

async function seedBasics(db: TestDb, key = 'ENG') {
  await withWriteTx(db, async (tx) => {
    await tx
      .insertInto('users')
      .values({
        id: `usr_${key}`,
        handle: `user-${key.toLowerCase()}`,
        name: 'Ada',
        email: null,
        kind: 'human',
        role: 'admin',
        avatar_url: null,
        created_at: NOW,
        updated_at: NOW,
        deactivated_at: null,
        owner_id: null,
      })
      .execute();
    await tx
      .insertInto('projects')
      .values({
        id: `prj_${key}`,
        key,
        name: 'Engineering',
        description: '',
        visibility: 'private',
        next_issue_number: 1,
        created_at: NOW,
        updated_at: NOW,
        archived_at: null,
      })
      .execute();
    await tx
      .insertInto('statuses')
      .values({
        id: `sts_${key}`,
        project_id: `prj_${key}`,
        name: 'Todo',
        category: 'unstarted',
        color: '#999',
        position: 0,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
  });
}

function issueRow(key: string, n: number, rank: string) {
  return {
    id: `iss_${key}_${n}`,
    project_id: `prj_${key}`,
    number: n,
    title: `Issue ${n}`,
    description: '',
    status_id: `sts_${key}`,
    priority: 0,
    assignee_id: null,
    creator_id: `usr_${key}`,
    parent_id: null,
    estimate: null,
    due_date: null,
    rank,
    metadata: '{}',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    deleted_at: null,
  };
}

describe(`database layer (${dialect})`, () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await seedBasics(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('is fully migrated', async () => {
    const status = await migrationStatus(db);
    expect(status.upToDate).toBe(true);
    expect(status.applied.at(-1)).toBe(latestMigrationName());
  });

  it('round-trips timestamps, dates, reals, JSON and booleans identically', async () => {
    const metadata = {
      agent: { session: 'abc', attempts: [1, 2] },
      note: 'ünïcødé "quotes"',
      n: '123',
    };
    await withWriteTx(db, async (tx) => {
      await tx
        .insertInto('issues')
        .values({
          ...issueRow('ENG', 100, 'a0'),
          estimate: 2.5,
          due_date: '2026-12-31',
          metadata: toJson(metadata),
          completed_at: '2026-01-02T03:04:05.006Z',
        })
        .execute();
      await tx
        .insertInto('link_types')
        .values([
          {
            id: 'lty_t',
            key: 'tst-true',
            name: 'T',
            outward_label: 'o',
            inward_label: 'i',
            symmetric: true,
            built_in: false,
            created_at: NOW,
          },
        ])
        .execute();
    });

    const issue = await db.kysely
      .selectFrom('issues')
      .selectAll()
      .where('id', '=', 'iss_ENG_100')
      .executeTakeFirstOrThrow();
    expect(issue.created_at).toBe(NOW);
    expect(issue.completed_at).toBe('2026-01-02T03:04:05.006Z');
    expect(issue.due_date).toBe('2026-12-31');
    expect(issue.estimate).toBe(2.5);
    expect(fromJson(issue.metadata, {})).toEqual(metadata);
    expect(typeof issue.number).toBe('number');

    const lt = await db.kysely
      .selectFrom('link_types')
      .selectAll()
      .where('id', '=', 'lty_t')
      .executeTakeFirstOrThrow();
    expect(toBool(lt.symmetric)).toBe(true);
    expect(toBool(lt.built_in)).toBe(false);
    // Boolean parameters in WHERE clauses work on both dialects.
    const found = await db.kysely
      .selectFrom('link_types')
      .select('id')
      .where('symmetric', '=', true)
      .execute();
    expect(found.map((r) => r.id)).toContain('lty_t');
  });

  it('orders ranks byte-wise regardless of case', async () => {
    const ranks = ['a1', 'Zz', 'b', 'A0', 'a0V'];
    await withWriteTx(db, async (tx) => {
      await tx
        .insertInto('issues')
        .values(ranks.map((rank, i) => issueRow('ENG', 200 + i, rank)))
        .execute();
    });
    const rows = await db.kysely
      .selectFrom('issues')
      .select('rank')
      .where('number', '>=', 200)
      .orderBy('rank')
      .execute();
    expect(rows.map((r) => r.rank)).toEqual(['A0', 'Zz', 'a0V', 'a1', 'b']);
  });

  it('allocates unique sequential issue numbers under concurrency', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () =>
        withWriteTx(db, async (tx) => {
          const row = await tx
            .updateTable('projects')
            .set((eb) => ({ next_issue_number: eb('next_issue_number', '+', 1) }))
            .where('id', '=', 'prj_ENG')
            .returning('next_issue_number')
            .executeTakeFirstOrThrow();
          return row.next_issue_number - 1;
        }),
      ),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('rolls back a failed write transaction', async () => {
    await expect(
      withWriteTx(db, async (tx) => {
        await tx
          .updateTable('projects')
          .set({ name: 'Renamed' })
          .where('id', '=', 'prj_ENG')
          .execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const project = await db.kysely
      .selectFrom('projects')
      .select('name')
      .where('id', '=', 'prj_ENG')
      .executeTakeFirstOrThrow();
    expect(project.name).toBe('Engineering');
  });

  it('notifies commit listeners after (and only after) a successful commit', async () => {
    let commits = 0;
    const off = db.onCommit(() => commits++);
    await withWriteTx(db, async () => {});
    await withWriteTx(db, async () => {
      throw new Error('nope');
    }).catch(() => {});
    off();
    await withWriteTx(db, async () => {});
    expect(commits).toBe(1);
  });

  it('enforces foreign keys', async () => {
    await expect(
      withWriteTx(db, (tx) =>
        tx
          .insertInto('issue_labels')
          .values({ issue_id: 'iss_missing', label_id: 'lbl_missing', created_at: NOW })
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('enforces declared column types (STRICT tables on SQLite)', async () => {
    await expect(
      sql`insert into projects (id, key, name, description, next_issue_number, created_at, updated_at)
          values ('prj_bad', 'BAD', 'x', '', 'not-a-number', ${NOW}, ${NOW})`.execute(db.kysely),
    ).rejects.toThrow();
  });

  it('matches case-insensitively and literally with likeContains', async () => {
    await withWriteTx(db, (tx) =>
      tx
        .insertInto('issues')
        .values([
          { ...issueRow('ENG', 300, 'c'), title: 'Fix 100% CPU in Parser' },
          { ...issueRow('ENG', 301, 'd'), title: 'Fix 1000 CPUs' },
        ])
        .execute(),
    );
    const rows = await db.kysely
      .selectFrom('issues')
      .select('number')
      .where(sql<boolean>`lower(title) like lower(${likeContains('100% cpu')}) escape '\\'`)
      .execute();
    expect(rows.map((r) => r.number)).toEqual([300]);
  });

  it('keeps repo links unique per project, ignoring case in owner and name', async () => {
    await seedBasics(db, 'REPO');
    await seedBasics(db, 'REPX');
    const link = (id: string, project: string, owner: string, name: string) =>
      withWriteTx(db, (tx) =>
        tx
          .insertInto('project_repos')
          .values({ id, project_id: `prj_${project}`, owner, name, created_at: NOW })
          .execute(),
      );
    await link('rpo_1', 'REPO', 'Acme', 'App');
    for (const [id, owner, name] of [
      ['rpo_2', 'Acme', 'App'],
      ['rpo_3', 'acme', 'app'],
      ['rpo_4', 'ACME', 'aPP'],
      ['rpo_5', 'acme', 'App'],
      ['rpo_6', 'Acme', 'APP'],
    ] as const)
      await expect(link(id, 'REPO', owner, name), `${owner}/${name}`).rejects.toThrow(
        /project_repos_unique/,
      );
    // Different names, or the same name in another project, are fine.
    await link('rpo_7', 'REPO', 'Acme', 'Other');
    await link('rpo_8', 'REPO', 'Other', 'App');
    await link('rpo_9', 'REPX', 'acme', 'app');
  });
});

describe(`migrations (${dialect})`, () => {
  it('migrate down removes everything and migrate up restores it', async () => {
    const db = await createTestDb();
    try {
      expect(await migrateDown(db)).toEqual(['0008_webhook_payload']);
      await expect(sql`select payload from webhooks`.execute(db.kysely)).rejects.toThrow();
      expect(await migrateDown(db)).toEqual(['0007_drop_api_tokens']);
      expect(
        (await sql`select count(*) as n from api_tokens`.execute(db.kysely)).rows,
      ).toHaveLength(1);
      expect(await migrateDown(db)).toEqual(['0006_end_sso_users_sessions']);
      expect(await migrateDown(db)).toEqual(['0005_user_owner']);
      await expect(sql`select owner_id from users`.execute(db.kysely)).rejects.toThrow();
      expect(await migrateDown(db)).toEqual(['0004_project_access']);
      await expect(sql`select count(*) from project_members`.execute(db.kysely)).rejects.toThrow();
      expect(await migrateDown(db)).toEqual(['0003_user_identities']);
      await expect(sql`select count(*) from user_identities`.execute(db.kysely)).rejects.toThrow();
      expect(await migrateDown(db)).toEqual(['0002_webhook_delivery_details']);
      await expect(
        sql`select last_response from webhook_deliveries`.execute(db.kysely),
      ).rejects.toThrow();
      expect(await migrateDown(db)).toEqual(['0001_init']);
      await expect(sql`select count(*) from users`.execute(db.kysely)).rejects.toThrow();
      expect((await migrationStatus(db)).pending).toEqual([
        '0001_init',
        '0002_webhook_delivery_details',
        '0003_user_identities',
        '0004_project_access',
        '0005_user_owner',
        '0006_end_sso_users_sessions',
        '0007_drop_api_tokens',
        '0008_webhook_payload',
      ]);
      expect(await migrateToLatest(db)).toEqual([
        '0001_init',
        '0002_webhook_delivery_details',
        '0003_user_identities',
        '0004_project_access',
        '0005_user_owner',
        '0006_end_sso_users_sessions',
        '0007_drop_api_tokens',
        '0008_webhook_payload',
      ]);
      expect((await migrationStatus(db)).upToDate).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it('0004 makes active non-admin users editors of existing projects', async () => {
    const db = await createTestDb();
    try {
      await migrateDown(db);
      await migrateDown(db);
      await migrateDown(db);
      await migrateDown(db);
      await migrateDown(db); // back to 0003
      const ts = '2026-01-01T00:00:00.000Z';
      const user = (
        id: string,
        handle: string,
        role: string,
        kind: string,
        deactivated: string | null,
      ) =>
        sql`insert into users (id, handle, name, email, kind, role, avatar_url, created_at, updated_at, deactivated_at)
          values (${id}, ${handle}, ${handle}, null, ${kind}, ${role}, null, ${ts}, ${ts}, ${deactivated})`.execute(
          db.kysely,
        );
      await user('usr_m', 'm', 'member', 'human', null);
      await user('usr_bot', 'bot', 'member', 'agent', null);
      await user('usr_a', 'a', 'admin', 'human', null);
      await user('usr_gone', 'gone', 'member', 'human', ts);
      await sql`insert into projects (id, key, name, description, next_issue_number, created_at, updated_at, archived_at)
              values ('prj_1', 'ENG', 'Eng', '', 1, ${ts}, ${ts}, null)`.execute(db.kysely);
      await migrateToLatest(db);
      const rows = await sql<{ user_id: string; role: string }>`
      select user_id, role from project_members where project_id = 'prj_1' order by user_id`.execute(
        db.kysely,
      );
      expect(rows.rows).toEqual([
        { user_id: 'usr_bot', role: 'editor' },
        { user_id: 'usr_m', role: 'editor' },
      ]);
      const vis = await sql<{ visibility: string }>`select visibility from projects`.execute(
        db.kysely,
      );
      expect(vis.rows).toEqual([{ visibility: 'private' }]);
    } finally {
      await db.destroy();
    }
  });

  it('0004 does not make the system user a member of existing projects', async () => {
    const db = await createTestDb();
    try {
      await migrateDown(db);
      await migrateDown(db);
      await migrateDown(db);
      await migrateDown(db);
      await migrateDown(db); // back to 0003
      const ts = '2026-01-01T00:00:00.000Z';
      // Even a system user whose role is `member` (the built-in one is an admin) must be skipped.
      for (const [id, handle, role, kind] of [
        ['usr_sys', 'sys', 'member', 'system'],
        ['usr_human', 'human', 'member', 'human'],
      ] as const)
        await sql`insert into users (id, handle, name, email, kind, role, avatar_url, created_at, updated_at, deactivated_at)
          values (${id}, ${handle}, ${handle}, null, ${kind}, ${role}, null, ${ts}, ${ts}, null)`.execute(
          db.kysely,
        );
      await sql`insert into projects (id, key, name, description, next_issue_number, created_at, updated_at, archived_at)
              values ('prj_1', 'ENG', 'Eng', '', 1, ${ts}, ${ts}, null)`.execute(db.kysely);
      await migrateToLatest(db);
      const rows = await sql<{ user_id: string }>`
        select user_id from project_members order by user_id`.execute(db.kysely);
      expect(rows.rows).toEqual([{ user_id: 'usr_human' }]);
    } finally {
      await db.destroy();
    }
  });
});

describe(`migration 0006 (${dialect})`, () => {
  it('ends the sessions of users with an SSO identity, and keeps the rest', async () => {
    const db = await createTestDb();
    try {
      await migrateDown(db);
      await migrateDown(db);
      await migrateDown(db); // back to 0005
      const ts = '2026-01-01T00:00:00.000Z';
      const later = '2026-02-01T00:00:00.000Z';
      for (const id of ['usr_sso', 'usr_token'])
        await sql`insert into users (id, handle, name, email, kind, role, avatar_url, created_at, updated_at, deactivated_at)
          values (${id}, ${id}, ${id}, null, 'human', 'member', null, ${ts}, ${ts}, null)`.execute(
          db.kysely,
        );
      await sql`insert into user_identities (issuer, subject, user_id, created_at)
        values ('https://auth.example.test', 's1', 'usr_sso', ${ts})`.execute(db.kysely);
      for (const [id, user] of [
        ['ses_a', 'usr_sso'],
        ['ses_b', 'usr_sso'],
        ['ses_c', 'usr_token'],
      ] as const)
        await sql`insert into sessions (id, user_id, created_at, expires_at)
          values (${id}, ${user}, ${ts}, ${later})`.execute(db.kysely);
      expect(await migrateToLatest(db)).toEqual([
        '0006_end_sso_users_sessions',
        '0007_drop_api_tokens',
        '0008_webhook_payload',
      ]);
      const rows = await sql<{ id: string }>`select id from sessions order by id`.execute(
        db.kysely,
      );
      expect(rows.rows).toEqual([{ id: 'ses_c' }]);
    } finally {
      await db.destroy();
    }
  });
});

describe(`migration 0007 (${dialect})`, () => {
  it('drops api_tokens', async () => {
    const db = await createTestDb();
    try {
      await expect(sql`select count(*) from api_tokens`.execute(db.kysely)).rejects.toThrow();
    } finally {
      await db.destroy();
    }
  });
});

describe.runIf(dialect === 'sqlite')('multi-process SQLite writes', () => {
  it('serializes writers from several processes without SQLITE_BUSY', async () => {
    const db = await createTestDb({ file: true });
    try {
      await seedBasics(db, 'CONC');
      const script = fileURLToPath(new URL('./__fixtures__/concurrent-writer.ts', import.meta.url));
      const run = promisify(execFile);
      await Promise.all(
        Array.from({ length: 4 }, () => run(process.execPath, [script, db.url, '25'])),
      );
      const row = await db.kysely
        .selectFrom('projects')
        .select('next_issue_number')
        .where('key', '=', 'CONC')
        .executeTakeFirstOrThrow();
      expect(row.next_issue_number).toBe(1 + 4 * 25);
    } finally {
      await db.destroy();
    }
  }, 30_000);
});

describe.runIf(dialect === 'postgres')('Postgres connection loss', () => {
  it('survives the server terminating idle pool connections', async () => {
    const db = await createTestDb();
    try {
      // Warm the pool so it holds an idle connection, then have another session kill it.
      await sql`select 1`.execute(db.kysely);
      const killer = new pg.Client({ connectionString: db.url });
      await killer.connect();
      try {
        const killed = await killer.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
        );
        expect(killed.rowCount).toBeGreaterThan(0);
      } finally {
        await killer.end();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db.kysely);
      expect(rows[0]?.one).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});

describe('pgTimestampToIso', () => {
  it.each([
    ['2026-09-26 13:49:00.123+00', '2026-09-26T13:49:00.123Z'],
    ['2026-09-26 13:49:00+00', '2026-09-26T13:49:00.000Z'],
    ['2026-09-26 13:49:00.5+00', '2026-09-26T13:49:00.500Z'],
    ['2026-09-26 15:49:00.123+02', '2026-09-26T13:49:00.123Z'],
    ['2026-09-26 13:49:00.123', '2026-09-26T13:49:00.123Z'],
  ])('%s → %s', (input, expected) => {
    expect(pgTimestampToIso(input)).toBe(expected);
  });
});
