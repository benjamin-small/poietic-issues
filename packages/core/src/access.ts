import { type Principal, definePolicy } from '@poietic-tech/access';
import { type Database, type Kysely, type RawBuilder, sql } from '@poietic-tech/issues-db';
import type { Actor, ServiceContext } from './context.ts';
import { DomainError, forbidden, notFound } from './errors.ts';

type Exec = Kysely<Database>;

/**
 * The tracker's access policy (ADR 0021, decided by `@poietic-tech/access`): ordered levels, the level each
 * project role gives, and the bypass for admins and the system actor.
 */
export const issuesPolicy = definePolicy({
  levels: ['none', 'read', 'write', 'manage'],
  roles: { viewer: 'read', editor: 'write', manager: 'manage' },
  adminRole: 'admin',
  unrestrictedKinds: ['system'],
});

/** Access an actor has to one project (ADR 0021). Ordered: each level includes the ones before it. */
export type AccessLevel = (typeof issuesPolicy.levels)[number];
type Role = keyof typeof issuesPolicy.roles;
/** Roles that grant at least `write` (the public floor is only `read`). */
const WRITE_ROLES = (Object.keys(issuesPolicy.roles) as Role[]).filter((r) =>
  issuesPolicy.atLeast(issuesPolicy.levelOfRole(r), 'write'),
);

/** The actor as the access library sees them. */
export function principalOf(actor: Actor): Principal {
  return {
    id: actor.id,
    kind: actor.kind,
    role: actor.role,
    groups: actor.groups,
  };
}

export function atLeast(have: AccessLevel, need: AccessLevel): boolean {
  return issuesPolicy.atLeast(have, need);
}

/** Admins and the system actor: every project at `manage`. */
export function unrestricted(ctx: ServiceContext): boolean {
  return ctx.actor.role === 'admin' || ctx.actor.kind === 'system';
}

type Visibility = 'public' | 'private';
type Grant = { to: { user: string } | { group: string }; role: string };

/** The groups a group grant can match: the actor's own, none for anonymous, empty slugs dropped. */
function groupsOf(ctx: ServiceContext): readonly string[] {
  return issuesPolicy.subjects(principalOf(ctx.actor)).groups;
}

/** A non-admin's level: the higher of their role's level and the public floor. */
function levelOf(
  ctx: ServiceContext,
  visibility: Visibility,
  role: string | undefined,
  groupGrants: readonly { group_slug: string; role: string }[] = [],
): AccessLevel {
  const grants: Grant[] = groupGrants.map((g) => ({ to: { group: g.group_slug }, role: g.role }));
  if (role) grants.push({ to: { user: ctx.actor.id }, role });
  return issuesPolicy.resolve(principalOf(ctx.actor), {
    floor: visibility === 'public' ? 'read' : 'none',
    grants,
  });
}

export async function projectLevel(
  ctx: ServiceContext,
  db: Exec,
  project: { id: string; visibility: Visibility },
): Promise<AccessLevel> {
  if (unrestricted(ctx)) return 'manage';
  if (ctx.actor.kind === 'anonymous') return levelOf(ctx, project.visibility, undefined);
  const member = await db
    .selectFrom('project_members')
    .select('role')
    .where('project_id', '=', project.id)
    .where('user_id', '=', ctx.actor.id)
    .executeTakeFirst();
  const groups = groupsOf(ctx);
  const groupGrants = groups.length
    ? await db
        .selectFrom('project_group_grants')
        .select(['group_slug', 'role'])
        .where('project_id', '=', project.id)
        .where('group_slug', 'in', [...groups])
        .execute()
    : [];
  return levelOf(ctx, project.visibility, member?.role, groupGrants);
}

/** `projectLevel` for many projects, from one membership query and one group-grant query. Keyed by project id. */
export async function projectLevels(
  ctx: ServiceContext,
  db: Exec,
  projects: ReadonlyArray<{ id: string; visibility: Visibility }>,
): Promise<Map<string, AccessLevel>> {
  if (unrestricted(ctx)) return new Map(projects.map((p) => [p.id, 'manage']));
  const roles = new Map<string, string>();
  if (ctx.actor.kind !== 'anonymous' && projects.length) {
    const rows = await db
      .selectFrom('project_members')
      .select(['project_id', 'role'])
      .where('user_id', '=', ctx.actor.id)
      .execute();
    for (const r of rows) roles.set(r.project_id, r.role);
  }
  const groupGrants = new Map<string, { group_slug: string; role: string }[]>();
  const groups = groupsOf(ctx);
  if (groups.length && projects.length) {
    const rows = await db
      .selectFrom('project_group_grants')
      .select(['project_id', 'group_slug', 'role'])
      .where('group_slug', 'in', [...groups])
      .execute();
    for (const r of rows) {
      const list = groupGrants.get(r.project_id) ?? [];
      list.push(r);
      groupGrants.set(r.project_id, list);
    }
  }
  return new Map(
    projects.map((p) => [p.id, levelOf(ctx, p.visibility, roles.get(p.id), groupGrants.get(p.id))]),
  );
}

/**
 * Throws unless `have` reaches `need`. Below read, the resource is reported as not found, so private
 * projects don't reveal that they exist. Anonymous actors asking for more than read get UNAUTHENTICATED.
 */
export function requireLevel(
  ctx: ServiceContext,
  have: AccessLevel,
  need: Exclude<AccessLevel, 'none'>,
  what: string,
  ref: string,
): void {
  const outcome = issuesPolicy.check(principalOf(ctx.actor), have, need);
  if (outcome === 'ok') return;
  if (outcome === 'not_found') throw notFound(what, ref);
  if (outcome === 'unauthenticated')
    throw new DomainError('UNAUTHENTICATED', 'Sign in to make changes');
  throw forbidden(
    need === 'manage'
      ? 'Only project managers can do this'
      : 'You have read-only access to this project',
  );
}

/** Ids of projects the actor can read, or `'all'` for admins and the system actor. */
export async function readableProjectIds(ctx: ServiceContext, db: Exec): Promise<'all' | string[]> {
  if (unrestricted(ctx)) return 'all';
  const actor = ctx.actor;
  const groups = groupsOf(ctx);
  const rows = await db
    .selectFrom('projects')
    .select('id')
    .where((eb) =>
      actor.kind === 'anonymous'
        ? eb('visibility', '=', 'public')
        : eb.or([
            eb('visibility', '=', 'public'),
            eb(
              'id',
              'in',
              eb.selectFrom('project_members').select('project_id').where('user_id', '=', actor.id),
            ),
            ...(groups.length
              ? [
                  eb(
                    'id',
                    'in',
                    eb
                      .selectFrom('project_group_grants')
                      .select('project_id')
                      .where('group_slug', 'in', [...groups]),
                  ),
                ]
              : []),
          ]),
    )
    .execute();
  return rows.map((r) => r.id);
}

/**
 * Ids of projects the actor can write in, or `'all'` for admins and the system actor. Only a membership or group grant gives
 * write (direct, or through a group), so anonymous actors get none. Used to show soft-deleted content, which needs write.
 */
export async function writableProjectIds(ctx: ServiceContext, db: Exec): Promise<'all' | string[]> {
  if (unrestricted(ctx)) return 'all';
  if (ctx.actor.kind === 'anonymous') return [];
  const rows = await db
    .selectFrom('project_members')
    .select('project_id')
    .where('user_id', '=', ctx.actor.id)
    .where('role', 'in', WRITE_ROLES)
    .execute();
  const ids = new Set(rows.map((r) => r.project_id));
  const groups = groupsOf(ctx);
  if (groups.length) {
    const viaGroup = await db
      .selectFrom('project_group_grants')
      .select('project_id')
      .where('group_slug', 'in', [...groups])
      .where('role', 'in', WRITE_ROLES)
      .execute();
    for (const r of viaGroup) ids.add(r.project_id);
  }
  return [...ids];
}

/**
 * Adds "the project id in `column` is readable" to a query (e.g. `'i.project_id'`). Admins and the system
 * actor are unrestricted; an actor who can read nothing gets no rows. Pass `known` to reuse a
 * `readableProjectIds` result.
 */
export async function whereReadable<QB extends { where(expr: RawBuilder<boolean>): QB }>(
  ctx: ServiceContext,
  db: Exec,
  qb: QB,
  column: string,
  known?: 'all' | string[],
): Promise<QB> {
  const readable = known ?? (await readableProjectIds(ctx, db));
  if (readable === 'all') return qb;
  return qb.where(
    readable.length
      ? sql<boolean>`${sql.ref(column)} in (${sql.join(readable.map((id) => sql`${id}`))})`
      : sql<boolean>`1 = 0`,
  );
}
