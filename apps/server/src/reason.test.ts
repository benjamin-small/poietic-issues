import { WebhookRunner } from '@poietic-tech/issues-core';
import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { testSso } from './testing.ts';

let t: TestContext;
let app: ReturnType<typeof createApp>;
let admin: string;
let receiver: Server;
let receiverUrl: string;
const received: string[] = [];

beforeAll(async () => {
  t = await createTestContext();
  const sso = testSso(t);
  app = createApp({
    db: t.db,
    clock: t.ctx.clock,
    webhooks: { allowPrivate: true },
    auth: { mode: 'standard', sso: sso.options },
  });
  admin = await sso.bearer('admin');
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/in`;
  await call('POST', '/projects', { key: 'WHY', name: 'Reasons' });
});
afterAll(async () => {
  receiver.close();
  await t.destroy();
});

async function call(method: string, path: string, body?: unknown, reason?: string) {
  const res = await app.request(`http://t/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(reason !== undefined && { 'x-change-reason': reason }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
}

async function newIssue(): Promise<string> {
  return (await call('POST', '/projects/WHY/issues', { title: 'Why' })).body.key as string;
}

async function lastEvent(key: string) {
  const activity = await call('GET', `/issues/${key}/activity`);
  return activity.body.data.at(-1) as { seq: number; data: Record<string, unknown> };
}

describe(`X-Change-Reason (${testDialect()})`, () => {
  it('a reason is stored on the event', async () => {
    const key = await newIssue();
    expect(
      (await call('PATCH', `/issues/${key}`, { priority: 1 }, 'triaged as a bug')).status,
    ).toBe(200);
    const event = await lastEvent(key);
    expect(event.data.reason).toBe('triaged as a bug');
    expect(event.data.requestId).toEqual(expect.any(String));
    const events = await call('GET', `/events?after=${event.seq - 1}&limit=1`);
    expect(events.body.data[0].data.reason).toBe('triaged as a bug');
  });

  it('a percent-encoded reason is decoded', async () => {
    const key = await newIssue();
    const reason = 'handed off — see “plan”';
    await call('PATCH', `/issues/${key}`, { priority: 2 }, encodeURIComponent(reason));
    expect((await lastEvent(key)).data.reason).toBe(reason);
  });

  it('a bad reason is refused, and nothing is recorded', async () => {
    const key = await newIssue();
    const before = (await lastEvent(key)).seq;
    for (const reason of ['%E0%A4%A', 'x'.repeat(201), 'a%0Ab']) {
      const res = await call('PATCH', `/issues/${key}`, { priority: 3 }, reason);
      expect(res.status, reason).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect((await lastEvent(key)).seq).toBe(before);
    const long = 'é'.repeat(200);
    await call('PATCH', `/issues/${key}`, { priority: 4 }, encodeURIComponent(long));
    expect((await lastEvent(key)).data.reason).toBe(long);
  });

  it('a raw non-ASCII reason is refused, not stored garbled', async () => {
    const key = await newIssue();
    const before = (await lastEvent(key)).seq;
    // Header bytes arrive as Latin-1: unencoded UTF-8 would be stored as mojibake.
    for (const raw of ['café', 'cafÃ©']) {
      const res = await call('PATCH', `/issues/${key}`, { priority: 3 }, raw);
      expect(res.status, raw).toBe(400);
    }
    expect((await lastEvent(key)).seq).toBe(before);
  });

  it('emoji and separators: an encoded emoji is kept exactly; a line separator is refused', async () => {
    const key = await newIssue();
    const reason = `shipped 🚀 ${'🎉'.repeat(150)}`;
    await call('PATCH', `/issues/${key}`, { priority: 2 }, encodeURIComponent(reason));
    expect((await lastEvent(key)).data.reason).toBe(reason);
    for (const sep of ['\u2028', '\u2029']) {
      const res = await call(
        'PATCH',
        `/issues/${key}`,
        { priority: 1 },
        encodeURIComponent(`a${sep}b`),
      );
      expect(res.status).toBe(400);
    }
  });

  it('a reason on a read is ignored', async () => {
    const res = await call('GET', '/projects/WHY', undefined, '%E0%A4%A');
    expect(res.status).toBe(200);
  });

  it('no reason, no key; a blank reason is no reason', async () => {
    const key = await newIssue();
    expect((await lastEvent(key)).data).not.toHaveProperty('reason');
    await call('PATCH', `/issues/${key}`, { priority: 1 }, '   ');
    expect((await lastEvent(key)).data).not.toHaveProperty('reason');
  });

  it('a reason goes out in full webhooks', async () => {
    const hook = await call('POST', '/webhooks', {
      url: receiverUrl,
      eventTypes: ['issue.updated'],
      project: 'WHY',
    });
    const key = await newIssue();
    await call('PATCH', `/issues/${key}`, { priority: 2 }, 'escalated');
    await new WebhookRunner(t.db, { policy: { allowPrivate: true }, clock: t.ctx.clock }).runOnce();
    expect(received.map((b) => JSON.parse(b).data.reason)).toContain('escalated');
    await call('DELETE', `/webhooks/${hook.body.id}`);
  });
});
