import { createHash, randomBytes } from 'node:crypto';
import { withWriteTx } from '@poietic-tech/issues-db';
import { type Actor, type ServiceContext } from '../context.ts';
import { getUserRow } from '../refs.ts';
import { toActor } from './users.ts';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Creates a web session lasting `ttlMs` (30 days by default; SSO sign-ins pass a short one and renew it) and returns
 * the cookie value (only its hash is stored). The user's expired sessions are dropped on the way, so short sessions
 * renewed all day do not pile up.
 */
export async function createSession(
  ctx: Pick<ServiceContext, 'db' | 'clock'>,
  userId: string,
  ttlMs: number = SESSION_TTL_MS,
  groups: readonly string[] = [],
): Promise<{ cookie: string; expiresAt: string }> {
  const cookie = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  await withWriteTx(ctx.db, async (tx) => {
    await tx
      .deleteFrom('sessions')
      .where('user_id', '=', userId)
      .where('expires_at', '<=', now.toISOString())
      .execute();
    await tx
      .insertInto('sessions')
      .values({
        id: sha256(cookie),
        user_id: userId,
        created_at: now.toISOString(),
        expires_at: expiresAt,
        groups: JSON.stringify(groups),
      })
      .execute();
  });
  return { cookie, expiresAt };
}

/** The groups column is JSON written by `createSession`; anything that isn't an array of strings means none. */
function parseGroups(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((g) => typeof g === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

/** The session's user and when the session ends, or null for an unknown, expired or deactivated one. */
export async function authenticateSession(
  ctx: Pick<ServiceContext, 'db' | 'clock'>,
  cookie: string,
): Promise<{ actor: Actor; expiresAt: string } | null> {
  const row = await ctx.db.kysely
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .selectAll('users')
    .select(['sessions.expires_at as session_expires_at', 'sessions.groups as session_groups'])
    .where('sessions.id', '=', sha256(cookie))
    .executeTakeFirst();
  if (!row || row.deactivated_at || row.session_expires_at <= ctx.clock.now().toISOString())
    return null;
  return {
    actor: toActor(row, parseGroups(row.session_groups)),
    expiresAt: row.session_expires_at,
  };
}

export async function deleteSession(
  ctx: Pick<ServiceContext, 'db'>,
  cookie: string,
): Promise<void> {
  await withWriteTx(ctx.db, (tx) =>
    tx.deleteFrom('sessions').where('id', '=', sha256(cookie)).execute(),
  );
}

/** Resolves a user for dev login / trusted local mode. Returns null if missing or deactivated. */
export async function actorForUser(
  ctx: Pick<ServiceContext, 'db' | 'actor'>,
  ref: string,
): Promise<Actor | null> {
  const row = await getUserRow(ctx, ctx.db.kysely, ref).catch(() => undefined);
  if (!row || row.deactivated_at) return null;
  return toActor(row);
}
