import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProject, verifyWebhook, WebhookRunner } from '@poietic-tech/issues-core';
import { createTestContext, type TestContext } from '@poietic-tech/issues-core/testing';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, generateOpenApiDocument } from './app.ts';
import { testSso } from './testing.ts';

let t: TestContext;
let app: ReturnType<typeof createApp>;
let admin: string;
let member: string;
let sso: ReturnType<typeof testSso>;
let receiver: Server;
let receiverUrl: string;
const received: Array<{ headers: Record<string, string>; body: string }> = [];

beforeAll(async () => {
  t = await createTestContext();
  await createProject(t.ctx, { key: 'HOOK', name: 'Hooks' });
  sso = testSso(t);
  app = createApp({
    db: t.db,
    clock: t.ctx.clock,
    webhooks: { allowPrivate: true },
    auth: { mode: 'standard', sso: sso.options },
  });
  admin = await sso.bearer('admin');
  member = await sso.bearer('member');
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string>, body });
      res.writeHead(200).end('thanks');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/in`;
});
afterAll(async () => {
  receiver.close();
  await t.destroy();
});

function call(method: string, path: string, body?: unknown, token = admin) {
  return app.request(`http://t/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

describe(`webhooks API (${testDialect()})`, () => {
  it('registers a webhook, delivers signed events, and exposes the delivery log', async () => {
    const res = await call('POST', '/webhooks', {
      url: receiverUrl,
      eventTypes: ['issue.created', 'comment.*'],
      project: 'HOOK',
    });
    expect(res.status).toBe(201);
    const hook = (await res.json()) as { id: string; secret: string; projectId: string };
    expect(hook.secret).toMatch(/^whsec_/);
    const fetched = (await (await call('GET', `/webhooks/${hook.id}`)).json()) as object;
    expect(fetched).not.toHaveProperty('secret');

    const ping = await call('POST', `/webhooks/${hook.id}/test`);
    expect(await ping.json()).toMatchObject({ ok: true, statusCode: 200, response: 'thanks' });
    received.length = 0;

    const issue = (await (
      await call('POST', '/projects/HOOK/issues', { title: 'Delivered' })
    ).json()) as { key: string };
    await call('PATCH', `/issues/${issue.key}`, { priority: 2 }); // not subscribed
    await call('POST', `/issues/${issue.key}/comments`, { body: 'hi' });

    const runner = new WebhookRunner(t.db, { policy: { allowPrivate: true }, clock: t.ctx.clock });
    await runner.runOnce();
    expect(received.map((r) => JSON.parse(r.body).type)).toEqual(
      expect.arrayContaining(['issue.created', 'comment.created']),
    );
    expect(received).toHaveLength(2);
    for (const r of received)
      expect(() =>
        verifyWebhook(hook.secret, r.headers, r.body, { toleranceSeconds: 1e10 }),
      ).not.toThrow();

    const log = (await (await call('GET', `/webhooks/${hook.id}/deliveries`)).json()) as {
      data: Array<{ id: string; status: string; eventType: string }>;
    };
    expect(log.data.map((d) => d.eventType)).toEqual(['comment.created', 'issue.created']);
    expect(log.data.every((d) => d.status === 'succeeded')).toBe(true);

    const again = await call('POST', `/webhook-deliveries/${log.data[0]!.id}/redeliver`);
    expect(await again.json()).toMatchObject({ status: 'pending', attempts: 0 });
    await runner.runOnce();
    expect(received).toHaveLength(3);
    expect(received[2]!.headers['webhook-id']).toBe(log.data[0]!.id);

    const rotated = (await (await call('POST', `/webhooks/${hook.id}/rotate-secret`)).json()) as {
      secret: string;
    };
    expect(rotated.secret).not.toBe(hook.secret);
    expect((await call('DELETE', `/webhooks/${hook.id}`)).status).toBe(200);
    expect((await call('GET', `/webhooks/${hook.id}`)).status).toBe(404);
  });

  it('is admin-only and validates URLs and event types', async () => {
    const forbidden = await call('GET', '/webhooks', undefined, member);
    expect(forbidden.status).toBe(403);
    const strict = createApp({ db: t.db, auth: { mode: 'standard', sso: sso.options } });
    const res = await strict.request('http://t/api/v1/webhooks', {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest' }),
    });
    expect(res.status).toBe(400);
    const bad = await call('POST', '/webhooks', {
      url: 'https://example.com',
      eventTypes: ['x.y'],
    });
    expect(bad.status).toBe(400);
    const badSecret = await call('POST', '/webhooks', {
      url: 'https://example.com',
      secret: 'whsec_notEnoughBytes==',
    });
    expect(badSecret.status).toBe(400);
    expect(await badSecret.text()).not.toContain('notEnoughBytes');
  });

  it('POST /webhooks accepts payload: notice and the receiver gets a notice', async () => {
    const res = await call('POST', '/webhooks', {
      url: receiverUrl,
      eventTypes: ['issue.*'],
      project: 'HOOK',
      payload: 'notice',
    });
    expect(res.status).toBe(201);
    const hook = (await res.json()) as { id: string; secret: string; payload: string };
    expect(hook.payload).toBe('notice');
    received.length = 0;
    const issue = (await (
      await call('POST', '/projects/HOOK/issues', { title: 'Secret plans' })
    ).json()) as { id: string };
    await new WebhookRunner(t.db, { policy: { allowPrivate: true }, clock: t.ctx.clock }).runOnce();
    expect(received).toHaveLength(1);
    const body = received[0]!.body;
    expect(body).not.toContain('Secret plans');
    expect(JSON.parse(body)).toMatchObject({ type: 'issue.created', issueId: issue.id });
    expect(() =>
      verifyWebhook(hook.secret, received[0]!.headers, body, { toleranceSeconds: 1e10 }),
    ).not.toThrow();
    expect((await call('DELETE', `/webhooks/${hook.id}`)).status).toBe(200);
  });

  it('documents the payload in the OpenAPI webhooks section', () => {
    const doc = generateOpenApiDocument() as { webhooks?: Record<string, { post?: unknown }> };
    expect(doc.webhooks?.event?.post).toBeDefined();
    expect(doc.webhooks?.notice?.post).toBeDefined();
  });
});
