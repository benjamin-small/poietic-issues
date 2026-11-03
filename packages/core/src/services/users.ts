import { type Database, type Kysely, type Tx, withWriteTx } from '@poietic-tech/issues-db';
import {
  type CreateUserInput,
  CreateUserInputSchema,
  type UpdateUserInput,
  UpdateUserInputSchema,
  type User,
} from '@poietic-tech/issues-schema';
import type { z } from 'zod';
import { type Actor, nowIso, type ServiceContext } from '../context.ts';
import { conflict, forbidden, isUniqueViolation, parseInput, validationError } from '../errors.ts';
import { diff, recordEvent } from '../events.ts';
import { toUser } from '../mappers.ts';
import { isAdmin, requireAdmin, requireSignedIn } from '../permissions.ts';
import { getUserRow } from '../refs.ts';

/** Handles that resolve to something else (`me` is the actor, `system` the system user). */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(['me', 'system']);

export function toActor(
  user: Pick<User, 'id' | 'handle' | 'name' | 'kind' | 'role'>,
  groups: readonly string[] = [],
): Actor {
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    kind: user.kind,
    role: user.role,
    groups,
  };
}

/** The handle of a user's owner, for `toUser`; null when the user has none. */
export async function ownerHandle(
  db: Kysely<Database>,
  ownerId: string | null,
): Promise<string | null> {
  if (!ownerId) return null;
  const owner = await db
    .selectFrom('users')
    .select('handle')
    .where('id', '=', ownerId)
    .executeTakeFirst();
  return owner?.handle ?? null;
}

/** Emails are private: only admins and the user themselves see them. */
function redact(ctx: ServiceContext, u: User): User {
  return isAdmin(ctx) || u.id === ctx.actor.id ? u : { ...u, email: null };
}

/** Lists users. Deactivated users are included only when asked. */
export async function listUsers(
  ctx: ServiceContext,
  opts: { includeDeactivated?: boolean } = {},
): Promise<User[]> {
  requireSignedIn(ctx, 'see users');
  let q = ctx.db.kysely
    .selectFrom('users as u')
    .leftJoin('users as o', 'o.id', 'u.owner_id')
    .selectAll('u')
    .select('o.handle as owner_handle')
    .where('u.kind', '!=', 'system')
    .orderBy('u.handle');
  if (!opts.includeDeactivated) q = q.where('u.deactivated_at', 'is', null);
  return (await q.execute()).map(({ owner_handle, ...r }) => redact(ctx, toUser(r, owner_handle)));
}

/** Gets a user by id, handle, `@handle` or `me`. */
export async function getUser(ctx: ServiceContext, ref: string): Promise<User> {
  requireSignedIn(ctx, 'see users');
  const row = await getUserRow(ctx, ctx.db.kysely, ref);
  return redact(ctx, toUser(row, await ownerHandle(ctx.db.kysely, row.owner_id)));
}

/** Creates a human or agent user. Admin only. */
export async function createUser(ctx: ServiceContext, input: CreateUserInput): Promise<User> {
  requireAdmin(ctx, 'create users');
  const data = parseInput(CreateUserInputSchema, input);
  return createUserUnchecked(ctx, data);
}

/** Creates a user without a permission check (bootstrap / seeding). */
export async function createUserUnchecked(
  ctx: ServiceContext,
  input: CreateUserInput,
): Promise<User> {
  const data = parseInput(CreateUserInputSchema, input);
  try {
    return await withWriteTx(ctx.db, (tx) => insertUser(tx, ctx, data));
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(`A user with handle "${data.handle}" or that email already exists`);
    throw error;
  }
}

/** Inserts a user inside an existing write transaction and records `user.created`. */
export async function insertUser(
  tx: Tx,
  ctx: ServiceContext,
  data: z.output<typeof CreateUserInputSchema>,
  opts: { deactivated?: boolean; ownerId?: string } = {},
): Promise<User> {
  const now = nowIso(ctx);
  const row = await tx
    .insertInto('users')
    .values({
      id: ctx.ids('user'),
      handle: data.handle,
      name: data.name,
      email: data.email ?? null,
      kind: data.kind,
      role: data.role,
      avatar_url: data.avatarUrl ?? null,
      created_at: now,
      updated_at: now,
      deactivated_at: opts.deactivated ? now : null,
      owner_id: opts.ownerId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const user = toUser(row, await ownerHandle(tx, row.owner_id));
  await recordEvent(tx, ctx, 'user.created', { data: { user } });
  return user;
}

/**
 * Updates a user. Admins can change anything, including the handle of a user not linked to an SSO identity; users can
 * change their own name, email and avatar.
 */
export async function updateUser(
  ctx: ServiceContext,
  ref: string,
  input: UpdateUserInput,
): Promise<User> {
  const patch = parseInput(UpdateUserInputSchema, input);
  if (patch.handle !== undefined && RESERVED_HANDLES.has(patch.handle))
    throw validationError(`"${patch.handle}" is a reserved handle`);
  try {
    return await withWriteTx(ctx.db, async (tx) => {
      const row = await getUserRow(ctx, tx, ref);
      if (patch.handle !== undefined && row.kind === 'system')
        throw forbidden('The system user cannot be renamed');
      if (patch.handle !== undefined && patch.handle !== row.handle) {
        const linked = await tx
          .selectFrom('user_identities')
          .select('issuer')
          .where('user_id', '=', row.id)
          .executeTakeFirst();
        // The issuer owns a linked user's handle (ADR 0031): the next sign-in or refresh would undo a rename here.
        if (linked)
          throw forbidden(`This user's handle comes from ${linked.issuer}; rename them there`);
      }
      const self = row.id === ctx.actor.id;
      const adminOnly =
        patch.handle !== undefined || patch.role !== undefined || patch.deactivated !== undefined;
      if (!isAdmin(ctx) && (!self || adminOnly))
        throw forbidden('You can only edit your own profile');
      const owner = await ownerHandle(tx, row.owner_id);
      const before = toUser(row, owner);
      const now = nowIso(ctx);
      const updated = await tx
        .updateTable('users')
        .set({
          ...(patch.handle !== undefined && { handle: patch.handle }),
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.email !== undefined && { email: patch.email }),
          ...(patch.role !== undefined && { role: patch.role }),
          ...(patch.avatarUrl !== undefined && { avatar_url: patch.avatarUrl }),
          ...(patch.deactivated !== undefined && {
            deactivated_at: patch.deactivated ? now : null,
          }),
          updated_at: now,
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const user = toUser(updated, owner);
      const changes = diff(before, user, [
        'handle',
        'name',
        'email',
        'role',
        'avatarUrl',
        'deactivatedAt',
      ]);
      if (Object.keys(changes).length > 0)
        await recordEvent(tx, ctx, 'user.updated', { data: { user, changes } });
      return user;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(`A user with handle "${patch.handle}" already exists`);
    throw error;
  }
}
