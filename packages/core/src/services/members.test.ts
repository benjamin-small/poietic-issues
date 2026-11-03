import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDialect } from '@poietic-tech/issues-db/testing';
import {
  addMember,
  listGroupGrants,
  listMembers,
  removeGroupGrant,
  removeMember,
  setGroupGrant,
  updateMember,
} from './members.ts';
import { createProject, getProject, listProjects, updateProject } from './projects.ts';
import { listEvents } from './events.ts';
import { ANONYMOUS_ACTOR, withActor } from '../context.ts';
import { createTestContext, grant, type TestContext } from '../testing.ts';

describe(`project members (${testDialect()})`, () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    await createProject(t.ctx, { key: 'ENG', name: 'Eng' });
  });
  afterAll(() => t.destroy());

  it('lets admins and managers manage members, with events', async () => {
    const m = await addMember(t.ctx, 'ENG', { user: '@member', role: 'viewer' });
    expect(m).toMatchObject({ user: { handle: 'member' }, role: 'viewer' });
    await expect(
      addMember(t.ctx, 'ENG', { user: '@member', role: 'editor' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      addMember(t.member, 'ENG', { user: '@bot', role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await updateMember(t.ctx, 'ENG', '@member', { role: 'manager' });
    await addMember(t.member, 'ENG', { user: '@bot', role: 'editor' });
    expect((await listMembers(t.member, 'ENG')).map((x) => [x.user.handle, x.role])).toEqual([
      ['bot', 'editor'],
      ['member', 'manager'],
    ]);
    await removeMember(t.member, 'ENG', '@bot');
    const types = (
      await listEvents(t.ctx, {
        types: ['project.member_added', 'project.member_changed', 'project.member_removed'],
      })
    ).data.map((e) => e.type);
    expect(types).toEqual([
      'project.member_added',
      'project.member_changed',
      'project.member_added',
      'project.member_removed',
    ]);
  });

  it('reports myAccess and lets only managers change visibility', async () => {
    expect((await getProject(t.member, 'ENG')).myAccess).toBe('manage');
    await grant(t, 'ENG', t.agent, 'editor');
    await expect(updateProject(t.agent, 'ENG', { visibility: 'public' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await updateProject(t.member, 'ENG', { visibility: 'public' })).visibility).toBe(
      'public',
    );
  });

  it('reports an existing membership as CONFLICT from the unique key', async () => {
    await createProject(t.ctx, { key: 'DUP', name: 'Dup' });
    await addMember(t.ctx, 'DUP', { user: '@bot', role: 'viewer' });
    await expect(addMember(t.ctx, 'DUP', { user: 'bot', role: 'editor' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '@bot is already a member of DUP',
    });
    // The failed add changed nothing and recorded nothing.
    expect((await listMembers(t.ctx, 'DUP')).map((x) => [x.user.handle, x.role])).toEqual([
      ['bot', 'viewer'],
    ]);
    const dup = (await getProject(t.ctx, 'DUP')).id;
    const added = (await listEvents(t.ctx, { types: ['project.member_added'] })).data;
    expect(added.filter((e) => e.projectId === dup)).toHaveLength(1);
  });

  it('writes nothing and records no event when the role is unchanged', async () => {
    const project = await createProject(t.ctx, { key: 'SAME', name: 'Same' });
    const added = await addMember(t.ctx, 'SAME', { user: '@bot', role: 'editor' });
    // Every membership event of the project, so the add shows the query would see a change if there were one.
    const memberEvents = async () =>
      (await listEvents(t.ctx, { project: project.id, limit: 1000 })).data
        .filter((e) => e.type.startsWith('project.member_'))
        .map((e) => e.type);
    expect(await memberEvents()).toEqual(['project.member_added']);
    const same = await updateMember(t.ctx, 'SAME', '@bot', { role: 'editor' });
    expect(same).toEqual(added);
    expect(await memberEvents()).toEqual(['project.member_added']);
    expect((await listMembers(t.ctx, 'SAME'))[0]!.updatedAt).toBe(added.updatedAt);
  });

  it('lists every project with the same myAccess as getting it one by one', async () => {
    await createProject(t.ctx, { key: 'LPUB', name: 'Listed public', visibility: 'public' });
    await createProject(t.ctx, { key: 'LVIEW', name: 'Listed viewer' });
    await createProject(t.ctx, { key: 'LEDIT', name: 'Listed editor', visibility: 'public' });
    await grant(t, 'LVIEW', t.agent, 'viewer');
    await grant(t, 'LEDIT', t.agent, 'editor');
    for (const who of [t.ctx, t.member, t.agent, withActor(t.ctx, ANONYMOUS_ACTOR)]) {
      const listed = await listProjects(who);
      expect(listed.length, who.actor.handle).toBeGreaterThan(0);
      for (const p of listed)
        expect(p.myAccess, `${who.actor.handle} ${p.key}`).toBe(
          (await getProject(who, p.key)).myAccess,
        );
    }
    const agent = Object.fromEntries((await listProjects(t.agent)).map((p) => [p.key, p.myAccess]));
    expect(agent).toMatchObject({ LPUB: 'read', LVIEW: 'read', LEDIT: 'write' });
  });

  describe('permissions', () => {
    /** A project of its own, so these tests don't depend on the memberships earlier tests left behind. */
    async function projectWith(
      key: string,
      roles: Record<string, 'viewer' | 'editor' | 'manager'>,
    ) {
      await createProject(t.ctx, { key, name: key });
      const people = { viewer: t.member, editor: t.agent } as const;
      for (const [who, role] of Object.entries(roles))
        await grant(t, key, people[who as keyof typeof people], role);
    }

    it('forbids non-managers to update or remove members, and changes nothing', async () => {
      await projectWith('PERM', { viewer: 'viewer', editor: 'editor' });
      for (const who of [t.member, t.agent]) {
        await expect(updateMember(who, 'PERM', '@bot', { role: 'manager' })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(removeMember(who, 'PERM', '@member')).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(
          addMember(who, 'PERM', { user: '@admin', role: 'viewer' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect((await listMembers(t.ctx, 'PERM')).map((x) => [x.user.handle, x.role])).toEqual([
        ['bot', 'editor'],
        ['member', 'viewer'],
      ]);
      const changes = await listEvents(t.ctx, {
        types: ['project.member_changed', 'project.member_removed'],
        limit: 1000,
      });
      const perm = (await getProject(t.ctx, 'PERM')).id;
      expect(changes.data.filter((e) => e.projectId === perm)).toEqual([]);
    });

    it('reports a private project as not found to non-members, for every member operation', async () => {
      await projectWith('HID', { editor: 'editor' });
      for (const who of [t.member, withActor(t.ctx, ANONYMOUS_ACTOR)]) {
        const name = who.actor.handle;
        await expect(listMembers(who, 'HID'), name).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          addMember(who, 'HID', { user: '@admin', role: 'viewer' }),
          name,
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          updateMember(who, 'HID', '@bot', { role: 'viewer' }),
          name,
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(removeMember(who, 'HID', '@bot'), name).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      }
    });

    it('records the previous role in the change event', async () => {
      await projectWith('PREV', {});
      await addMember(t.ctx, 'PREV', { user: '@member', role: 'viewer' });
      await updateMember(t.ctx, 'PREV', '@member', { role: 'editor' });
      await updateMember(t.ctx, 'PREV', '@member', { role: 'manager' });
      const prev = (await getProject(t.ctx, 'PREV')).id;
      const events = (
        await listEvents(t.ctx, { types: ['project.member_changed'], limit: 1000 })
      ).data.filter((e) => e.projectId === prev);
      expect(
        events.map((e) => [
          (e.data as { previousRole: string }).previousRole,
          (e.data as { member: { role: string } }).member.role,
        ]),
      ).toEqual([
        ['viewer', 'editor'],
        ['editor', 'manager'],
      ]);
    });

    it('reports myAccess as read for viewers and public visitors, write for editors', async () => {
      await createProject(t.ctx, { key: 'ACC', name: 'Acc' });
      await createProject(t.ctx, { key: 'ACCP', name: 'Acc public', visibility: 'public' });
      await grant(t, 'ACC', t.member, 'viewer');
      await grant(t, 'ACC', t.agent, 'editor');
      expect((await getProject(t.member, 'ACC')).myAccess).toBe('read');
      expect((await getProject(t.agent, 'ACC')).myAccess).toBe('write');
      expect((await getProject(t.ctx, 'ACC')).myAccess).toBe('manage');
      // Public, no membership: the floor is read, whoever asks.
      const anon = withActor(t.ctx, ANONYMOUS_ACTOR);
      for (const who of [t.member, t.agent, anon])
        expect((await getProject(who, 'ACCP')).myAccess, who.actor.handle).toBe('read');
      // An editor of a public project writes.
      await grant(t, 'ACCP', t.agent, 'editor');
      expect((await getProject(t.agent, 'ACCP')).myAccess).toBe('write');
    });

    it('lets only managers rename a project, change its description or visibility', async () => {
      await projectWith('NAME', { viewer: 'viewer', editor: 'editor' });
      for (const who of [t.agent, t.member]) {
        for (const patch of [
          { name: 'Renamed' },
          { description: 'new words' },
          { visibility: 'public' as const },
        ])
          await expect(
            updateProject(who, 'NAME', patch),
            JSON.stringify(patch),
          ).rejects.toMatchObject({
            code: 'FORBIDDEN',
          });
      }
      const unchanged = await getProject(t.ctx, 'NAME');
      expect(unchanged).toMatchObject({ name: 'NAME', description: '', visibility: 'private' });
      await grant(t, 'NAME', t.agent, 'manager');
      expect((await updateProject(t.agent, 'NAME', { name: 'Renamed' })).name).toBe('Renamed');
    });
  });
});

describe(`project group grants (${testDialect()})`, () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(() => t.destroy());

  const grantEvents = async (projectId: string) =>
    (await listEvents(t.ctx, { project: projectId, limit: 1000 })).data.filter((e) =>
      e.type.startsWith('project.group_grant_'),
    );

  it('set then change then remove records added, changed, removed', async () => {
    const p = await createProject(t.ctx, { key: 'GG', name: 'GG' });
    const added = await setGroupGrant(t.ctx, 'GG', 'team', { role: 'viewer' });
    expect(added).toMatchObject({ group: 'team', role: 'viewer' });
    const changed = await setGroupGrant(t.ctx, 'GG', 'team', { role: 'editor' });
    expect(changed).toMatchObject({ group: 'team', role: 'editor', createdAt: added.createdAt });
    expect(await listGroupGrants(t.ctx, 'GG')).toEqual([changed]);
    await removeGroupGrant(t.ctx, 'GG', 'team');
    expect(await listGroupGrants(t.ctx, 'GG')).toEqual([]);
    const events = await grantEvents(p.id);
    expect(events.map((e) => e.type)).toEqual([
      'project.group_grant_added',
      'project.group_grant_changed',
      'project.group_grant_removed',
    ]);
    expect(events[0]!.data).toMatchObject({
      project: { id: p.id, key: 'GG' },
      grant: { group: 'team' },
    });
    expect(events[1]!.data).toMatchObject({ previousRole: 'viewer' });
    expect(JSON.stringify(events)).not.toContain('@');
  });

  it('setting the same role again records nothing', async () => {
    const p = await createProject(t.ctx, { key: 'GSAME', name: 'Same' });
    const first = await setGroupGrant(t.ctx, 'GSAME', 'team', { role: 'editor' });
    const again = await setGroupGrant(t.ctx, 'GSAME', 'team', { role: 'editor' });
    expect(again).toEqual(first);
    expect(await grantEvents(p.id)).toHaveLength(1);
  });

  it('removing an absent grant is NOT_FOUND and records nothing', async () => {
    const p = await createProject(t.ctx, { key: 'GABS', name: 'Absent' });
    await expect(removeGroupGrant(t.ctx, 'GABS', 'team')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await grantEvents(p.id)).toHaveLength(0);
  });

  it('an editor cannot set or remove a grant (FORBIDDEN)', async () => {
    await createProject(t.ctx, { key: 'GPERM', name: 'Perm' });
    await grant(t, 'GPERM', t.agent, 'editor');
    await setGroupGrant(t.ctx, 'GPERM', 'team', { role: 'viewer' });
    await expect(
      setGroupGrant(t.agent, 'GPERM', 'team', { role: 'manager' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(removeGroupGrant(t.agent, 'GPERM', 'team')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await listGroupGrants(t.agent, 'GPERM')).map((g) => g.role)).toEqual(['viewer']);
  });

  it('a non-member cannot see that a private project exists (NOT_FOUND)', async () => {
    await createProject(t.ctx, { key: 'GHID', name: 'Hidden' });
    await expect(listGroupGrants(t.member, 'GHID')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setGroupGrant(t.member, 'GHID', 'team', { role: 'viewer' })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await expect(removeGroupGrant(t.member, 'GHID', 'team')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a malformed slug or role is VALIDATION_FAILED', async () => {
    await createProject(t.ctx, { key: 'GBAD', name: 'Bad' });
    for (const group of ['Team', '-team', '', 'a b', 'a'.repeat(41)]) {
      await expect(setGroupGrant(t.ctx, 'GBAD', group, { role: 'viewer' })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(removeGroupGrant(t.ctx, 'GBAD', group)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(
      setGroupGrant(t.ctx, 'GBAD', 'team', { role: 'boss' as 'viewer' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await listGroupGrants(t.ctx, 'GBAD')).toEqual([]);
  });

  it('a grant gives its group members access', async () => {
    await createProject(t.ctx, { key: 'GACC', name: 'Access' });
    const viaTeam = withActor(t.member, { ...t.member.actor, groups: ['team'] });
    await expect(listGroupGrants(viaTeam, 'GACC')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await setGroupGrant(t.ctx, 'GACC', 'team', { role: 'manager' });
    expect((await listGroupGrants(viaTeam, 'GACC')).map((g) => g.group)).toEqual(['team']);
    await removeGroupGrant(viaTeam, 'GACC', 'team');
  });
});
