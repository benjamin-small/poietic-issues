import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { SsoOptions } from './env.ts';
import { createSsoDirectory } from './sso/directory.ts';
import type { SsoClaims } from './sso/verifier.ts';

const BASE = 'http://tracker.test';
const ISS = 'https://auth.example.test';
let t: TestContext;
beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.destroy());

/**
 * A fake verifier: the token is the subject; "admin-*" subjects carry role admin; "agent:<owner>:<n>" is an agent
 * owned by subject <owner>; "member-*" subjects are in the group "crew", "admin-grp*" in "team"; "bad" and "trk_abc" fail; "down" throws.
 */
function sso(): SsoOptions {
  return {
    name: 'Example',
    cookie: 'example_session',
    issuer: ISS,
    loginUrl: `${ISS}/login`,
    refreshUrl: `${ISS}/me`,
    adminRole: 'admin',
    verifier: {
      verify: async (token) => {
        if (token === 'down') throw new Error('JWKS unavailable');
        return token === 'bad' || token === 'trk_abc'
          ? null
          : ({
              iss: ISS,
              aud: 'x',
              sub: token,
              name: `Person ${token}`,
              role: token.startsWith('admin') ? 'admin' : 'user',
              groups: token.startsWith('member-')
                ? ['crew']
                : token.startsWith('admin-grp')
                  ? ['team']
                  : [],
              kind: token.startsWith('agent:') ? 'agent' : 'human',
              owner: token.startsWith('agent:') ? token.split(':')[1]! : null,
              ...(token.includes('@') && { handle: token.split('@')[1]! }),
              sid: 's1',
              iat: 0,
              exp: 0,
            } satisfies SsoClaims);
      },
    },
  };
}

function post(app: ReturnType<typeof createApp>, cookie: string | null, origin = BASE) {
  const headers: Record<string, string> = { origin };
  if (cookie !== null) headers.cookie = `example_session=${cookie}`;
  return app.request(`${BASE}/api/v1/auth/sso`, { method: 'POST', headers });
}

describe(`SSO sign-in (${testDialect()})`, () => {
  it('advertises SSO in /auth/config', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await app.request(`${BASE}/api/v1/auth/config`);
    expect(await res.json()).toMatchObject({
      devLogin: false,
      sso: {
        name: 'Example',
        loginUrl: `${ISS}/login`,
        refreshUrl: `${ISS}/me`,
        sessionSeconds: 900,
      },
    });
    const off = createApp({ db: t.db, auth: { mode: 'standard' } });
    expect(await (await off.request(`${BASE}/api/v1/auth/config`)).json()).toMatchObject({
      sso: null,
    });
  });

  it('signs an admin-role identity in with a tracker session', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'admin-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'admin', name: 'Person admin-1' });
    const session = res.headers.get('set-cookie')!.split(';')[0]!;
    expect(session).toMatch(/^poietic_issues_session=/);
    const me = await app.request(`${BASE}/api/v1/me`, { headers: { cookie: session } });
    expect(((await me.json()) as { name: string }).name).toBe('Person admin-1');
  });

  it("takes the issuer's handle claim for the new user", async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'admin-h1@hopper');
    expect(await res.json()).toMatchObject({ handle: 'hopper', name: 'Person admin-h1@hopper' });
  });

  it('still accepts the pre-rename tracker_session cookie, and logout clears it', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'admin-legacy');
    const value = res.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    const legacy = { cookie: `tracker_session=${value}` };
    const me = await app.request(`${BASE}/api/v1/me`, { headers: legacy });
    expect(me.status).toBe(200);
    const out = await app.request(`${BASE}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { ...legacy, origin: BASE },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^tracker_session=;/);
    const after = await app.request(`${BASE}/api/v1/me`, { headers: legacy });
    expect(await after.json()).toEqual({ anonymous: true });
  });

  it('answers PENDING_APPROVAL for a new non-admin identity, without a session', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'u-1');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('PENDING_APPROVAL');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses an agent identity a browser session', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    await post(app, 'admin-owner');
    const res = await post(app, 'agent:admin-owner:1');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signs a member of the configured group straight in, and leaves others pending', async () => {
    const app = createApp({
      db: t.db,
      auth: { mode: 'standard', sso: { ...sso(), memberGroup: 'crew' } },
    });
    const res = await post(app, 'member-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'member', deactivatedAt: null });
    expect(res.headers.get('set-cookie')).toMatch(/^poietic_issues_session=/);
    expect((await post(app, 'outsider-1')).status).toBe(403);
    // Without the option, group membership changes nothing.
    const off = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    expect((await post(off, 'member-2')).status).toBe(403);
  });

  it('answers 401 without a valid cookie, 403 cross-origin, 404 when off', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    expect((await post(app, null)).status).toBe(401);
    expect((await post(app, 'bad')).status).toBe(401);
    expect((await post(app, 'admin-2', 'https://evil.example')).status).toBe(403);
    const off = createApp({ db: t.db, auth: { mode: 'standard' } });
    expect((await post(off, 'admin-3')).status).toBe(404);
  });

  it('answers 503 UNAVAILABLE, with no session, when the verifier cannot reach the issuer', async () => {
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
    const res = await post(app, 'down');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('UNAVAILABLE');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  describe('short sessions', () => {
    /** A clock the test moves by hand. */
    const manualClock = () => {
      let now = new Date('2026-10-11T12:00:00Z');
      return {
        now: () => now,
        advance: (ms: number) => void (now = new Date(now.getTime() + ms)),
      };
    };
    const me = async (app: ReturnType<typeof createApp>, session: string) =>
      (await (await app.request(`${BASE}/api/v1/me`, { headers: { cookie: session } })).json()) as {
        anonymous?: true;
      };
    const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

    it('lasts sessionTtlMs, then the visitor is anonymous', async () => {
      const clock = manualClock();
      const app = createApp({
        db: t.db,
        auth: { mode: 'standard', sso: { ...sso(), sessionTtlMs: 60_000 } },
        clock,
      });
      const res = await post(app, 'admin-short1');
      expect(res.headers.get('set-cookie')).toContain('Expires=Sun, 11 Oct 2026 12:01:00 GMT');
      const session = cookieOf(res);
      clock.advance(59_999);
      expect((await me(app, session)).anonymous).toBeUndefined();
      clock.advance(1);
      expect((await me(app, session)).anonymous).toBe(true);
    });

    it('renews by signing in again, which ends the session it replaces', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const first = cookieOf(await post(app, 'admin-short2'));
      const renewed = await app.request(`${BASE}/api/v1/auth/sso`, {
        method: 'POST',
        headers: { origin: BASE, cookie: `example_session=admin-short2; ${first}` },
      });
      expect(renewed.status).toBe(200);
      const second = cookieOf(renewed);
      expect(second).not.toBe(first);
      expect((await me(app, first)).anonymous).toBe(true);
      expect((await me(app, second)).anonymous).toBeUndefined();
    });

    it('ends the session it was renewing when the issuer says the session has ended', async () => {
      let alive = true;
      const app = createApp({
        db: t.db,
        auth: {
          mode: 'standard',
          sso: { ...sso(), liveness: { isLive: async () => alive } },
        },
      });
      const session = cookieOf(await post(app, 'admin-short3'));
      alive = false;
      const res = await app.request(`${BASE}/api/v1/auth/sso`, {
        method: 'POST',
        headers: { origin: BASE, cookie: `example_session=admin-short3; ${session}` },
      });
      expect(res.status).toBe(401);
      expect((await me(app, session)).anonymous).toBe(true);
    });
  });

  describe('session liveness at sign-in', () => {
    /** "dead" in the token means its issuer session ended; "gone" means the issuer can't be asked. */
    const liveness = (asked: string[] = []) => ({
      isLive: async (token: string) => {
        asked.push(token);
        if (token.includes('gone')) throw new Error('liveness unavailable');
        return !token.includes('dead');
      },
    });

    it('refuses a tracker session for a cookie whose issuer session has ended', async () => {
      const asked: string[] = [];
      const app = createApp({
        db: t.db,
        auth: { mode: 'standard', sso: { ...sso(), liveness: liveness(asked) } },
      });
      const dead = await post(app, 'admin-dead');
      expect(dead.status).toBe(401);
      expect(((await dead.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
      expect(dead.headers.get('set-cookie')).toBeNull();
      expect((await post(app, 'admin-alive')).status).toBe(200);
      expect(asked).toEqual(['admin-dead', 'admin-alive']);
    });

    it('fails closed with 503 when the issuer cannot be asked, and never asks for agents', async () => {
      const asked: string[] = [];
      const app = createApp({
        db: t.db,
        auth: { mode: 'standard', sso: { ...sso(), liveness: liveness(asked) } },
      });
      const gone = await post(app, 'admin-gone');
      expect(gone.status).toBe(503);
      expect(gone.headers.get('set-cookie')).toBeNull();
      expect((await post(app, 'agent:admin-alive:x')).status).toBe(403);
      expect(asked).toEqual(['admin-gone']);
    });
  });

  it('logs a warning when the verifier fails', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'warn' }, { write: (l: string) => void lines.push(l) });
    const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() }, logger });
    await post(app, 'down');
    expect(lines.join('')).toContain('JWKS unavailable');
  });

  describe('identity tokens in the Authorization header', () => {
    const bearer = (token: string, extra: Record<string, string> = {}) => ({
      headers: { authorization: `Bearer ${token}`, ...extra },
    });
    const code = async (res: Response) => ((await res.json()) as { code: string }).code;

    it('acts as an agent owned by its signed-in owner, provisioning it on first use', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const owner = (await (await post(app, 'admin-own1')).json()) as { id: string };
      const res = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-own1:a'));
      expect(res.status).toBe(200);
      const me = (await res.json()) as { id: string };
      expect(me).toMatchObject({
        kind: 'agent',
        role: 'member',
        ownerId: owner.id,
        deactivatedAt: null,
      });
      const again = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-own1:a'));
      expect(((await again.json()) as { id: string }).id).toBe(me.id);
    });

    it("gives an agent its identity token's handle", async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      await post(app, 'admin-own9');
      const res = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-own9:a@claude-bot'));
      expect(await res.json()).toMatchObject({ kind: 'agent', handle: 'claude-bot' });
    });

    it('needs no same-origin check: an identity token is not an ambient credential', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      await post(app, 'admin-own2');
      const res = await app.request(`${BASE}/api/v1/users/me`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer agent:admin-own2:a',
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Renamed bot' }),
      });
      expect(res.status).toBe(200);
    });

    it('refuses an agent whose owner has never signed in, and a pending human', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const orphan = await app.request(`${BASE}/api/v1/me`, bearer('agent:nobody:a'));
      expect(orphan.status).toBe(403);
      expect(await code(orphan)).toBe('FORBIDDEN');
      const pending = await app.request(`${BASE}/api/v1/me`, bearer('u-pending'));
      expect(pending.status).toBe(403);
      expect(await code(pending)).toBe('PENDING_APPROVAL');
    });

    describe('auth groups on the request actor', () => {
      /** An app whose `/probe` route echoes the groups the auth middleware put on the request's actor. */
      const probed = () =>
        createApp({
          db: t.db,
          auth: { mode: 'standard', sso: sso() },
          extensions: [
            (api) => {
              api.get('/probe', (c) => c.json({ groups: c.get('ctx').actor.groups }));
            },
          ],
        });
      const groupsOf = async (res: Response) => ((await res.json()) as { groups: string[] }).groups;

      it("a bearer request carries the token's groups", async () => {
        const app = probed();
        expect(
          await groupsOf(await app.request(`${BASE}/api/v1/probe`, bearer('admin-grp1'))),
        ).toEqual(['team']);
      });

      it('a cookie request carries the groups the session was signed in with', async () => {
        const app = probed();
        const cookie = (await post(app, 'admin-grp2')).headers.get('set-cookie')!.split(';')[0]!;
        const res = await app.request(`${BASE}/api/v1/probe`, { headers: { cookie } });
        expect(await groupsOf(res)).toEqual(['team']);
      });

      it("an agent never picks up its owner's groups", async () => {
        const app = probed();
        await post(app, 'admin-grp3');
        const res = await app.request(`${BASE}/api/v1/probe`, bearer('agent:admin-grp3:a'));
        expect(await groupsOf(res)).toEqual([]);
      });
    });

    it('decides on its own: an invalid bearer is 401 even with a valid session cookie', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const session = (await post(app, 'admin-own3')).headers.get('set-cookie')!.split(';')[0]!;
      const res = await app.request(`${BASE}/api/v1/me`, bearer('bad', { cookie: session }));
      expect(res.status).toBe(401);
    });

    it('sends every bearer value to the verifier, trk_ ones included', async () => {
      const seen: string[] = [];
      const options = sso();
      const verify = options.verifier.verify;
      options.verifier = { verify: (token) => (seen.push(token), verify(token)) };
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: options } });
      // This fake accepts the value as a new human's subject (the real verifier rejects it: it is not a JWT), so the
      // request gets as far as sign-in, which holds the new user for approval.
      const res = await app.request(`${BASE}/api/v1/me`, bearer('trk_someone'));
      expect(seen).toEqual(['trk_someone']);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('PENDING_APPROVAL');
    });

    it('answers an old trk_ bearer that does not verify with a 401, even with a valid session cookie', async () => {
      const signIn = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const session = (await post(signIn, 'admin-own5')).headers.get('set-cookie')!.split(';')[0]!;
      for (const options of [sso(), undefined]) {
        const app = createApp({ db: t.db, auth: { mode: 'standard', sso: options } });
        const res = await app.request(`${BASE}/api/v1/me`, bearer('trk_abc', { cookie: session }));
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        expect(await code(res)).toBe('UNAUTHENTICATED');
      }
    });

    describe('session liveness on every request', () => {
      const NOW = new Date('2026-10-11T12:00:00Z');
      /** The liveness stub: "dead" in the token means revoked, "gone" means the issuer can't be reached. */
      function live() {
        const asked: { token: string; now: Date }[] = [];
        return {
          asked,
          liveness: {
            isLive: async (token: string, now: Date) => {
              asked.push({ token, now });
              if (token.includes('gone')) throw new Error('liveness unavailable');
              return !token.includes('dead');
            },
          },
        };
      }
      const rename = (token: string) => ({
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed bot' }),
      });

      it('refuses writes and reads once the session has ended', async () => {
        const { asked, liveness } = live();
        const app = createApp({
          db: t.db,
          auth: { mode: 'standard', sso: { ...sso(), liveness } },
          clock: { now: () => NOW },
        });
        await post(app, 'admin-live1');
        const ok = await app.request(`${BASE}/api/v1/users/me`, rename('agent:admin-live1:a'));
        expect(ok.status).toBe(200);
        const dead = await app.request(`${BASE}/api/v1/users/me`, rename('agent:admin-live1:dead'));
        expect(dead.status).toBe(401);
        expect(await code(dead)).toBe('UNAUTHENTICATED');
        const read = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-live1:dead'));
        expect(read.status).toBe(401);
        const liveRead = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-live1:a'));
        expect(liveRead.status).toBe(200);
        expect(asked).toEqual([
          { token: 'admin-live1', now: NOW },
          { token: 'agent:admin-live1:a', now: NOW },
          { token: 'agent:admin-live1:dead', now: NOW },
          { token: 'agent:admin-live1:dead', now: NOW },
          { token: 'agent:admin-live1:a', now: NOW },
        ]);
      });

      it('fails closed with 503 when the issuer cannot be asked, and logs it', async () => {
        const lines: string[] = [];
        const logger = pino({ level: 'warn' }, { write: (l: string) => void lines.push(l) });
        const { liveness } = live();
        const app = createApp({
          db: t.db,
          auth: { mode: 'standard', sso: { ...sso(), liveness } },
          logger,
        });
        await post(app, 'admin-live2');
        const res = await app.request(`${BASE}/api/v1/users/me`, rename('agent:admin-live2:gone'));
        expect(res.status).toBe(503);
        expect(await code(res)).toBe('UNAVAILABLE');
        expect(lines.join('')).toContain('liveness unavailable');
        const read = await app.request(`${BASE}/api/v1/me`, bearer('agent:admin-live2:gone'));
        expect(read.status).toBe(503);
      });

      it('is not consulted for writes with a tracker session cookie', async () => {
        const { asked, liveness } = live();
        const app = createApp({
          db: t.db,
          auth: { mode: 'standard', sso: { ...sso(), liveness } },
        });
        const session = (await post(app, 'admin-live3')).headers.get('set-cookie')!.split(';')[0]!;
        asked.length = 0;
        const res = await app.request(`${BASE}/api/v1/users/me`, {
          method: 'PATCH',
          headers: { cookie: session, origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed person' }),
        });
        expect(res.status).toBe(200);
        expect(asked).toEqual([]);
      });
    });

    it('answers 503 when the issuer is unreachable, and 401 when SSO is off', async () => {
      const app = createApp({ db: t.db, auth: { mode: 'standard', sso: sso() } });
      const down = await app.request(`${BASE}/api/v1/me`, bearer('down'));
      expect(down.status).toBe(503);
      expect(await code(down)).toBe('UNAVAILABLE');
      const off = createApp({ db: t.db, auth: { mode: 'standard' } });
      expect((await off.request(`${BASE}/api/v1/me`, bearer('admin-own5'))).status).toBe(401);
    });
  });

  describe('the directory', () => {
    it('lists a member-group person who has never signed in, and survives the directory being down', async () => {
      let down = false;
      const fetchImpl = (async () =>
        down
          ? new Response('down', { status: 503 })
          : Response.json({
              users: [
                {
                  id: 'dir-only',
                  name: 'Directory Only',
                  avatar_url: null,
                  groups: ['crew'],
                  kind: 'human',
                  owner: null,
                  created_at: 0,
                },
              ],
              next_cursor: null,
            })) as typeof fetch;
      const directory = createSsoDirectory({
        serviceKey: 'ptk_test',
        baseUrl: ISS,
        issuer: ISS,
        memberGroup: 'crew',
        fetchImpl,
        ttlMs: 0,
        retryMs: 0,
      });
      const app = createApp({
        db: t.db,
        auth: { mode: 'standard', sso: { ...sso(), memberGroup: 'crew', directory } },
      });
      const session = (await post(app, 'admin-dir')).headers.get('set-cookie')!.split(';')[0]!;
      const list = async () => {
        const res = await app.request(`${BASE}/api/v1/users`, { headers: { cookie: session } });
        expect(res.status).toBe(200);
        return ((await res.json()) as { data: { name: string }[] }).data.map((u) => u.name);
      };
      expect(await list()).toContain('Directory Only');
      down = true;
      expect(await list()).toContain('Directory Only');
      // Anonymous listings never reach the directory.
      expect((await app.request(`${BASE}/api/v1/users`)).status).toBe(401);
    });
  });
});
