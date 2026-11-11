import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@poietic-tech/issues-client';
import { createProject, LocalDiskBlobStore } from '@poietic-tech/issues-core';
import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { createUserUnchecked } from '@poietic-tech/issues-core';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { createApp } from '@poietic-tech/issues-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeGitHub } from './fake-github.ts';
import { GitHub } from './github.ts';
import { silentLogger } from './log.ts';
import { GITHUB_URL_KEY } from './mapping.ts';
import { Store } from './store.ts';
import { Sync, TRACKER_EVENT_TYPES } from './sync.ts';
import { type Issue, Tracker } from './tracker.ts';

const REPO = 'poietic-tech/poietic-bridge';
const dir = mkdtempSync(join(tmpdir(), 'github-sync-'));
let t: TestContext;
/** The tracker as the sync agent sees it. */
let agentTracker: Tracker;
/** The tracker as a person (the `admin` human) uses it. */
let human: Tracker;
let selfId: string;
let gh: FakeGitHub;
let store: Store;
let sync: Sync;
let cursor = 0;

function trackerAs(actor: string): Tracker {
  const app = createApp({
    db: t.db,
    auth: { mode: 'trusted', actor },
    blobStore: new LocalDiskBlobStore(join(dir, 'blobs')),
    webhooks: { allowPrivate: false },
  });
  return new Tracker(
    createClient({ baseUrl: 'http://tracker.local', fetch: (r) => Promise.resolve(app.fetch(r)) }),
  );
}

/** Hands every tracker event since the last call to the sync, as the runner does. */
async function drainTracker(): Promise<void> {
  for (;;) {
    const page = await agentTracker.events(cursor, TRACKER_EVENT_TYPES, 100);
    for (const event of page.data) {
      await sync.onTracker(event);
      cursor = event.seq;
    }
    if (page.data.length < 100) return;
  }
}

const issueEvent = (action: string, number: number, repo = REPO) =>
  sync.onGitHub(`github.issues.${action}`, gh.issuePayload(action, repo, number));

async function trackerIssueFor(number: number, repo = REPO): Promise<Issue> {
  const link = store.issueByGitHub(repo, number);
  expect(link).toBeDefined();
  return human.issue(link!.trackerId);
}

beforeAll(async () => {
  t = await createTestContext();
  const agent = await createUserUnchecked(t.ctx, {
    handle: 'github-sync',
    name: 'GitHub sync',
    kind: 'agent',
    role: 'admin',
  });
  selfId = agent.id;
  agentTracker = trackerAs('github-sync');
  human = trackerAs('admin');
  gh = new FakeGitHub();
  gh.addRepo(REPO, 'Webhooks into terminals');
  gh.addRepo('poietic-tech/persistent-agents');
});

afterAll(async () => {
  await t.destroy();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  gh.calls.length = 0;
  store = new Store(':memory:');
  agentTracker.invalidate();
  sync = new Sync({
    store,
    tracker: agentTracker,
    github: new GitHub({ token: 'test', fetch: gh.fetch }),
    selfId,
    trackerUrl: 'https://issues.example.test',
    excludeRepos: ['poietic-tech/persistent-agents'],
    log: silentLogger,
  });
  // Start each test from the tracker's present, as a new sync does.
  for (;;) {
    const page = await agentTracker.events(cursor, TRACKER_EVENT_TYPES, 1000);
    if (page.data.length === 0) break;
    cursor = page.data.at(-1)!.seq;
  }
});

describe(`github-sync (${testDialect()})`, () => {
  it('creates a project for an unmapped repository and mirrors a new GitHub issue into it', async () => {
    const { number } = gh.open(REPO, {
      title: 'Bridge drops events',
      body: 'Steps:\r\n1. listen',
      labels: ['bug'],
    });
    await issueEvent('opened', number);

    const projects = await human.projects();
    const project = projects.find((p) => p.repos.some((r) => r.fullName === REPO));
    expect(project).toMatchObject({
      key: 'PB',
      name: 'Poietic Bridge',
      description: 'Webhooks into terminals',
      visibility: 'private',
    });

    const issue = await trackerIssueFor(number);
    expect(issue).toMatchObject({
      projectId: project!.id,
      title: 'Bridge drops events',
      description: 'Steps:\n1. listen',
      repo: REPO,
      metadata: { [GITHUB_URL_KEY]: `https://github.com/${REPO}/issues/${number}` },
    });
    expect(issue.labels.map((l) => l.name)).toEqual(['bug']);
    expect(issue.labels[0]!.color).toBe('#d73a4a');
    expect(issue.status.category).toMatch(/unstarted|backlog/);

    // A redelivery (or the sync's own echo) changes nothing.
    await issueEvent('opened', number);
    const again = await trackerIssueFor(number);
    expect(again.version).toBe(issue.version);
    await drainTracker();
    expect(gh.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('says why on every tracker write it makes', async () => {
    const start = cursor;
    const repo = 'poietic-tech/reasons';
    gh.addRepo(repo);
    const { number } = gh.open(repo, { title: 'Why', labels: ['bug'] });
    await sync.onGitHub('github.issues.opened', gh.issuePayload('opened', repo, number));
    Object.assign(gh.issue(repo, number), { title: 'Why, edited' });
    await sync.onGitHub('github.issues.edited', gh.issuePayload('edited', repo, number));
    const comment = gh.comment(repo, number, 'A comment');
    await sync.onGitHub(
      'github.issue_comment.created',
      gh.commentPayload('created', repo, number, comment),
    );
    const payload = gh.issuePayload('deleted', repo, number);
    gh.repos.get(repo)!.issues.delete(number);
    await sync.onGitHub('github.issues.deleted', payload);

    const mine = (await agentTracker.events(start, TRACKER_EVENT_TYPES, 1000)).data.filter(
      (e) => e.actorId === selfId,
    );
    expect(mine.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'project.repo_added',
        'label.created',
        'issue.created',
        'issue.updated',
        'comment.created',
        'issue.deleted',
      ]),
    );
    for (const e of mine) expect((e.data as { reason?: string }).reason).toBeTruthy();
    const reasonOf = (type: string) =>
      (mine.find((e) => e.type === type)!.data as { reason?: string }).reason;
    expect(reasonOf('issue.updated')).toBe(`synced from GitHub issue ${repo}#${number}`);
    expect(reasonOf('comment.created')).toBe(
      `synced from a comment on GitHub issue ${repo}#${number}`,
    );
    expect(reasonOf('issue.deleted')).toBe(`GitHub issue ${repo}#${number} was deleted`);
    await drainTracker();
  });

  it('applies GitHub edits, closes and reopens to the tracker issue', async () => {
    const { number } = gh.open(REPO, { title: 'Old title' });
    await issueEvent('opened', number);

    Object.assign(gh.issue(REPO, number), { title: 'New title', body: 'Now with a body' });
    await issueEvent('edited', number);
    expect(await trackerIssueFor(number)).toMatchObject({
      title: 'New title',
      description: 'Now with a body',
    });

    Object.assign(gh.issue(REPO, number), { state: 'closed', state_reason: 'not_planned' });
    await issueEvent('closed', number);
    expect((await trackerIssueFor(number)).status.category).toBe('canceled');

    Object.assign(gh.issue(REPO, number), { state: 'open', state_reason: 'reopened' });
    await issueEvent('reopened', number);
    expect((await trackerIssueFor(number)).status.category).toMatch(/unstarted|backlog/);

    Object.assign(gh.issue(REPO, number), { state: 'closed', state_reason: 'completed' });
    await issueEvent('closed', number);
    expect((await trackerIssueFor(number)).status.category).toBe('completed');

    // None of that was written back to GitHub.
    await drainTracker();
    expect(gh.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('pushes tracker edits to GitHub, and ignores the webhook echo', async () => {
    const { number } = gh.open(REPO, { title: 'Edit me' });
    await issueEvent('opened', number);
    const issue = await trackerIssueFor(number);
    const done = await human.statusIn(issue.projectId, ['completed']);
    await human.ensureLabels(issue.projectId, ['triaged'], {}, 'test');
    await human.updateIssue(
      issue.id,
      {
        title: 'Edited in the tracker',
        description: 'Tracker body',
        status: done.id,
        labels: ['triaged'],
      },
      'edited by a person',
    );
    await drainTracker();

    const remote = gh.issue(REPO, number);
    expect(remote).toMatchObject({
      title: 'Edited in the tracker',
      state: 'closed',
      state_reason: 'completed',
    });
    expect(remote.body).toBe(`Tracker body\n\n<!-- poietic-issues:${issue.id} -->`);
    expect(remote.labels.map((l) => l.name)).toEqual(['triaged']);

    const before = await trackerIssueFor(number);
    await issueEvent('edited', number);
    await issueEvent('closed', number);
    expect((await trackerIssueFor(number)).version).toBe(before.version);
  });

  it('creates GitHub issues for new tracker issues in a mapped project, without a duplicate on the echo', async () => {
    const { number } = gh.open(REPO, { title: 'Seed the project' });
    await issueEvent('opened', number);
    const project = (await human.projectForRepo(REPO))!;

    const created = await human.createIssue(
      project.id,
      { title: 'Filed in the tracker', description: 'Hi' },
      'k1',
      'filed by a person',
    );
    await drainTracker();

    const remoteNumber = store.issueByTracker(created.id)!.number;
    const remote = gh.issue(REPO, remoteNumber);
    expect(remote).toMatchObject({ title: 'Filed in the tracker', state: 'open' });
    expect(remote.body).toBe(`Hi\n\n<!-- poietic-issues:${created.id} -->`);
    expect((await human.issue(created.id)).metadata[GITHUB_URL_KEY]).toBe(remote.html_url);

    // GitHub's `opened` webhook for the sync's own create.
    await issueEvent('opened', remoteNumber);
    const all: Issue[] = [];
    for await (const i of human.allIssues(project.id)) all.push(i);
    expect(all.filter((i) => i.title === 'Filed in the tracker')).toHaveLength(1);
  });

  it('adopts its own GitHub issue by marker when the link was never recorded', async () => {
    const seed = gh.open(REPO, { title: 'Seed' });
    await issueEvent('opened', seed.number);
    const project = (await human.projectForRepo(REPO))!;
    const created = await human.createIssue(
      project.id,
      { title: 'Crash before link' },
      'k2',
      'test',
    );
    await drainTracker();
    const number = store.issueByTracker(created.id)!.number;
    expect(gh.issue(REPO, number).title).toBe('Crash before link');

    // A fresh store, as if the process died after creating on GitHub.
    store = new Store(':memory:');
    sync = new Sync({
      store,
      tracker: agentTracker,
      github: new GitHub({ token: 'test', fetch: gh.fetch }),
      selfId,
      trackerUrl: 'https://issues.example.test',
      log: silentLogger,
    });
    await issueEvent('opened', number);
    expect(store.issueByGitHub(REPO, number)?.trackerId).toBe(created.id);
  });

  it('mirrors comments both ways, with edits and deletes, and skips its own copies', async () => {
    const { number } = gh.open(REPO, { title: 'Talk about it' });
    await issueEvent('opened', number);
    const issue = await trackerIssueFor(number);

    // GitHub → tracker
    const ghComment = gh.comment(REPO, number, 'From GitHub');
    await sync.onGitHub(
      'github.issue_comment.created',
      gh.commentPayload('created', REPO, number, ghComment),
    );
    let comments = (
      await human.api.GET('/issues/{issue}/comments', { params: { path: { issue: issue.id } } })
    ).data!.data;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('From GitHub');
    expect(comments[0]!.body).toContain('@octocat');

    ghComment.body = 'From GitHub, edited';
    await sync.onGitHub(
      'github.issue_comment.edited',
      gh.commentPayload('edited', REPO, number, ghComment),
    );
    comments = (
      await human.api.GET('/issues/{issue}/comments', { params: { path: { issue: issue.id } } })
    ).data!.data;
    expect(comments[0]!.body).toContain('From GitHub, edited');
    await drainTracker();
    expect(gh.issue(REPO, number).comments).toHaveLength(1);

    // tracker → GitHub
    const mine = await human.createComment(issue.id, 'From the tracker', 'c1', 'test');
    await drainTracker();
    const mirrored = gh.issue(REPO, number).comments[1]!;
    expect(mirrored.body).toContain('From the tracker');
    expect(mirrored.body).toContain(`<!-- poietic-issues:comment:${mine.id} -->`);
    // Its webhook is an echo.
    await sync.onGitHub(
      'github.issue_comment.created',
      gh.commentPayload('created', REPO, number, mirrored),
    );
    comments = (
      await human.api.GET('/issues/{issue}/comments', { params: { path: { issue: issue.id } } })
    ).data!.data;
    expect(comments).toHaveLength(2);

    await human.updateComment(mine.id, 'From the tracker, edited', 'test');
    await drainTracker();
    expect(gh.issue(REPO, number).comments[1]!.body).toContain('From the tracker, edited');

    await human.deleteComment(mine.id, 'test');
    await drainTracker();
    expect(gh.issue(REPO, number).comments).toHaveLength(1);

    // GitHub delete → tracker delete
    const removed = gh.issue(REPO, number).comments.pop()!;
    await sync.onGitHub(
      'github.issue_comment.deleted',
      gh.commentPayload('deleted', REPO, number, removed),
    );
    comments = (
      await human.api.GET('/issues/{issue}/comments', { params: { path: { issue: issue.id } } })
    ).data!.data;
    expect(comments.filter((c) => !c.deletedAt)).toHaveLength(0);
  });

  it('trashes the tracker issue when the GitHub issue is deleted, and closes GitHub when the tracker trashes', async () => {
    const one = gh.open(REPO, { title: 'Delete on GitHub' }).number;
    await issueEvent('opened', one);
    const first = store.issueByGitHub(REPO, one)!;
    const payload = gh.issuePayload('deleted', REPO, one);
    gh.repos.get(REPO)!.issues.delete(one);
    await sync.onGitHub('github.issues.deleted', payload);
    expect((await human.issue(first.trackerId)).deletedAt).not.toBeNull();

    const two = gh.open(REPO, { title: 'Trash in the tracker' }).number;
    await issueEvent('opened', two);
    const second = store.issueByGitHub(REPO, two)!;
    await human.trashIssue(second.trackerId, 'test');
    await drainTracker();
    expect(gh.issue(REPO, two)).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
  });

  it("gives a public repository's project public visibility, and follows visibility changes", async () => {
    const repo = 'poietic-tech/stix-rust';
    gh.addRepo(repo, 'STIX patterns in Rust', false);
    const { number } = gh.open(repo, { title: 'Public issue' });
    await issueEvent('opened', number, repo);
    let project = (await human.projectForRepo(repo))!;
    expect(project).toMatchObject({ key: 'SR', name: 'Stix Rust', visibility: 'public' });

    gh.repos.get(repo)!.private = true;
    await sync.onGitHub('github.repository.privatized', gh.repositoryPayload('privatized', repo));
    human.invalidate();
    project = (await human.projectForRepo(repo))!;
    expect(project.visibility).toBe('private');

    // A project shared with another repository keeps its visibility.
    await human.api.POST('/projects/{project}/repos', {
      params: { path: { project: project.id } },
      body: { repo: 'poietic-tech/other' },
    });
    gh.repos.get(repo)!.private = false;
    await sync.onGitHub('github.repository.publicized', gh.repositoryPayload('publicized', repo));
    human.invalidate();
    expect((await human.projectForRepo(repo))!.visibility).toBe('private');
  });

  it('leaves excluded repositories and pull requests alone', async () => {
    const owned = gh.open('poietic-tech/persistent-agents', {
      title: 'Owned by the intake',
    }).number;
    await issueEvent('opened', owned, 'poietic-tech/persistent-agents');
    expect(store.issueByGitHub('poietic-tech/persistent-agents', owned)).toBeUndefined();

    const { number } = gh.open(REPO, { title: 'A pull request' });
    const payload = gh.issuePayload('opened', REPO, number);
    await sync.onGitHub('github.issues.opened', {
      ...payload,
      issue: { ...payload.issue, pull_request: {} },
    });
    expect(store.issueByGitHub(REPO, number)).toBeUndefined();
  });

  it('keeps tracker issues of projects without a repository to itself', async () => {
    const project = await createProject(t.ctx, { key: 'SOLO', name: 'Solo' });
    await human.createIssue(project.id, { title: 'Tracker only' }, 'k3', 'test');
    await drainTracker();
    expect(gh.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('rebuilds lost links from the tracker metadata', async () => {
    const { number } = gh.open(REPO, { title: 'Remember me' });
    await issueEvent('opened', number);
    const link = store.issueByGitHub(REPO, number)!;
    store = new Store(':memory:');
    sync = new Sync({
      store,
      tracker: agentTracker,
      github: new GitHub({ token: 'test', fetch: gh.fetch }),
      selfId,
      trackerUrl: 'https://issues.example.test',
      log: silentLogger,
    });
    expect(await sync.rebuild()).toBeGreaterThan(0);
    expect(store.issueByGitHub(REPO, number)?.trackerId).toBe(link.trackerId);
  });
});
