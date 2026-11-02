import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_PREFIX,
  type AppDeps,
  type AppEnv,
  type ResolvedDeps,
  SESSION_COOKIE,
  type TrackerApp,
} from './env.ts';
import { authenticate, changeReason, requestId, requireActor } from './middleware/auth.ts';
import { idempotency } from './middleware/idempotency.ts';
import { silentLogger } from './logger.ts';
import { sql } from '@poietic-tech/issues-db';
import { problem, problemFromError } from './problem.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCollaborationRoutes } from './routes/collaboration.ts';
import { registerIssueRoutes } from './routes/issues.ts';
import { registerFieldRoutes } from './routes/fields.ts';
import { registerMemberRoutes } from './routes/members.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerStreamRoute } from './routes/stream.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerWebhookRoutes } from './routes/webhooks.ts';

export const API_VERSION = '1.0.0';

export const OPENAPI_CONFIG: Parameters<TrackerApp['getOpenAPI31Document']>[0] = {
  openapi: '3.1.0',
  info: {
    title: 'Tracker API',
    version: API_VERSION,
    description: [
      'REST API of the tracker. Humans and AI agents use the same API; the `tracker` CLI and the web app are clients of it.',
      '',
      '**Conventions**',
      '- Authenticate with `Authorization: Bearer <identity token>` (from the SSO issuer) or the web session cookie.',
      '- Paths accept human references: issues as `ENG-42` or id, projects as `ENG` or id, users as `@handle`, `me` or id.',
      '- Lists return `{ data, nextCursor }`; pass `cursor` to continue.',
      '- Errors are RFC 9457 `application/problem+json` with a stable `code`.',
      '- Issues carry `version`; send `If-Match: "v<version>"` to avoid lost updates (412 `VERSION_MISMATCH`).',
      '- POST requests accept `Idempotency-Key` for safe retries.',
      '- Every change is recorded in the event log (`GET /events`) and delivered to webhooks.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }, { sessionCookie: [] }],
};

function resolveDeps(deps: AppDeps): ResolvedDeps {
  let db = typeof deps.db === 'function' ? undefined : deps.db;
  return {
    ...deps,
    auth: deps.auth ?? { mode: 'standard' },
    getDb() {
      if (!db) {
        if (typeof deps.db !== 'function') throw new Error('createApp: no database configured');
        db = deps.db();
      }
      return db;
    },
  };
}

/** The `/api/v1` sub-application: middleware, routes and the OpenAPI registry. */
function buildApi(resolved: ResolvedDeps): TrackerApp {
  const api: TrackerApp = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return problemFromError(c, result.error);
      return undefined;
    },
  });
  api.onError((error, c) => problemFromError(c, error));

  api.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description:
      "An identity token from the SSO issuer, such as an agent's. A new agent becomes a user owned by its (already " +
      'signed-in) owner. Without single sign-on configured, every bearer value is rejected. An invalid bearer value ' +
      'is a 401 rather than falling back to a session cookie.',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description: 'Web session from `/auth/sso` or `/auth/dev-login`.',
  });

  api.doc31('/openapi.json', OPENAPI_CONFIG);
  api.use('*', async (c, next) => {
    if (c.req.path === `${API_PREFIX}/openapi.json`) return next();
    return authenticate(resolved)(c, next);
  });
  api.use('*', async (c, next) => {
    const path = c.req.path;
    if (path.startsWith(`${API_PREFIX}/auth/`) || path === `${API_PREFIX}/openapi.json`)
      return next();
    return requireActor(c, next);
  });
  api.use('*', idempotency(resolved));

  registerAuthRoutes(api, resolved);
  registerUserRoutes(api, resolved);
  registerProjectRoutes(api);
  registerMemberRoutes(api);
  registerIssueRoutes(api);
  registerCollaborationRoutes(api);
  registerFieldRoutes(api);
  registerAttachmentRoutes(api, resolved);
  registerWebhookRoutes(api, resolved.webhooks ?? { allowPrivate: false });
  registerStreamRoute(api, resolved);
  for (const extension of resolved.extensions ?? []) extension(api, resolved);

  api.notFound((c) => problem(c, 'NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`));
  return api;
}

/**
 * Builds the HTTP app. Constructing it has no side effects (no database connection), so the same factory
 * serves the real server, the CLI's in-process local mode, tests, and OpenAPI generation.
 */
export function createApp(deps: AppDeps = {}): OpenAPIHono<AppEnv> {
  const resolved = resolveDeps(deps);
  const root = new OpenAPIHono<AppEnv>();
  root.onError((error, c) => problemFromError(c, error));
  const logger = deps.logger ?? silentLogger;
  root.use('*', requestId);
  root.use('*', changeReason);
  // Access log (health probes and static assets only at debug level).
  root.use('*', async (c, next) => {
    const started = performance.now();
    const log = logger.child({ reqId: c.get('requestId') });
    c.set('logger', log);
    await next();
    const path = c.req.path;
    const quiet = path === '/healthz' || path === '/readyz' || !path.startsWith('/api/');
    log[quiet ? 'debug' : 'info'](
      {
        method: c.req.method,
        path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        actor: c.var.actor?.handle,
      },
      'request',
    );
  });
  // Liveness: the process is serving. Readiness: it can reach the database and is not shutting down.
  root.get('/healthz', (c) => c.json({ ok: true }));
  root.get('/readyz', async (c) => {
    if (deps.shutdownSignal?.aborted) return c.json({ ok: false, reason: 'shutting down' }, 503);
    try {
      await sql`select 1`.execute(resolved.getDb().kysely);
      return c.json({ ok: true });
    } catch (error) {
      c.get('logger').warn({ err: error }, 'readiness check failed');
      return c.json({ ok: false, reason: 'database unavailable' }, 503);
    }
  });
  root.route(API_PREFIX, buildApi(resolved));
  root.get('/api/docs', Scalar({ url: `${API_PREFIX}/openapi.json`, pageTitle: 'Tracker API' }));

  if (deps.webDir) {
    const webDir = deps.webDir;
    // Content-hashed build assets never change; everything else must revalidate.
    root.use('/_app/immutable/*', async (c, next) => {
      await next();
      if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    root.use('/*', serveStatic({ root: webDir }));
    // SPA fallback: any other non-API path renders the app shell (read per request so a rebuild never
    // leaves a stale shell pointing at deleted assets).
    root.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) return problem(c, 'NOT_FOUND', 'Not found');
      c.header('Cache-Control', 'no-cache');
      return c.html(readFileSync(join(webDir, 'index.html'), 'utf8'));
    });
  }
  root.notFound((c) => problem(c, 'NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`));
  return root;
}

/** The OpenAPI 3.1 document, generated from the route definitions without a database. */
export function generateOpenApiDocument(
  extensions: AppDeps['extensions'] = [],
): Record<string, unknown> {
  const api = buildApi(resolveDeps({ extensions }));
  return api.getOpenAPI31Document(OPENAPI_CONFIG) as unknown as Record<string, unknown>;
}
