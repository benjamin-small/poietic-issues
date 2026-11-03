import type { TestContext } from '@poietic-tech/issues-core/testing';
import type { SsoOptions } from './env.ts';
import type { SsoClaims } from './sso/verifier.ts';

const ISS = 'https://auth.example.test';

/**
 * Tests authenticate with identity tokens through a fake verifier: the token is the subject, except that `bad` and
 * any `trk_…` value fail to verify, as they do with the real verifier (neither is a JWT). Liveness and the directory
 * are stubbed so they always succeed. `bearer(handle)` links the existing test user to a subject and returns
 * the bearer value to send.
 */
export function testSso(t: TestContext): {
  options: SsoOptions;
  /** Links the user to a subject; `groups` become the groups the verified token carries. */
  bearer(handle: string, groups?: string[]): Promise<string>;
} {
  const options: SsoOptions = {
    name: 'Example',
    cookie: 'example_session',
    issuer: ISS,
    loginUrl: `${ISS}/login`,
    adminRole: 'admin',
    verifier: {
      verify: async (token) =>
        token === 'bad' || token.startsWith('trk_')
          ? null
          : ({
              iss: ISS,
              aud: 'x',
              sub: token,
              name: `Person ${token}`,
              role: 'user',
              groups: token.includes('+') ? token.split('+')[1]!.split(',') : [],
              kind: 'human',
              owner: null,
              sid: 's1',
              iat: 0,
              exp: Math.floor(Date.now() / 1000) + 3600,
            } satisfies SsoClaims),
    },
    liveness: { isLive: async () => true },
    directory: { refresh: async () => {} },
  };
  return {
    options,
    async bearer(handle, groups = []) {
      const user = await t.db.kysely
        .selectFrom('users')
        .select('id')
        .where('handle', '=', handle)
        .executeTakeFirstOrThrow();
      const subject = `test-${handle}${groups.length ? `+${groups.join(',')}` : ''}`;
      await t.db.kysely
        .insertInto('user_identities')
        .values({
          issuer: ISS,
          subject,
          user_id: user.id,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return subject;
    },
  };
}
