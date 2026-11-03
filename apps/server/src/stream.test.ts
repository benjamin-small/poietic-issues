import {
  actorForUser,
  addMember,
  createIssue,
  createLink,
  createProject,
  createSession,
  createUser,
  deleteAttachment,
  deleteIssue,
  EventTailer,
  latestEventSeq,
  listEvents,
  LocalDiskBlobStore,
  removeGroupGrant,
  removeMember,
  setGroupGrant,
  updateIssue,
  updateProject,
  updateUser,
  uploadAttachment,
} from '@poietic-tech/issues-core';
import type { TrackerEvent } from '@poietic-tech/issues-schema';
import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { testSso } from './testing.ts';

let t: TestContext;
let tailer: EventTailer;
let app: ReturnType<typeof createApp>;
let token: string;
let memberToken: string;
let sso: ReturnType<typeof testSso>;

beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'SSE', name: 'SSE' });
  await createProject(t.ctx, { key: 'OTH', name: 'Other' });
  await createProject(t.ctx, { key: 'PUB', name: 'Public', visibility: 'public' });
  tailer = new EventTailer(t.db, { intervalMs: 50 });
  await tailer.start();
  sso = testSso(t);
  app = createApp({ db: t.db, tailer, auth: { mode: 'standard', sso: sso.options } });
  token = await sso.bearer('admin');
  memberToken = await sso.bearer('member');
});
afterAll(async () => {
  await tailer.stop();
  await t.destroy();
});

interface Message {
  id?: string;
  event?: string;
  data?: string;
}

/** Resolves once `messages` satisfies `pred`, i.e. once the stream has actually delivered what we wait for. */
async function delivered(messages: Message[], pred: (m: Message[]) => boolean) {
  const deadline = Date.now() + 5000;
  while (!pred(messages)) {
    if (Date.now() > deadline) throw new Error('the stream did not deliver in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Opens the stream and collects parsed SSE messages until `done` returns true. */
async function collect(
  query: string,
  headers: Record<string, string>,
  done: (m: Message[]) => boolean,
  /** Runs once the stream is ready, alongside reading it; gets the messages delivered so far. */
  act?: (messages: Message[]) => Promise<void>,
  bearer: string | null = token,
  via: ReturnType<typeof createApp> = app,
) {
  const controller = new AbortController();
  const res = await via.request(`http://t/api/v1/events/stream${query}`, {
    headers: { ...(bearer && { authorization: `Bearer ${bearer}` }), ...headers },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: Message[] & { ended?: boolean } = [];
  let buffer = '';
  let acting: Promise<void> | undefined;
  // A failing `act` ends the wait at once and is reported as such, rather than as a stream that went quiet.
  let actError: Error | undefined;
  let actFailed!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => (actFailed = reject));
  failure.catch(() => {}); // reported through `actError` once the loop is done with it
  const deadline = Date.now() + 5000;
  try {
    while (!done(messages) && Date.now() < deadline) {
      const { value, done: end } = await Promise.race([reader.read(), failure]);
      if (end) {
        messages.ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const msg: Message = {};
        for (const line of block.split('\n')) {
          const [k, ...rest] = line.split(':');
          const v = rest.join(':').replace(/^ /, '');
          if (k === 'id' || k === 'event' || k === 'data') msg[k] = v;
        }
        if (msg.event || msg.data) messages.push(msg);
      }
      if (!acting && messages.some((m) => m.event === 'ready') && act)
        acting = act(messages).catch((error: unknown) => {
          actError = new Error(`the test's act failed: ${String(error)}`, { cause: error });
          actFailed(actError);
        });
    }
    // An act still running when the stream ended can fail after the loop; that is still the test's failure.
    await acting;
    if (actError) throw actError;
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return messages;
}

describe(`SSE /events/stream (${testDialect()})`, () => {
  it('streams new events live, filtered by project', async () => {
    const messages = await collect(
      '?project=SSE',
      {},
      (m) => m.some((x) => x.event === 'issue.created'),
      async () => {
        await createIssue(t.ctx, 'OTH', { title: 'not for this stream' });
        await createIssue(t.ctx, 'SSE', { title: 'live!' });
      },
    );
    const created = messages.filter((m) => m.event === 'issue.created');
    expect(created).toHaveLength(1);
    const event = JSON.parse(created[0]!.data!);
    expect(event.data.issue.title).toBe('live!');
    expect(created[0]!.id).toBe(String(event.seq));
  });

  it('replays missed events after Last-Event-ID', async () => {
    const before = tailer.lastSeq;
    await createIssue(t.ctx, 'SSE', { title: 'missed 1' });
    await createIssue(t.ctx, 'SSE', { title: 'missed 2' });
    const messages = await collect(
      '',
      { 'last-event-id': String(before) },
      (m) => m.filter((x) => x.event === 'issue.created').length >= 2,
    );
    const titles = messages
      .filter((m) => m.event === 'issue.created')
      .map((m) => JSON.parse(m.data!).data.issue.title);
    expect(titles).toEqual(['missed 1', 'missed 2']);
  });

  /** Issue titles of the `issue.created` messages received. */
  const titles = (messages: Message[]) =>
    messages
      .filter((m) => m.event === 'issue.created')
      .map((m) => JSON.parse(m.data!).data.issue.title as string);
  const sawTitle = (title: string) => (m: Message[]) => titles(m).includes(title);

  it('streams only what the viewer can read', async () => {
    let seq = 0;
    const act = async () => {
      const n = ++seq;
      const prv = await createIssue(t.ctx, 'OTH', { title: `private ${n}` });
      const pub = await createIssue(t.ctx, 'PUB', { title: `public ${n}` });
      await createLink(t.ctx, pub.key, { type: 'relates', target: prv.key });
      await createUser(t.ctx, { handle: `sse-user-${n}`, name: 'SSE', email: `u${n}@x.io` });
      await createIssue(t.ctx, 'PUB', { title: `done ${n}` });
    };

    const member = await collect('', {}, sawTitle('done 1'), act, memberToken);
    expect(titles(member)).toEqual(['public 1', 'done 1']);
    expect(member.some((m) => m.event?.startsWith('link.'))).toBe(false);
    const users = member.filter((m) => m.event === 'user.created');
    expect(users).toHaveLength(1);
    expect(JSON.parse(users[0]!.data!).data.user.email).toBeNull();

    const anonymous = await collect('', {}, sawTitle('done 2'), act, null);
    expect(titles(anonymous)).toEqual(['public 2', 'done 2']);
    expect(anonymous.some((m) => m.event?.startsWith('link.'))).toBe(false);
    expect(anonymous.some((m) => m.event?.startsWith('user.'))).toBe(false);

    const admin = await collect('', {}, sawTitle('done 3'), act);
    expect(titles(admin)).toEqual(['private 3', 'public 3', 'done 3']);
    expect(admin.some((m) => m.event === 'link.created')).toBe(true);
    const adminUsers = admin.filter((m) => m.event === 'user.created');
    expect(JSON.parse(adminUsers[0]!.data!).data.user.email).toBe('u3@x.io');
  });

  it('follows membership changes while the stream is open', async () => {
    const messages = await collect(
      '',
      {},
      sawTitle('after removal marker'),
      async (seen) => {
        await createIssue(t.ctx, 'OTH', { title: 'before grant' });
        await addMember(t.ctx, 'OTH', { user: 'member', role: 'viewer' });
        await createIssue(t.ctx, 'OTH', { title: 'after grant' });
        // The stream reads access as of when it handles a membership event, so let it deliver the
        // issue made while the viewer was a member before that membership is taken away.
        await delivered(seen, sawTitle('after grant'));
        await removeMember(t.ctx, 'OTH', 'member');
        await createIssue(t.ctx, 'OTH', { title: 'after removal' });
        await createIssue(t.ctx, 'PUB', { title: 'after removal marker' });
      },
      memberToken,
    );
    expect(titles(messages)).toEqual(['after grant', 'after removal marker']);
  });

  it('picks up projects created while the stream is open', async () => {
    const messages = await collect(
      '',
      {},
      sawTitle('in a new public project'),
      async () => {
        await createProject(t.ctx, { key: 'NEWP', name: 'New', visibility: 'public' });
        await createIssue(t.ctx, 'NEWP', { title: 'in a new public project' });
      },
      null,
    );
    expect(messages.some((m) => m.event === 'project.created')).toBe(true);
    expect(titles(messages)).toEqual(['in a new public project']);
  });

  it('loses nothing committed while the stream sets up, and honours a revoke from then', async () => {
    await addMember(t.ctx, 'OTH', { user: 'member', role: 'viewer' });
    const before = (await listEvents(t.ctx, { limit: 1000 })).data.at(-1)!.seq;
    await removeMember(t.ctx, 'OTH', 'member');
    await createIssue(t.ctx, 'OTH', { title: 'after setup revoke' });
    await createIssue(t.ctx, 'PUB', { title: 'setup marker' });
    const pending = (await listEvents(t.ctx, { after: before })).data;
    // A tailer that delivers these events the moment the route reads its position, i.e. while the
    // connection is still setting up: anything not subscribed by then misses them.
    const listeners = new Set<(e: TrackerEvent) => void>();
    const racing = {
      get lastSeq() {
        for (const e of pending.splice(0)) for (const l of listeners) l(e);
        return before;
      },
      subscribe(l: (e: TrackerEvent) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as EventTailer;
    const racingApp = createApp({
      db: t.db,
      tailer: racing,
      auth: { mode: 'standard', sso: sso.options },
    });
    const messages = await collect(
      '',
      {},
      sawTitle('setup marker'),
      undefined,
      memberToken,
      racingApp,
    );
    expect(titles(messages)).toEqual(['setup marker']);
    // The removal itself is after the stream's position: it arrives, without content.
    expect(
      messages
        .filter((m) => m.event === 'project.member_removed')
        .map((m) => JSON.parse(m.data!).data),
    ).toEqual([{ member: { user: { id: t.member.actor.id } } }]);
  });

  it('drops its subscription when setting up the stream fails', async () => {
    const listeners = new Set<(e: TrackerEvent) => void>();
    const counting = {
      lastSeq: 0,
      subscribe(l: (e: TrackerEvent) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as EventTailer;
    // The access read is the first database call of an anonymous stream; make it fail.
    const broken = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'kysely') throw new Error('database unavailable');
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const brokenApp = createApp({
      db: broken,
      tailer: counting,
      auth: { mode: 'standard', sso: sso.options },
    });
    const res = await brokenApp.request('http://t/api/v1/events/stream');
    const reader = res.body!.getReader();
    while (!(await reader.read()).done);
    expect(listeners.size).toBe(0);
  });

  it('lets anonymous viewers stream public projects, and hides private ones', async () => {
    const res = await app.request('http://t/api/v1/events/stream?project=OTH');
    expect(res.status).toBe(404);
    const messages = await collect(
      '?project=PUB',
      {},
      sawTitle('anonymous live'),
      async () => {
        await createIssue(t.ctx, 'PUB', { title: 'anonymous live' });
      },
      null,
    );
    expect(titles(messages)).toEqual(['anonymous live']);
  });

  /** A tailer the test drives by hand: `emit` delivers events synchronously to every subscriber. */
  function manualTailer(lastSeq = 0) {
    const listeners = new Set<(e: TrackerEvent) => void>();
    const tailer = {
      lastSeq,
      subscribe(l: (e: TrackerEvent) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const emit = (events: TrackerEvent[]) => {
      for (const e of events) {
        tailer.lastSeq = Math.max(tailer.lastSeq, e.seq);
        for (const l of listeners) l(e);
      }
    };
    return { tailer: tailer as unknown as EventTailer, emit, listeners };
  }

  it('sends reset and closes when more than 1000 events are pending', async () => {
    const template = (await listEvents(t.ctx, { limit: 1 })).data[0]!;
    const { tailer: manual, emit, listeners } = manualTailer(10_000);
    const flooded = createApp({
      db: t.db,
      tailer: manual,
      auth: { mode: 'standard', sso: sso.options },
    });
    const events = Array.from({ length: 1001 }, (_, k) => ({ ...template, seq: 10_001 + k }));
    const messages = await collect(
      '',
      {},
      () => false,
      async () => emit(events), // synchronously: nothing is drained in between
      token,
      flooded,
    );
    expect(messages.ended).toBe(true);
    const reset = messages.filter((m) => m.event === 'reset');
    expect(reset).toHaveLength(1);
    // Same shape as the replay reset: resume after the newest seq, then refetch.
    expect(reset[0]!.id).toBe('11001');
    expect(JSON.parse(reset[0]!.data!)).toEqual({ seq: 11001 });
    expect(messages.at(-1)!.event).toBe('reset');
    expect(listeners.size).toBe(0);
  });

  it('keeps streaming when 1000 events are pending', async () => {
    const template = (await listEvents(t.ctx, { limit: 1 })).data[0]!;
    const { tailer: manual, emit } = manualTailer(20_000);
    const app1000 = createApp({
      db: t.db,
      tailer: manual,
      auth: { mode: 'standard', sso: sso.options },
    });
    const events = Array.from({ length: 1000 }, (_, k) => ({ ...template, seq: 20_001 + k }));
    const messages = await collect(
      '',
      {},
      (m) => m.filter((x) => x.id?.startsWith('2')).length >= 1000,
      async () => emit(events),
      token,
      app1000,
    );
    expect(messages.some((m) => m.event === 'reset')).toBe(false);
    expect(messages.filter((m) => m.event === template.type)).toHaveLength(1000);
  });

  it('ends a stream when the session it authenticated with expires', async () => {
    const admin = (await actorForUser(t.ctx, 'admin'))!;
    const realClock = { now: () => new Date() };
    const { cookie } = await createSession({ db: t.db, clock: realClock }, admin.id, 400);
    const started = Date.now();
    const messages = await collect(
      '',
      { cookie: `poietic_issues_session=${cookie}` },
      () => false,
      undefined,
      null,
    );
    expect(messages.ended).toBe(true);
    expect(messages.map((m) => m.event)).toEqual(['ready']);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("ends an identity-token stream once the issuer says the token's session has ended", async () => {
    let alive = true;
    const ISS = 'https://auth.example.test';
    const ssoApp = createApp({
      db: t.db,
      tailer,
      auth: {
        mode: 'standard',
        sso: {
          name: 'Example',
          cookie: 'example_session',
          issuer: ISS,
          loginUrl: `${ISS}/login`,
          adminRole: 'admin',
          verifier: {
            verify: async (token) => ({
              iss: ISS,
              aud: 'x',
              sub: token,
              name: 'Streamer',
              role: 'admin',
              groups: [],
              kind: 'human',
              owner: null,
              sid: 's1',
              iat: 0,
              exp: Math.floor(Date.now() / 1000) + 600,
            }),
          },
          liveness: { isLive: async () => alive },
        },
      },
    });
    const messages = await collect(
      '?project=SSE',
      {},
      () => false,
      async () => {
        alive = false;
        await createIssue(t.ctx, 'SSE', { title: 'after revocation' });
      },
      'streamer-1',
      ssoApp,
    );
    expect(messages.ended).toBe(true);
    expect(messages.map((m) => m.event)).toEqual(['ready']);
  });

  it("closes the viewer's stream when a user.updated event names them", async () => {
    const messages = await collect(
      '',
      {},
      () => false,
      async () => {
        await updateUser(t.ctx, 'bot', { name: 'Bot renamed' });
        await updateUser(t.ctx, 'member', { name: 'Member renamed' });
      },
      memberToken,
    );
    expect(messages.ended).toBe(true);
    const updates = messages
      .filter((m) => m.event === 'user.updated')
      .map((m) => JSON.parse(m.data!).data.user.handle);
    // Someone else's update streams on; the viewer's own is delivered, then the stream ends.
    expect(updates).toEqual(['bot', 'member']);
    expect(messages.at(-1)!.event).toBe('user.updated');
  });

  it('closes a project stream too when a user.updated event names the viewer', async () => {
    const messages = await collect(
      '?project=PUB',
      {},
      () => false,
      async () => {
        await updateUser(t.ctx, 'bot', { name: 'Bot renamed on PUB' });
        await createIssue(t.ctx, 'PUB', { title: 'before the change' });
        await updateUser(t.ctx, 'member', { name: 'Member renamed on PUB' });
        await createIssue(t.ctx, 'PUB', { title: 'after the change' });
      },
      memberToken,
    );
    expect(messages.ended).toBe(true);
    // Other users' user.* events stay off a project stream; the viewer's own is delivered, then the stream ends.
    expect(
      messages
        .filter((m) => m.event === 'user.updated')
        .map((m) => JSON.parse(m.data!).data.user.handle),
    ).toEqual(['member']);
    expect(
      messages
        .filter((m) => m.event === 'issue.created')
        .map((m) => JSON.parse(m.data!).data.issue.title),
    ).toEqual(['before the change']);
    expect(messages.at(-1)!.event).toBe('user.updated');
  });

  it('logs a failed access read with the request id before closing', async () => {
    const lines: Record<string, unknown>[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        for (const line of chunk.toString().split('\n'))
          if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
        done();
      },
    });
    const broken = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'kysely') throw new Error('database unavailable');
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const { tailer: manual } = manualTailer();
    const logged = createApp({
      db: broken,
      tailer: manual,
      logger: pino({ level: 'error' }, sink),
    });
    const res = await logged.request('http://t/api/v1/events/stream', {
      headers: { 'x-request-id': 'req-stream-1' },
    });
    const reader = res.body!.getReader();
    while (!(await reader.read()).done);
    const errors = lines.filter((l) => l.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      requestId: 'req-stream-1',
      err: { message: 'database unavailable' },
    });
  });

  it('gives readers a content-free tombstone for a trashed issue, live and on replay', async () => {
    const watch = async (bearer: string | null, n: number) => {
      // Created before the stream opens, so every event about it is processed after it is trashed or not at all.
      const doomed = await createIssue(t.ctx, 'PUB', { title: `to be trashed ${n}` });
      await updateIssue(t.ctx, doomed.key, { title: `renamed then trashed ${n}` });
      // …and seen by the tailer, so the stream starts after it rather than receiving it live.
      const created = await latestEventSeq(t.ctx);
      while (tailer.lastSeq < created) await new Promise((r) => setTimeout(r, 10));
      const messages = await collect(
        '?project=PUB',
        {},
        sawTitle(`trash marker ${n}`),
        async () => {
          await deleteIssue(t.ctx, doomed.key);
          await createIssue(t.ctx, 'PUB', { title: `trash marker ${n}` });
        },
        bearer,
      );
      return { messages, doomed, created };
    };
    for (const [n, bearer] of [null, memberToken].entries()) {
      const { messages, doomed, created } = await watch(bearer, n);
      expect(titles(messages)).toEqual([`trash marker ${n}`]);
      const about = messages.filter((m) => m.data?.includes(doomed.id));
      // Only the deletion arrives, with the id and key the client needs to drop the row, and nothing else.
      expect(about.map((m) => m.event)).toEqual(['issue.deleted']);
      expect(JSON.parse(about[0]!.data!).data).toEqual({
        issue: { id: doomed.id, key: doomed.key },
      });
      // A reconnect replays the same.
      const replayed = await collect(
        '?project=PUB',
        { 'last-event-id': String(created) },
        sawTitle(`trash marker ${n}`),
        undefined,
        bearer,
      );
      expect(
        replayed.filter((m) => m.data?.includes(doomed.id)).map((m) => [m.event, m.data]),
      ).toEqual(about.map((m) => [m.event, m.data]));
    }
    const admin = await watch(token, 9);
    const deleted = admin.messages.filter((m) => m.event === 'issue.deleted');
    expect(deleted).toHaveLength(1);
    expect(JSON.parse(deleted[0]!.data!).data.issue.title).toBe('renamed then trashed 9');
  });

  it('gives readers a content-free tombstone for a deleted attachment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sse-blobs-'));
    try {
      const blobs = new LocalDiskBlobStore(dir);
      const issue = await createIssue(t.ctx, 'PUB', { title: 'has a file' });
      const upload = await uploadAttachment(t.ctx, blobs, issue.key, {
        filename: 'secret-name.txt',
        data: new TextEncoder().encode('bytes'),
      });
      for (const bearer of [null, memberToken, token]) {
        const file =
          bearer === null
            ? upload
            : await uploadAttachment(t.ctx, blobs, issue.key, {
                filename: 'secret-name.txt',
                data: new TextEncoder().encode('bytes'),
              });
        const marker = `attachment marker ${String(bearer)}`;
        const messages = await collect(
          '?project=PUB',
          {},
          sawTitle(marker),
          async () => {
            await deleteAttachment(t.ctx, blobs, file.id);
            await createIssue(t.ctx, 'PUB', { title: marker });
          },
          bearer,
        );
        const deleted = messages.filter((m) => m.event === 'attachment.deleted');
        expect(deleted).toHaveLength(1);
        const data = JSON.parse(deleted[0]!.data!).data;
        if (bearer === token) expect(data.attachment.filename).toBe('secret-name.txt');
        else
          expect(data).toEqual({
            issue: { id: issue.id, key: issue.key },
            attachment: { id: file.id },
          });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells a viewer removed from a private project, without content, and ends a stream on it', async () => {
    await createProject(t.ctx, { key: 'GONE', name: 'Gone' });
    await addMember(t.ctx, 'GONE', { user: 'member', role: 'viewer' });
    const memberId = t.member.actor.id;
    const messages = await collect(
      '?project=GONE',
      {},
      () => false,
      async () => {
        await createIssue(t.ctx, 'GONE', { title: 'while a member' });
        await removeMember(t.ctx, 'GONE', 'member');
        await createIssue(t.ctx, 'GONE', { title: 'after the removal' });
      },
      memberToken,
    );
    expect(messages.ended).toBe(true);
    expect(titles(messages)).toEqual(['while a member']);
    const removed = messages.filter((m) => m.event === 'project.member_removed');
    expect(removed).toHaveLength(1);
    expect(JSON.parse(removed[0]!.data!).data).toEqual({ member: { user: { id: memberId } } });
    expect(messages.at(-1)!.event).toBe('project.member_removed');
  });

  it('keeps an unfiltered stream open after the viewer loses a project, and says so once', async () => {
    await createProject(t.ctx, { key: 'GONE2', name: 'Gone too' });
    await addMember(t.ctx, 'GONE2', { user: 'member', role: 'viewer' });
    await addMember(t.ctx, 'GONE2', { user: 'bot', role: 'viewer' });
    const messages = await collect(
      '',
      {},
      sawTitle('still streaming'),
      async (seen) => {
        await removeMember(t.ctx, 'GONE2', 'bot'); // someone else: the viewer can still read it
        // Access is read as of when the stream handles a membership event, so let this one arrive first.
        await delivered(seen, (m) => m.some((x) => x.event === 'project.member_removed'));
        await removeMember(t.ctx, 'GONE2', 'member');
        await createIssue(t.ctx, 'GONE2', { title: 'hidden now' });
        await createIssue(t.ctx, 'PUB', { title: 'still streaming' });
      },
      memberToken,
    );
    expect(titles(messages)).toEqual(['still streaming']);
    const removed = messages
      .filter((m) => m.event === 'project.member_removed')
      .map(
        (m) => JSON.parse(m.data!).data as { member: { user: { id: string; handle?: string } } },
      );
    // Bot's removal is visible in full; the viewer's own one arrives without content.
    expect(removed.map((d) => d.member.user.handle)).toEqual(['bot', undefined]);
    expect(removed[1]).toEqual({ member: { user: { id: t.member.actor.id } } });
  });

  it("starts delivering a project once the viewer's group is granted, and stops after the grant is removed", async () => {
    await createProject(t.ctx, { key: 'GRP', name: 'Group' });
    const teamToken = await sso.bearer('member', ['team']);
    const messages = await collect(
      '',
      {},
      sawTitle('after removal public'),
      async (seen) => {
        await createIssue(t.ctx, 'GRP', { title: 'before grant' });
        await setGroupGrant(t.ctx, 'GRP', 'team', { role: 'viewer' });
        await delivered(seen, (m) => m.some((x) => x.event === 'project.group_grant_added'));
        await createIssue(t.ctx, 'GRP', { title: 'while granted' });
        await delivered(seen, (m) => titles(m).includes('while granted'));
        await removeGroupGrant(t.ctx, 'GRP', 'team');
        await delivered(seen, (m) => m.some((x) => x.event === 'project.group_grant_removed'));
        await createIssue(t.ctx, 'GRP', { title: 'after removal' });
        await createIssue(t.ctx, 'PUB', { title: 'after removal public' });
      },
      teamToken,
    );
    expect(titles(messages)).toEqual(['while granted', 'after removal public']);
    const removed = messages.filter((m) => m.event === 'project.group_grant_removed');
    expect(removed).toHaveLength(1);
    // The viewer's own access ended with it, so it arrives without content.
    expect(JSON.parse(removed[0]!.data!).data).toEqual({ grant: { group: 'team' } });
  });

  it('tells anonymous viewers when a public project goes private, without content, and ends the stream', async () => {
    await createProject(t.ctx, { key: 'SHUT', name: 'Shutting', visibility: 'public' });
    const messages = await collect(
      '?project=SHUT',
      {},
      () => false,
      async () => {
        await createIssue(t.ctx, 'SHUT', { title: 'while public' });
        await updateProject(t.ctx, 'SHUT', { visibility: 'private', name: 'Secret name' });
        await createIssue(t.ctx, 'SHUT', { title: 'while private' });
      },
      null,
    );
    expect(messages.ended).toBe(true);
    expect(titles(messages)).toEqual(['while public']);
    const updated = messages.filter((m) => m.event === 'project.updated');
    expect(updated).toHaveLength(1);
    expect(JSON.parse(updated[0]!.data!).data).toEqual({});
    expect(messages.some((m) => m.data?.includes('Secret name'))).toBe(false);
  });

  it('reports a failing act as the failure', async () => {
    await expect(
      collect(
        '?project=PUB',
        {},
        () => false,
        () => Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow("the test's act failed: Error: boom");
  });
});
