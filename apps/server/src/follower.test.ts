import { createProject, createUserUnchecked, SYSTEM_ACTOR } from '@poietic-tech/issues-core';
import { createTestContext, grant, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import {
  changes,
  concerns,
  createClient,
  follow,
  provenance,
  reasonHeaders,
  type ApiClient,
} from '@poietic-tech/issues-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { testSso } from './testing.ts';

const ASSIGNMENT = 'metadata.poietic.pm.assignment';

let t: TestContext;
let manager: { api: ApiClient; id: string };
let coder: { api: ApiClient; id: string };
let writer: { api: ApiClient; id: string };

beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'PIPE', name: 'Pipeline' });
  const sso = testSso(t);
  const app = createApp({
    db: t.db,
    clock: t.ctx.clock,
    auth: { mode: 'standard', sso: sso.options },
  });
  const base = { ...t.ctx, actor: SYSTEM_ACTOR };
  async function actor(handle: string, kind: 'agent' | 'human') {
    const user = await createUserUnchecked(base, { handle, name: handle, kind });
    await grant(t, 'PIPE', { ...t.ctx, actor: { ...t.ctx.actor, id: user.id } }, 'editor');
    const token = await sso.bearer(handle);
    return {
      id: user.id,
      api: createClient({
        baseUrl: 'http://t',
        token,
        fetch: (r) => Promise.resolve(app.fetch(r)),
      }),
    };
  }
  manager = await actor('manager', 'agent');
  coder = await actor('coder', 'agent');
  writer = await actor('writer', 'human');
});
afterAll(() => t.destroy());

async function newIssue(): Promise<string> {
  const { data } = await manager.api.POST('/projects/{project}/issues', {
    params: { path: { project: 'PIPE' } },
    body: { title: 'Build it' },
  });
  return data!.key;
}

async function assign(who: { api: ApiClient }, key: string, assignment: string, reason?: string) {
  const res = await who.api.PATCH('/issues/{issue}', {
    params: { path: { issue: key } },
    body: { assignee: 'coder', metadata: { 'poietic.pm.assignment': assignment } },
    headers: reasonHeaders(reason),
  });
  expect(res.response.status, JSON.stringify(res.error)).toBe(200);
}

describe(`following the tracker as an agent (${testDialect()})`, () => {
  it('a hand-off by the manager is proven', async () => {
    const key = await newIssue();
    await assign(manager, key, 'a1', 'assigned to coding');
    const found = await provenance(coder.api, key, ['assignee', ASSIGNMENT]);
    expect(found.assignee).not.toBeNull();
    expect(found[ASSIGNMENT]?.seq).toBe(found.assignee!.seq);
    expect(found.assignee).toMatchObject({ actorId: manager.id, reason: 'assigned to coding' });
  });

  it('a forged hand-off names the forger', async () => {
    const key = await newIssue();
    await assign(writer, key, 'a1');
    const found = await provenance(coder.api, key, ['assignee', ASSIGNMENT]);
    expect(found.assignee?.actorId).toBe(writer.id);
    expect(found[ASSIGNMENT]?.actorId).toBe(writer.id);
  });

  it('a later edit by a person moves provenance', async () => {
    const key = await newIssue();
    await assign(manager, key, 'a1');
    await writer.api.PATCH('/issues/{issue}', {
      params: { path: { issue: key } },
      body: { metadata: { 'poietic.pm.assignment': 'a2' } },
    });
    const found = await provenance(coder.api, key, ['assignee', ASSIGNMENT]);
    expect(found.assignee?.actorId).toBe(manager.id);
    expect(found[ASSIGNMENT]?.actorId).toBe(writer.id);
    expect(found[ASSIGNMENT]!.seq).toBeGreaterThan(found.assignee!.seq);
  });

  it('concerns sees a real assignment', async () => {
    const start = (await changes(coder.api, { after: 0, limit: 1000 })).through;
    const key = await newIssue();
    await assign(manager, key, 'a1');
    const { events } = await changes(coder.api, { after: start, types: ['issue.updated'] });
    const assigned = events.find((e) => (e.data.issue as { key?: string }).key === key)!;
    expect(concerns(assigned, { userId: coder.id })).toBe('newly_assigned');
  });

  it('follow reads what a notice announced, once', async () => {
    let saved = (await changes(coder.api, { after: 0, limit: 1000 })).through;
    const cursor = { load: async () => saved, save: async (s: number) => void (saved = s) };
    const seen: number[] = [];
    const follower = follow(coder.api, {
      cursor,
      types: ['issue.updated'],
      onBatch: async (events) => void seen.push(...events.map((e) => e.seq)),
    });
    const key = await newIssue();
    await assign(manager, key, 'a1');
    await follower.run();
    expect(seen).toHaveLength(1);
    await follower.run();
    expect(seen).toHaveLength(1);
  });
});
