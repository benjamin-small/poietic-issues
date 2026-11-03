import { testDialect } from '@poietic-tech/issues-db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectLevel, projectLevels, readableProjectIds, writableProjectIds } from './access.ts';
import { type ServiceContext, withActor } from './context.ts';
import { createIssue, listIssues } from './services/issues.ts';
import { createProject } from './services/projects.ts';
import { createTestContext, grant, grantGroup, type TestContext } from './testing.ts';

describe(`group grants (${testDialect()})`, () => {
  let t: TestContext;
  let P: { id: string; visibility: 'public' | 'private' };
  let Q: { id: string; visibility: 'public' | 'private' };
  let alice: ServiceContext;
  let bot: ServiceContext;
  const as = (groups: string[]) => withActor(t.member, { ...t.member.actor, groups });
  const level = (ctx: ServiceContext, p: typeof P) => projectLevel(ctx, t.db.kysely, p);

  beforeAll(async () => {
    t = await createTestContext();
    P = await createProject(t.ctx, { key: 'GP', name: 'Private' });
    Q = await createProject(t.ctx, { key: 'GQ', name: 'Public', visibility: 'public' });
    alice = as(['team']);
    bot = withActor(t.agent, { ...t.agent.actor, groups: [] });
  });
  afterAll(() => t.destroy());

  it('a group grant gives its level', async () => {
    await grantGroup(t, 'GP', 'team', 'editor');
    expect(await level(alice, P)).toBe('write');
    expect(await level(bot, P)).toBe('none');
    const levels = await projectLevels(alice, t.db.kysely, [P, Q]);
    expect(levels.get(P.id)).toBe('write');
    expect(levels.get(Q.id)).toBe('read');
  });

  it('a direct membership and a group grant take the higher', async () => {
    await grant(t, 'GP', t.member, 'viewer');
    await grantGroup(t, 'GP', 'team', 'manager');
    expect(await level(alice, P)).toBe('manage');
    expect((await projectLevels(alice, t.db.kysely, [P])).get(P.id)).toBe('manage');
  });

  it('losing the group loses the grant', async () => {
    await t.db.kysely.deleteFrom('project_members').execute();
    expect(await level(as([]), P)).toBe('none');
    expect((await projectLevels(as([]), t.db.kysely, [P])).get(P.id)).toBe('none');
  });

  it('a grant below the floor changes nothing', async () => {
    await grantGroup(t, 'GQ', 'team', 'viewer');
    expect(await level(alice, Q)).toBe('read');
  });

  it('lists and search include group-only projects', async () => {
    await grantGroup(t, 'GP', 'team', 'viewer');
    expect(await readableProjectIds(alice, t.db.kysely)).toContain(P.id);
    expect(await readableProjectIds(as([]), t.db.kysely)).not.toContain(P.id);
    expect(await writableProjectIds(alice, t.db.kysely)).not.toContain(P.id);
    await grantGroup(t, 'GP', 'team', 'editor');
    expect(await writableProjectIds(alice, t.db.kysely)).toContain(P.id);
    expect(await writableProjectIds(as([]), t.db.kysely)).not.toContain(P.id);

    await createIssue(t.ctx, 'GP', { title: 'group visible' });
    const page = await listIssues(alice, {});
    expect(page.data.map((i) => i.title)).toContain('group visible');
    const none = await listIssues(as([]), {});
    expect(none.data.map((i) => i.title)).not.toContain('group visible');
  });

  it('deleting the project deletes its grants', async () => {
    await t.db.kysely.deleteFrom('projects').where('id', '=', P.id).execute();
    const rows = await t.db.kysely
      .selectFrom('project_group_grants')
      .select('project_id')
      .where('project_id', '=', P.id)
      .execute();
    expect(rows).toHaveLength(0);
  });
});
