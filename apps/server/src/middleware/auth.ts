import {
  actorForUser,
  ANONYMOUS_ACTOR,
  authenticateSession,
  DomainError,
  signInWithSso,
  SYSTEM_ACTOR,
  toActor,
  type Actor,
  type ServiceContext,
} from '@poietic-tech/issues-core';
import { newId } from '@poietic-tech/issues-schema';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import {
  type AppEnv,
  LEGACY_SESSION_COOKIE,
  type ResolvedDeps,
  SESSION_COOKIE,
  type SsoOptions,
} from '../env.ts';
import type { Logger } from '../logger.ts';
import { problem } from '../problem.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Assigns a request id (honouring a client-supplied `X-Request-Id`) and echoes it back. */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id =
    incoming && /^[\w.:-]{1,100}$/.test(incoming)
      ? incoming
      : newId('event').replace('evt_', 'req_');
  c.set('requestId', id);
  await next();
  c.header('x-request-id', id);
});

/** Longest reason accepted, in characters (code points). */
export const CHANGE_REASON_MAX = 200;

/**
 * Reads a write's one-line reason from `X-Change-Reason` (percent-encoded UTF-8, since header values are Latin-1;
 * plain ASCII without `%` passes unchanged). Only writes carry one: on a read the header is ignored. A malformed,
 * multi-line or over-long reason is refused, so nothing is recorded without it; a blank one is no reason.
 */
export const changeReason = createMiddleware<AppEnv>(async (c, next) => {
  const raw = UNSAFE.has(c.req.method) ? c.req.header('x-change-reason') : undefined;
  if (raw !== undefined) {
    let reason: string | undefined;
    try {
      // Header bytes arrive as Latin-1, so unencoded non-ASCII would be stored garbled: refuse it instead.
      reason = /^[\x20-\x7E]*$/.test(raw) ? decodeURIComponent(raw).trim() : undefined;
    } catch {
      reason = undefined;
    }
    if (
      reason === undefined ||
      [...reason].length > CHANGE_REASON_MAX ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(reason)
    )
      return problem(
        c,
        'VALIDATION_FAILED',
        `X-Change-Reason must be one line of at most ${CHANGE_REASON_MAX} characters, percent-encoded UTF-8`,
      );
    if (reason) c.set('changeReason', reason);
  }
  await next();
});

/**
 * Resolves the actor from a bearer identity token, a session cookie, or (trusted mode) configuration, and builds the
 * per-request ServiceContext. Without credentials (or with a stale session cookie) the context acts as the
 * anonymous actor, which can read public projects only (ADR 0021). Cookie-authenticated unsafe requests must
 * be same-origin (CSRF protection); bearer requests carry no ambient credentials and are exempt.
 *
 * A bearer value is always an identity token from the SSO issuer (an agent's, usually; ADR 0023): it is verified when
 * SSO is configured and is a 401 otherwise. The header decides on its own: an invalid bearer is a 401 and never falls
 * back to the session cookie. With a liveness check configured, an identity-token request is also refused (401) once
 * the issuer says the token's session has ended.
 */
export function authenticate(deps: ResolvedDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const db = deps.getDb();
    const clock = deps.clock ?? { now: () => new Date() };
    let actor = null;
    let via: AppEnv['Variables']['authVia'] = null;
    let expiresAt: Date | null = null;
    let stillLive: (() => Promise<boolean>) | null = null;

    if (deps.auth.mode === 'trusted') {
      actor = await actorForUser({ db, actor: SYSTEM_ACTOR }, deps.auth.actor);
      if (!actor)
        return problem(
          c,
          'UNAUTHENTICATED',
          `Local actor "${deps.auth.actor}" not found or deactivated`,
        );
      via = 'trusted';
    } else {
      const header = c.req.header('authorization');
      if (header) {
        const value = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
        const sso = deps.auth.sso;
        if (value && sso) {
          const identity = await identityActor(
            { db, clock, ids: deps.ids ?? newId, requestId: c.get('requestId') },
            sso,
            value,
            c.get('logger'),
          );
          actor = identity?.actor ?? null;
          expiresAt = identity?.expiresAt ?? null;
          via = 'identity';
          if (actor && sso.liveness) {
            stillLive = () => sessionIsLive(sso, value, clock.now(), c.get('logger'));
            if (!(await stillLive()))
              return problem(c, 'UNAUTHENTICATED', 'The session behind this token has ended');
          }
        }
        if (!actor) return problem(c, 'UNAUTHENTICATED', 'Invalid, expired or revoked token');
      } else {
        const cookie = getCookie(c, SESSION_COOKIE) ?? getCookie(c, LEGACY_SESSION_COOKIE);
        if (cookie) {
          const session = await authenticateSession({ db, clock }, cookie);
          actor = session?.actor ?? null;
          if (session) {
            via = 'session';
            expiresAt = new Date(session.expiresAt);
            if (UNSAFE.has(c.req.method) && !sameOrigin(c.req.raw, deps.auth.allowedOrigins ?? []))
              return problem(c, 'FORBIDDEN', 'Cross-origin request rejected (CSRF protection)');
          }
        }
      }
    }

    c.set('actor', actor);
    c.set('authVia', via);
    c.set('credentialExpiresAt', expiresAt);
    c.set('credentialStillLive', stillLive);
    c.set('ctx', {
      db,
      actor: actor ?? ANONYMOUS_ACTOR,
      clock,
      ids: deps.ids ?? newId,
      requestId: c.get('requestId'),
      ...(c.get('changeReason') !== undefined && { reason: c.get('changeReason') }),
    });
    await next();
  });
}

/**
 * Resolves an SSO identity token to its actor and expiry, provisioning the user (or agent) on first use, or null when
 * the token does not verify. Throws UNAVAILABLE when the issuer's keys can't be fetched and PENDING_APPROVAL for an
 * inactive user.
 */
async function identityActor(
  deps: Omit<ServiceContext, 'actor'>,
  sso: SsoOptions,
  token: string,
  logger: Logger,
): Promise<{ actor: Actor; expiresAt: Date } | null> {
  let claims;
  try {
    claims = await sso.verifier.verify(token);
  } catch (error) {
    logger.warn({ err: error }, 'SSO identity token verification failed');
    throw new DomainError('UNAVAILABLE', `Could not reach ${sso.name} to verify the token`);
  }
  if (!claims) return null;
  const { user, status } = await signInWithSso(
    { ...deps, actor: SYSTEM_ACTOR },
    {
      issuer: sso.issuer,
      subject: claims.sub,
      name: claims.name,
      handle: claims.handle,
      role: claims.role,
      groups: claims.groups,
      kind: claims.kind,
      owner: claims.owner,
    },
    { adminRole: sso.adminRole, memberGroup: sso.memberGroup },
  );
  if (status === 'owner_inactive')
    throw new DomainError('PENDING_APPROVAL', `@${user.handle}'s owner is deactivated`);
  if (status === 'pending')
    throw new DomainError(
      'PENDING_APPROVAL',
      `@${user.handle} is waiting for an admin to approve access`,
    );
  return { actor: toActor(user), expiresAt: new Date(claims.exp * 1000) };
}

/**
 * Whether the issuer still vouches for an identity token's session, asked on every identity-token request (and
 * before `POST /auth/sso` trades the token for a tracker session) so a revoked session stops within the liveness
 * cache's lifetime rather than the token's. Fails closed: an issuer that can't be asked is a 503, as when its keys can't be fetched.
 */
export async function sessionIsLive(
  sso: SsoOptions,
  token: string,
  now: Date,
  logger: Logger,
): Promise<boolean> {
  try {
    return await sso.liveness!.isLive(token, now);
  } catch (error) {
    logger.warn({ err: error }, 'SSO session liveness check failed');
    throw new DomainError('UNAVAILABLE', `Could not reach ${sso.name} to check the session`);
  }
}

/** Anonymous requests may read (core decides what is visible, ADR 0021); everything else needs a user. */
export const requireActor = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('actor') && c.req.method !== 'GET' && c.req.method !== 'HEAD')
    return problem(
      c,
      'UNAUTHENTICATED',
      'Authenticate with "Authorization: Bearer <token>" or sign in',
    );
  await next();
});

export function sameOrigin(request: Request, allowed: string[]): boolean {
  const target = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin) return origin === target || allowed.includes(origin);
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const ref = new URL(referer).origin;
      return ref === target || allowed.includes(ref);
    } catch {
      return false;
    }
  }
  // Non-browser clients (no Origin/Referer/Sec-Fetch-*) cannot be CSRF vectors.
  return true;
}
