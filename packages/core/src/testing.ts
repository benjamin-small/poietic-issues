import { createTestDb, type TestDb } from '@poietic-tech/issues-db/testing';
import { newId } from '@poietic-tech/issues-schema';
import { type Actor, type Clock, type ServiceContext, SYSTEM_ACTOR, withActor } from './context.ts';
import { ensureBuiltins } from './services/bootstrap.ts';
import { createUserUnchecked, toActor } from './services/users.ts';

/** A clock that starts at a fixed instant and advances 1ms per call — deterministic and strictly increasing. */
export function steppingClock(
  start = '2026-01-01T00:00:00.000Z',
): Clock & { advance(ms: number): void } {
  let t = Date.parse(start);
  return {
    now: () => new Date(t++),
    advance(ms: number) {
      t += ms;
    },
  };
}

export interface TestContext {
  db: TestDb;
  /** Context acting as an admin human (`admin`). */
  ctx: ServiceContext;
  admin: Actor;
  /** Context acting as a member human (`member`). */
  member: ServiceContext;
  /** Context acting as an agent (`bot`). */
  agent: ServiceContext;
  destroy(): Promise<void>;
}

/** Migrated database (dialect from TEST_DB) with builtins and three users. */
export async function createTestContext(): Promise<TestContext> {
  const db = await createTestDb();
  const clock = steppingClock();
  await ensureBuiltins(db, clock);
  const base: ServiceContext = { db, actor: SYSTEM_ACTOR, clock, ids: newId };
  const admin = toActor(
    await createUserUnchecked(base, { handle: 'admin', name: 'Admin', role: 'admin' }),
  );
  const member = toActor(await createUserUnchecked(base, { handle: 'member', name: 'Member' }));
  const agent = toActor(
    await createUserUnchecked(base, { handle: 'bot', name: 'Bot', kind: 'agent' }),
  );
  return {
    db,
    ctx: withActor(base, admin),
    admin,
    member: withActor(base, member),
    agent: withActor(base, agent),
    destroy: () => db.destroy(),
  };
}

/** Test helper: gives `who` a role on a project, writing directly (no permission check, no event). */
export async function grant(
  t: TestContext,
  projectRef: string,
  who: ServiceContext,
  role: 'viewer' | 'editor' | 'manager',
): Promise<void> {
  const project = await t.db.kysely
    .selectFrom('projects')
    .select('id')
    .where((eb) => eb.or([eb('id', '=', projectRef), eb('key', '=', projectRef.toUpperCase())]))
    .executeTakeFirstOrThrow();
  const now = t.ctx.clock.now().toISOString();
  await t.db.kysely
    .insertInto('project_members')
    .values({
      project_id: project.id,
      user_id: who.actor.id,
      role,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['project_id', 'user_id']).doUpdateSet({ role, updated_at: now }),
    )
    .execute();
}

/** Test helper: gives an auth group a role on a project, writing directly (no permission check, no event). */
export async function grantGroup(
  t: TestContext,
  projectRef: string,
  group: string,
  role: 'viewer' | 'editor' | 'manager',
): Promise<void> {
  const project = await t.db.kysely
    .selectFrom('projects')
    .select('id')
    .where((eb) => eb.or([eb('id', '=', projectRef), eb('key', '=', projectRef.toUpperCase())]))
    .executeTakeFirstOrThrow();
  const now = t.ctx.clock.now().toISOString();
  await t.db.kysely
    .insertInto('project_group_grants')
    .values({ project_id: project.id, group_slug: group, role, created_at: now, updated_at: now })
    .onConflict((oc) =>
      oc.columns(['project_id', 'group_slug']).doUpdateSet({ role, updated_at: now }),
    )
    .execute();
}
