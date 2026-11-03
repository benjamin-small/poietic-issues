import { type Database, type Kysely, withWriteTx } from '@poietic-tech/issues-db';
import {
  type AddProjectMemberInput,
  AddProjectMemberInputSchema,
  GroupSlugSchema,
  type ProjectGroupGrant,
  type ProjectMember,
  type SetProjectGroupGrantInput,
  SetProjectGroupGrantInputSchema,
  type UpdateProjectMemberInput,
  UpdateProjectMemberInputSchema,
} from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { conflict, isUniqueViolation, notFound, parseInput } from '../errors.ts';
import { recordEvent } from '../events.ts';
import { getProjectRow, getUserRow } from '../refs.ts';
import { toUserOwner, toUserSummary } from '../mappers.ts';

type Exec = Kysely<Database>;

async function memberRows(db: Exec, projectId: string, userId?: string): Promise<ProjectMember[]> {
  let q = db
    .selectFrom('project_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .leftJoin('users as o', 'o.id', 'u.owner_id')
    .select([
      'm.role',
      'm.created_at',
      'm.updated_at',
      'u.id',
      'u.handle',
      'u.name',
      'u.kind',
      'u.avatar_url',
      'u.owner_id',
      'o.handle as owner_handle',
    ])
    .where('m.project_id', '=', projectId)
    .orderBy('u.handle');
  if (userId) q = q.where('m.user_id', '=', userId);
  return (await q.execute()).map((r): ProjectMember => ({
    user: toUserSummary(
      { id: r.id, handle: r.handle, name: r.name, kind: r.kind, avatarUrl: r.avatar_url },
      toUserOwner(r.owner_id, r.owner_handle),
    ),
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Members of a project, ordered by handle. Anyone who can read the project can see them. */
export async function listMembers(
  ctx: ServiceContext,
  projectRef: string,
): Promise<ProjectMember[]> {
  const project = await getProjectRow(ctx, ctx.db.kysely, projectRef, 'read');
  return memberRows(ctx.db.kysely, project.id);
}

/** Adds a user to a project with a role. Managers only; CONFLICT if they already are a member. */
export async function addMember(
  ctx: ServiceContext,
  projectRef: string,
  input: AddProjectMemberInput,
): Promise<ProjectMember> {
  const data = parseInput(AddProjectMemberInputSchema, input);
  let alreadyMember = '';
  try {
    return await withWriteTx(ctx.db, async (tx) => {
      const project = await getProjectRow(ctx, tx, projectRef, 'manage');
      const user = await getUserRow(ctx, tx, data.user);
      alreadyMember = `@${user.handle} is already a member of ${project.key}`;
      const now = nowIso(ctx);
      await tx
        .insertInto('project_members')
        .values({
          project_id: project.id,
          user_id: user.id,
          role: data.role,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const [member] = await memberRows(tx, project.id, user.id);
      await recordEvent(tx, ctx, 'project.member_added', {
        projectId: project.id,
        data: { member },
      });
      return member!;
    });
  } catch (error) {
    // The (project, user) primary key catches a concurrent add as well as an existing membership.
    if (isUniqueViolation(error)) throw conflict(alreadyMember);
    throw error;
  }
}

/** Changes a member's role. Managers only. An unchanged role writes nothing and records no event. */
export async function updateMember(
  ctx: ServiceContext,
  projectRef: string,
  userRef: string,
  input: UpdateProjectMemberInput,
): Promise<ProjectMember> {
  const data = parseInput(UpdateProjectMemberInputSchema, input);
  return withWriteTx(ctx.db, async (tx) => {
    const project = await getProjectRow(ctx, tx, projectRef, 'manage');
    const user = await getUserRow(ctx, tx, userRef);
    const [before] = await memberRows(tx, project.id, user.id);
    if (!before) throw notFound('Member', userRef);
    if (before.role === data.role) return before;
    await tx
      .updateTable('project_members')
      .set({ role: data.role, updated_at: nowIso(ctx) })
      .where('project_id', '=', project.id)
      .where('user_id', '=', user.id)
      .execute();
    const [member] = await memberRows(tx, project.id, user.id);
    await recordEvent(tx, ctx, 'project.member_changed', {
      projectId: project.id,
      data: { member, previousRole: before.role },
    });
    return member!;
  });
}

/** Removes a member from a project. Managers only. */
export async function removeMember(
  ctx: ServiceContext,
  projectRef: string,
  userRef: string,
): Promise<void> {
  await withWriteTx(ctx.db, async (tx) => {
    const project = await getProjectRow(ctx, tx, projectRef, 'manage');
    const user = await getUserRow(ctx, tx, userRef);
    const [member] = await memberRows(tx, project.id, user.id);
    if (!member) throw notFound('Member', userRef);
    await tx
      .deleteFrom('project_members')
      .where('project_id', '=', project.id)
      .where('user_id', '=', user.id)
      .execute();
    await recordEvent(tx, ctx, 'project.member_removed', {
      projectId: project.id,
      data: { member },
    });
  });
}

async function grantRows(
  db: Exec,
  projectId: string,
  group?: string,
): Promise<ProjectGroupGrant[]> {
  let q = db
    .selectFrom('project_group_grants')
    .select(['group_slug', 'role', 'created_at', 'updated_at'])
    .where('project_id', '=', projectId)
    .orderBy('group_slug');
  if (group) q = q.where('group_slug', '=', group);
  return (await q.execute()).map((r): ProjectGroupGrant => ({
    group: r.group_slug,
    role: r.role,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Group grants of a project, ordered by group. Anyone who can read the project can see them. */
export async function listGroupGrants(
  ctx: ServiceContext,
  projectRef: string,
): Promise<ProjectGroupGrant[]> {
  const project = await getProjectRow(ctx, ctx.db.kysely, projectRef, 'read');
  return grantRows(ctx.db.kysely, project.id);
}

/**
 * Gives an auth group a role on a project (an upsert). Managers only. Records `_added` for a new grant and
 * `_changed` for a new role; the same role again writes nothing and records no event.
 */
export async function setGroupGrant(
  ctx: ServiceContext,
  projectRef: string,
  groupRef: string,
  input: SetProjectGroupGrantInput,
): Promise<ProjectGroupGrant> {
  const group = parseInput(GroupSlugSchema, groupRef);
  const data = parseInput(SetProjectGroupGrantInputSchema, input);
  // A concurrent first grant of the same group loses the insert to the primary key; retry as an update.
  for (let attempt = 0; ; attempt++) {
    try {
      return await withWriteTx(ctx.db, async (tx) => {
        const project = await getProjectRow(ctx, tx, projectRef, 'manage');
        const [before] = await grantRows(tx, project.id, group);
        if (before?.role === data.role) return before;
        const now = nowIso(ctx);
        if (before) {
          await tx
            .updateTable('project_group_grants')
            .set({ role: data.role, updated_at: now })
            .where('project_id', '=', project.id)
            .where('group_slug', '=', group)
            .execute();
        } else {
          await tx
            .insertInto('project_group_grants')
            .values({
              project_id: project.id,
              group_slug: group,
              role: data.role,
              created_at: now,
              updated_at: now,
            })
            .execute();
        }
        const [grant] = await grantRows(tx, project.id, group);
        await recordEvent(
          tx,
          ctx,
          before ? 'project.group_grant_changed' : 'project.group_grant_added',
          {
            projectId: project.id,
            data: {
              project: { id: project.id, key: project.key },
              grant,
              ...(before && { previousRole: before.role }),
            },
          },
        );
        return grant!;
      });
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

/** Removes a group's grant on a project. Managers only; NOT_FOUND when the group has none. */
export async function removeGroupGrant(
  ctx: ServiceContext,
  projectRef: string,
  groupRef: string,
): Promise<void> {
  const group = parseInput(GroupSlugSchema, groupRef);
  await withWriteTx(ctx.db, async (tx) => {
    const project = await getProjectRow(ctx, tx, projectRef, 'manage');
    const [grant] = await grantRows(tx, project.id, group);
    if (!grant) throw notFound('Group grant', group);
    await tx
      .deleteFrom('project_group_grants')
      .where('project_id', '=', project.id)
      .where('group_slug', '=', group)
      .execute();
    await recordEvent(tx, ctx, 'project.group_grant_removed', {
      projectId: project.id,
      data: { project: { id: project.id, key: project.key }, grant },
    });
  });
}
