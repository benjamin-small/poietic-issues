import { createRoute, z } from '@hono/zod-openapi';
import {
  actorForUser,
  createSession,
  deleteSession,
  DomainError,
  getUser,
  isAnonymous,
  listUsers,
  signInWithSso,
  SYSTEM_ACTOR,
  withActor,
} from '@poietic-tech/issues-core';
import { MeSchema, UserSchema, UserSummarySchema } from '@poietic-tech/issues-schema';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { sameOrigin, sessionIsLive } from '../middleware/auth.ts';
import {
  type AppEnv,
  LEGACY_SESSION_COOKIE,
  type ResolvedDeps,
  SESSION_COOKIE,
  SSO_SESSION_TTL_MS,
  type TrackerApp,
} from '../env.ts';
import { errorResponses, json, jsonBody, noContent } from './common.ts';

const tags = ['Auth'];

const AuthConfigSchema = z
  .object({
    devLogin: z
      .boolean()
      .openapi({ description: 'Whether passwordless dev login is enabled (development only).' }),
    users: z
      .array(UserSummarySchema)
      .optional()
      .openapi({ description: 'Users to pick from (dev login only).' }),
    sso: z
      .object({
        name: z.string().openapi({ description: 'Label for the sign-in button.' }),
        loginUrl: z
          .string()
          .openapi({ description: 'Where to sign in; append `redirect=<this page>`.' }),
        refreshUrl: z.string().nullable().openapi({
          description:
            'Call with credentials before `POST /auth/sso` to renew a lapsed SSO cookie.',
        }),
        sessionSeconds: z
          .number()
          .int()
          .openapi({
            description:
              'How long a session from `POST /auth/sso` lasts. Renew it before then by calling `refreshUrl` and ' +
              '`POST /auth/sso` again; each renewal re-checks the issuer.',
          }),
      })
      .nullable()
      .openapi({ description: 'Single sign-on, when configured.' }),
  })
  .openapi('AuthConfig');

export function registerAuthRoutes(app: TrackerApp, deps: ResolvedDeps) {
  const devLogin = deps.auth.mode === 'standard' && deps.auth.allowDevLogin === true;
  const secure = deps.auth.mode === 'standard' && deps.auth.secureCookies === true;
  const sso = deps.auth.mode === 'standard' ? deps.auth.sso : undefined;
  const ssoInfo = sso
    ? {
        name: sso.name,
        loginUrl: sso.loginUrl,
        refreshUrl: sso.refreshUrl ?? null,
        sessionSeconds: Math.round((sso.sessionTtlMs ?? SSO_SESSION_TTL_MS) / 1000),
      }
    : null;

  /** Deletes the tracker sessions the request carries (current and pre-rename cookie names). */
  async function dropSessions(c: Context<AppEnv>) {
    for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
      const cookie = getCookie(c, name);
      if (cookie) await deleteSession(c.get('ctx'), cookie);
    }
  }

  async function startSession(
    c: Context<AppEnv>,
    userId: string,
    ttlMs?: number,
    groups: readonly string[] = [],
  ) {
    const ctx = c.get('ctx');
    const session = await createSession(ctx, userId, ttlMs, groups);
    setCookie(c, SESSION_COOKIE, session.cookie, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: secure || new URL(c.req.url).protocol === 'https:',
      path: '/',
      expires: new Date(session.expiresAt),
    });
  }

  app.openapi(
    createRoute({
      method: 'get',
      path: '/auth/config',
      tags,
      security: [],
      summary: 'How to sign in',
      description:
        'Public. Tells the web UI whether dev login is available (and the users to pick from).',
      responses: { 200: json(AuthConfigSchema, 'Auth configuration') },
    }),
    async (c) => {
      if (!devLogin) return c.json({ devLogin: false, sso: ssoInfo }, 200);
      // Signed-out visitors can't list users; the dev picker only needs public fields (no email).
      const users = await listUsers(withActor(c.get('ctx'), SYSTEM_ACTOR));
      return c.json(
        {
          devLogin: true,
          sso: ssoInfo,
          users: users.map(({ id, handle, name, kind, avatarUrl, owner }) => ({
            id,
            handle,
            name,
            kind,
            avatarUrl,
            owner,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/dev-login',
      tags,
      security: [],
      summary: 'Sign in as any user (development only)',
      description: 'Only available when the server runs with `POIETIC_ISSUES_AUTH_MODE=dev`.',
      request: {
        body: jsonBody(
          z
            .object({
              user: z.string().openapi({ description: 'User id or handle.', example: 'ada' }),
            })
            .openapi('DevLoginInput'),
        ),
      },
      responses: {
        200: json(UserSchema, 'Signed in'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => {
      if (!devLogin) throw new DomainError('FORBIDDEN', 'Dev login is disabled');
      const { user } = c.req.valid('json');
      const actor = await actorForUser(c.get('ctx'), user);
      if (!actor) throw new DomainError('NOT_FOUND', `User "${user}" not found`);
      await startSession(c, actor.id);
      return c.json(await getUser(withActor(c.get('ctx'), actor), actor.id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/sso',
      tags,
      security: [],
      summary: 'Sign in with single sign-on',
      description:
        "Exchanges the SSO issuer's cookie (sent automatically by the browser) for a short session " +
        '(`AuthConfig.sso.sessionSeconds`), replacing any session the request carries; call it again to renew. A first sign-in ' +
        "creates the user; users other than the issuer's admins wait for an admin to reactivate them " +
        '(`PENDING_APPROVAL`). Browser-only: must be same-origin. With a liveness check configured, a cookie whose issuer session has ended ' +
        "is `UNAUTHENTICATED`. `UNAVAILABLE` means the issuer's signing keys, or its liveness answer, could not be fetched.",
      responses: {
        200: json(UserSchema, 'Signed in'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND', 'PENDING_APPROVAL', 'UNAVAILABLE'),
      },
    }),
    async (c) => {
      if (!sso) throw new DomainError('NOT_FOUND', 'Single sign-on is not configured');
      if (
        !sameOrigin(
          c.req.raw,
          deps.auth.mode === 'standard' ? (deps.auth.allowedOrigins ?? []) : [],
        )
      )
        throw new DomainError('FORBIDDEN', 'Cross-origin request rejected (CSRF protection)');
      const token = getCookie(c, sso.cookie);
      let claims: Awaited<ReturnType<typeof sso.verifier.verify>> = null;
      if (token) {
        try {
          claims = await sso.verifier.verify(token);
        } catch (error) {
          c.get('logger').warn({ err: error }, 'SSO token verification failed');
          throw new DomainError('UNAVAILABLE', `Could not reach ${sso.name} to verify the sign-in`);
        }
      }
      if (!claims) throw new DomainError('UNAUTHENTICATED', `Not signed in to ${sso.name}`);
      // Agents act through identity tokens in the Authorization header; they never get a browser session.
      if (claims.kind !== 'human')
        throw new DomainError('FORBIDDEN', 'Agents cannot sign in to the web app');
      // The cookie's JWT outlives a sign-out at the issuer by up to its lifetime; a tracker session would outlive it
      // far longer, so ask the issuer before minting one.
      // A failed renewal also ends the session it was renewing.
      if (
        sso.liveness &&
        !(await sessionIsLive(sso, token!, c.get('ctx').clock.now(), c.get('logger')))
      ) {
        await dropSessions(c);
        throw new DomainError('UNAUTHENTICATED', `Not signed in to ${sso.name}`);
      }
      const ctx = withActor(c.get('ctx'), SYSTEM_ACTOR);
      const { user, status } = await signInWithSso(
        ctx,
        {
          issuer: sso.issuer,
          subject: claims.sub,
          name: claims.name,
          handle: claims.handle,
          role: claims.role,
          groups: claims.groups,
          kind: 'human',
          owner: null,
        },
        { adminRole: sso.adminRole, memberGroup: sso.memberGroup },
      );
      if (status !== 'active')
        throw new DomainError(
          'PENDING_APPROVAL',
          `@${user.handle} is waiting for an admin to approve access`,
        );
      // A renewal replaces the session it renews, so the old cookie stops working at once.
      await dropSessions(c);
      await startSession(c, user.id, sso.sessionTtlMs ?? SSO_SESSION_TTL_MS, claims.groups);
      return c.json(user, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/auth/logout',
      tags,
      security: [],
      summary: 'Sign out',
      responses: { 204: noContent },
    }),
    async (c) => {
      for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
        const cookie = getCookie(c, name);
        if (cookie) await deleteSession(c.get('ctx'), cookie);
        if (cookie) deleteCookie(c, name, { path: '/' });
      }
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags,
      summary: 'The authenticated user',
      description: 'Signed-out visitors get `{ "anonymous": true }` instead of a user.',
      responses: {
        200: json(MeSchema, 'Current user, or { anonymous: true }'),
        ...errorResponses(),
      },
    }),
    async (c) => {
      const ctx = c.get('ctx');
      if (isAnonymous(ctx)) return c.json({ anonymous: true as const }, 200);
      return c.json(await getUser(ctx, ctx.actor.id), 200);
    },
  );
}
