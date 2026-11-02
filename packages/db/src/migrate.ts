import type { Kysely } from 'kysely';
import { type Migration, type MigrationResultSet, Migrator } from 'kysely/migration';
import type { Db, Dialect } from './dialect.ts';
import { migration0001 } from './migrations/0001_init.ts';
import { migration0002 } from './migrations/0002_webhook_delivery_details.ts';
import { migration0003 } from './migrations/0003_user_identities.ts';
import { migration0004 } from './migrations/0004_project_access.ts';
import { migration0005 } from './migrations/0005_user_owner.ts';
import { migration0006 } from './migrations/0006_end_sso_users_sessions.ts';
import { migration0007 } from './migrations/0007_drop_api_tokens.ts';
import { migration0008 } from './migrations/0008_webhook_payload.ts';

/**
 * All migrations, in order. Migrations are registered in code (not discovered from the filesystem)
 * so they survive bundling. Names are permanent — never rename or reorder existing entries.
 */
function allMigrations(dialect: Dialect): Record<string, Migration> {
  return {
    '0001_init': migration0001(dialect),
    '0002_webhook_delivery_details': migration0002(dialect),
    '0003_user_identities': migration0003(dialect),
    '0004_project_access': migration0004(dialect),
    '0005_user_owner': migration0005(dialect),
    '0006_end_sso_users_sessions': migration0006(dialect),
    '0007_drop_api_tokens': migration0007(dialect),
    '0008_webhook_payload': migration0008(dialect),
  };
}

/** Name of the newest migration this build knows about. */
export function latestMigrationName(): string {
  const names = Object.keys(allMigrations('sqlite'));
  return names[names.length - 1]!;
}

function migrator(db: Db): Migrator {
  return new Migrator({
    db: db.kysely as unknown as Kysely<unknown>,
    provider: { getMigrations: async () => allMigrations(db.dialect) },
  });
}

function unwrap(result: MigrationResultSet): string[] {
  if (result.error) {
    const failed = result.results?.find((r) => r.status === 'Error');
    const detail = failed ? ` (migration ${failed.migrationName})` : '';
    throw new Error(`Migration failed${detail}: ${String(result.error)}`, { cause: result.error });
  }
  return (result.results ?? []).map((r) => r.migrationName);
}

/** Applies all pending migrations. Returns the names applied. */
export async function migrateToLatest(db: Db): Promise<string[]> {
  return unwrap(await migrator(db).migrateToLatest());
}

/** Reverts the most recent migration. Returns the names reverted. */
export async function migrateDown(db: Db): Promise<string[]> {
  return unwrap(await migrator(db).migrateDown());
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  upToDate: boolean;
}

export async function migrationStatus(db: Db): Promise<MigrationStatus> {
  const infos = await migrator(db).getMigrations();
  const applied = infos.filter((m) => m.executedAt).map((m) => m.name);
  const pending = infos.filter((m) => !m.executedAt).map((m) => m.name);
  return { applied, pending, upToDate: pending.length === 0 };
}

/** A fingerprint of the migration set, used to key cached test templates. */
export function migrationsFingerprint(): string {
  const source = Object.entries(allMigrations('postgres'))
    .map(([name, m]) => `${name}:${m.up.toString()}`)
    .join('\n');
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (Math.imul(31, hash) + source.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
