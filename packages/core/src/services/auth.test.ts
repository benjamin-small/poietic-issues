import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { createHash } from 'node:crypto';
import { actorForUser, authenticateSession, createSession } from './auth.ts';
import { createTestContext, type TestContext } from '../testing.ts';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe(`web sessions (${testDialect()})`, () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(() => t.destroy());

  /** A clock the test moves by hand. */
  function manualClock() {
    let now = new Date('2026-10-11T12:00:00Z');
    return { now: () => now, advance: (ms: number) => void (now = new Date(now.getTime() + ms)) };
  }

  it('lasts the given lifetime and reports when it ends', async () => {
    const clock = manualClock();
    const ctx = { db: t.db, clock };
    const member = (await actorForUser(t.ctx, 'member'))!;
    const { cookie, expiresAt } = await createSession(ctx, member.id, 60_000);
    expect(expiresAt).toBe('2026-10-11T12:01:00.000Z');
    expect(await authenticateSession(ctx, cookie)).toMatchObject({
      actor: { id: member.id },
      expiresAt,
    });
    clock.advance(60_000);
    expect(await authenticateSession(ctx, cookie)).toBeNull();
  });

  it("drops the user's expired sessions when it creates one", async () => {
    const clock = manualClock();
    const ctx = { db: t.db, clock };
    const bot = (await actorForUser(t.ctx, 'bot'))!;
    const count = async () =>
      (await t.db.kysely.selectFrom('sessions').where('user_id', '=', bot.id).selectAll().execute())
        .length;
    await createSession(ctx, bot.id, 1000);
    await createSession(ctx, bot.id, 5000);
    expect(await count()).toBe(2);
    clock.advance(1000);
    await createSession(ctx, bot.id, 1000);
    expect(await count()).toBe(2);
  });

  describe('auth groups', () => {
    const rawSessions = (userId: string) =>
      t.db.kysely.selectFrom('sessions').where('user_id', '=', userId).selectAll().execute();

    it('a session keeps the groups it was created with', async () => {
      const ctx = { db: t.db, clock: manualClock() };
      const member = (await actorForUser(t.ctx, 'member'))!;
      const { cookie } = await createSession(ctx, member.id, undefined, ['issues-users', 'team']);
      const session = await authenticateSession(ctx, cookie);
      expect(session!.actor.groups).toEqual(['issues-users', 'team']);
    });

    it('an old session has no groups', async () => {
      const clock = manualClock();
      const ctx = { db: t.db, clock };
      const member = (await actorForUser(t.ctx, 'member'))!;
      // A row written before the column existed: the migration default fills `groups`.
      await t.db.kysely
        .insertInto('sessions')
        .values({
          id: sha256('old-cookie'),
          user_id: member.id,
          created_at: clock.now().toISOString(),
          expires_at: new Date(clock.now().getTime() + 60_000).toISOString(),
        } as never)
        .execute();
      expect((await authenticateSession(ctx, 'old-cookie'))!.actor.groups).toEqual([]);
    });

    it.each(['nope', '{"a":1}', '"team"', '["ok", 3]', 'null'])(
      'a garbled groups column (%s) fails closed',
      async (garbled) => {
        const ctx = { db: t.db, clock: manualClock() };
        const member = (await actorForUser(t.ctx, 'member'))!;
        const { cookie } = await createSession(ctx, member.id, undefined, ['team']);
        await t.db.kysely
          .updateTable('sessions')
          .set({ groups: garbled })
          .where('id', '=', sha256(cookie))
          .execute();
        expect((await authenticateSession(ctx, cookie))!.actor.groups).toEqual([]);
        expect((await rawSessions(member.id)).length).toBeGreaterThan(0);
      },
    );
  });
});
