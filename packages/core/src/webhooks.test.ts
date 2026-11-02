import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { testDialect } from '@poietic-tech/issues-db/testing';
import { webhookMatchesType } from '@poietic-tech/issues-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertWebhookUrl,
  createIssue,
  createProject,
  createWebhook,
  deleteWebhook,
  deliverDueWebhooks,
  dispatchWebhookEvents,
  getWebhook,
  isPrivateAddress,
  listEvents,
  listWebhooks,
  listWebhookDeliveries,
  publicOnlyLookup,
  redeliverWebhook,
  rotateWebhookSecret,
  sendWebhookRequest,
  signWebhook,
  testWebhook,
  updateIssue,
  updateWebhook,
  verifyWebhook,
  WEBHOOK_RETRY_DELAYS_MS,
  type SendRequest,
  type SendResult,
  type WebhookPolicy,
} from './index.ts';
import { createTestContext, type TestContext } from './testing.ts';

describe('webhook signing (Standard Webhooks)', () => {
  it('matches the reference test vector', () => {
    expect(
      signWebhook(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('verifies, and rejects tampering, wrong secrets and stale timestamps', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const now = new Date('2026-01-01T00:00:00Z');
    const ts = now.getTime() / 1000;
    const headers = {
      'webhook-id': 'whd_1',
      'webhook-timestamp': String(ts),
      'webhook-signature': `v1,bogus ${signWebhook(secret, 'whd_1', ts, '{"a":1}')}`,
    };
    expect(() => verifyWebhook(secret, headers, '{"a":1}', { now })).not.toThrow();
    expect(() => verifyWebhook(secret, headers, '{"a":2}', { now })).toThrow(/signature/);
    expect(() => verifyWebhook('whsec_AAAA', headers, '{"a":1}', { now })).toThrow(/signature/);
    expect(() =>
      verifyWebhook(secret, headers, '{"a":1}', { now: new Date(now.getTime() + 600_000) }),
    ).toThrow(/tolerance/);
  });
});

describe("the bridge's signature vector", () => {
  it('matches the vector in poietic-bridge apps/worker/test/poietic-issues.test.ts', () => {
    const body =
      '{"seq":7,"id":"evt_01jvector","type":"issue.created","projectId":"prj_01jvector","issueId":"iss_01jvector","actorId":"usr_01jvector","createdAt":"2026-11-01T12:00:00.000Z"}';
    expect(
      signWebhook(
        'whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=',
        'whd_01jvector',
        1800000000,
        body,
      ),
    ).toBe('v1,wpoJY0Zmwpy23ozMFAcZH13pC1MEPU36DKHDLIKD/z8=');
  });
});

describe('SSRF guard', () => {
  it('classifies addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      'not-an-ip',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::6810:85e5', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('validates URLs', () => {
    expect(() => assertWebhookUrl('https://example.com/hook', false)).not.toThrow();
    for (const url of [
      'http://example.com/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/',
      'https://localhost:3000/hook',
      'https://user:pass@example.com/',
      'ftp://example.com/',
    ])
      expect(() => assertWebhookUrl(url, false), url).toThrow();
    expect(() => assertWebhookUrl('http://127.0.0.1:9999/hook', true)).not.toThrow();
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      publicOnlyLookup('localhost', {}, (err) => resolve(err)),
    );
    expect(error?.message).toMatch(/private address/);
  });

  it('never sends to a private address without allowPrivate', async () => {
    const result = await sendWebhookRequest({
      url: 'https://169.254.169.254/latest/meta-data',
      headers: {},
      body: '{}',
      allowPrivate: false,
    });
    expect(result).toMatchObject({ statusCode: null, error: expect.stringMatching(/private/) });
  });

  it('matches event type patterns', () => {
    expect(webhookMatchesType(['*'], 'issue.created')).toBe(true);
    expect(webhookMatchesType(['issue.*'], 'issue.updated')).toBe(true);
    expect(webhookMatchesType(['issue.*'], 'comment.created')).toBe(false);
    expect(webhookMatchesType(['comment.created'], 'comment.created')).toBe(true);
  });
});

describe(`webhooks (${testDialect()})`, () => {
  let t: TestContext;
  let server: Server;
  let receiverUrl: string;
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const policy: WebhookPolicy = { allowPrivate: true };

  const advance = (ms: number) =>
    (t.ctx.clock as unknown as { advance(ms: number): void }).advance(ms);
  const deliver = () => deliverDueWebhooks(t.ctx, { policy });

  beforeAll(async () => {
    t = await createTestContext();
    await createProject(t.ctx, { key: 'WH', name: 'Webhooks' });
    await createProject(t.ctx, { key: 'OTHER', name: 'Other' });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    server.close();
    await t.destroy();
  });

  it('delivers signed events to a receiver, filtered by type and project', async () => {
    const before = await createIssue(t.ctx, 'WH', { title: 'Before the webhook' });
    const hook = await createWebhook(
      t.ctx,
      { url: receiverUrl, eventTypes: ['issue.*'], project: 'WH', description: 'test' },
      policy,
    );
    expect(hook.secret).toMatch(/^whsec_/);
    expect(await dispatchWebhookEvents(t.ctx)).toBe(0); // history is never replayed

    const issue = await createIssue(t.ctx, 'WH', { title: 'Hello hooks' });
    await createIssue(t.ctx, 'OTHER', { title: 'Elsewhere' });
    await updateIssue(t.ctx, before.key, { priority: 1 });
    expect(await dispatchWebhookEvents(t.ctx)).toBe(2);
    expect(await dispatchWebhookEvents(t.ctx)).toBe(0);
    expect(await deliver()).toBe(2);

    expect(received).toHaveLength(2);
    const types = received.map((r) => JSON.parse(r.body).type);
    expect(types).toEqual(expect.arrayContaining(['issue.created', 'issue.updated']));
    for (const r of received) {
      const headers = r.headers as Record<string, string>;
      expect(() =>
        verifyWebhook(hook.secret, headers, r.body, { toleranceSeconds: 1e10 }),
      ).not.toThrow();
      expect(headers['webhook-id']).toMatch(/^whd_/);
      expect(headers['content-type']).toBe('application/json');
      const type = JSON.parse(r.body).type;
      expect(headers['x-poietic-issues-event']).toBe(type);
      expect(headers['x-tracker-event']).toBe(type); // deprecated alias, one release
      expect(headers['user-agent']).toBe('poietic-issues-webhooks/1');
    }
    const created = received.find((r) => JSON.parse(r.body).type === 'issue.created')!;
    expect(JSON.parse(created.body).data.issue.key).toBe(issue.key);

    const deliveries = await listWebhookDeliveries(t.ctx, hook.id);
    expect(deliveries.data.map((d) => d.status)).toEqual(['succeeded', 'succeeded']);
    expect(deliveries.data[0]).toMatchObject({
      attempts: 1,
      lastStatusCode: 200,
      lastResponse: 'ok',
    });
    await deleteWebhook(t.ctx, hook.id);
  });

  it('retries with backoff, then gives up and disables a failing webhook', async () => {
    const sent: SendRequest[] = [];
    let reply: SendResult = { statusCode: 500, response: 'boom', error: null, durationMs: 3 };
    const fake: WebhookPolicy = {
      allowPrivate: true,
      send: async (req) => (sent.push(req), reply),
    };
    const hook = await createWebhook(
      t.ctx,
      { url: 'https://example.com/hook', eventTypes: ['issue.created'] },
      fake,
    );
    await createIssue(t.ctx, 'WH', { title: 'Will fail' });
    await dispatchWebhookEvents(t.ctx);
    const run = () => deliverDueWebhooks(t.ctx, { policy: fake });

    expect(await run()).toBe(1);
    let [d] = (await listWebhookDeliveries(t.ctx, hook.id)).data;
    expect(d).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastStatusCode: 500,
      lastError: 'HTTP 500',
    });
    expect(Date.parse(d!.nextAttemptAt) - Date.parse(d!.lastAttemptAt!)).toBe(
      WEBHOOK_RETRY_DELAYS_MS[0],
    );
    expect(await run()).toBe(0); // not due yet

    for (const delay of WEBHOOK_RETRY_DELAYS_MS) {
      advance(delay + 1000);
      expect(await run()).toBe(1);
    }
    [d] = (await listWebhookDeliveries(t.ctx, hook.id)).data;
    expect(d).toMatchObject({ status: 'dead', attempts: 6 });
    expect(sent).toHaveLength(6);
    expect(new Set(sent.map((s) => s.headers['webhook-id']))).toEqual(new Set([d!.id])); // stable id
    expect((await getWebhook(t.ctx, hook.id)).failureCount).toBe(1);

    // Redelivery gets a fresh set of attempts; success resets the failure count.
    reply = { statusCode: 204, response: '', error: null, durationMs: 1 };
    await redeliverWebhook(t.ctx, d!.id);
    expect(await run()).toBe(1);
    [d] = (await listWebhookDeliveries(t.ctx, hook.id)).data;
    expect(d).toMatchObject({ status: 'succeeded', attempts: 1, lastStatusCode: 204 });
    expect((await getWebhook(t.ctx, hook.id)).failureCount).toBe(0);

    // Five consecutive dead deliveries disable the webhook; its pending deliveries wait.
    reply = { statusCode: null, response: null, error: 'connect ECONNREFUSED', durationMs: 1 };
    await t.db.kysely
      .updateTable('webhooks')
      .set({ failure_count: 4 })
      .where('id', '=', hook.id)
      .execute();
    await createIssue(t.ctx, 'WH', { title: 'Dies' });
    await dispatchWebhookEvents(t.ctx);
    await run();
    for (const delay of WEBHOOK_RETRY_DELAYS_MS) {
      advance(delay + 1000);
      await run();
    }
    const disabled = await getWebhook(t.ctx, hook.id);
    expect(disabled).toMatchObject({ active: false, failureCount: 5 });
    expect(disabled.disabledAt).not.toBeNull();
    await createIssue(t.ctx, 'WH', { title: 'Queued while disabled' });
    await dispatchWebhookEvents(t.ctx); // inactive webhooks get no new deliveries
    expect((await listWebhookDeliveries(t.ctx, hook.id)).data).toHaveLength(2);

    const revived = await updateWebhook(t.ctx, hook.id, { active: true }, fake);
    expect(revived).toMatchObject({ active: true, failureCount: 0, disabledAt: null });
    await deleteWebhook(t.ctx, hook.id);
  });

  it('never sends a delivery twice when workers race', async () => {
    let sends = 0;
    const slow: WebhookPolicy = {
      allowPrivate: true,
      send: async () => {
        sends++;
        await new Promise((r) => setTimeout(r, 30));
        return { statusCode: 200, response: '', error: null, durationMs: 30 };
      },
    };
    const hook = await createWebhook(t.ctx, { url: 'https://example.com/race' }, slow);
    for (let i = 0; i < 5; i++) await createIssue(t.ctx, 'WH', { title: `Race ${i}` });
    await dispatchWebhookEvents(t.ctx);
    const total = (await listWebhookDeliveries(t.ctx, hook.id)).data.length;
    expect(total).toBe(5);
    await Promise.all(
      [1, 2, 3].map(() => deliverDueWebhooks(t.ctx, { policy: slow, batchSize: 2 })),
    );
    while ((await deliverDueWebhooks(t.ctx, { policy: slow })) > 0);
    expect(sends).toBe(total);
    await deleteWebhook(t.ctx, hook.id);
  });

  it('notice webhooks send only the notice', async () => {
    const hook = await createWebhook(
      t.ctx,
      { url: receiverUrl, eventTypes: ['issue.*'], project: 'WH', payload: 'notice' },
      policy,
    );
    expect(hook.payload).toBe('notice');
    const issue = await createIssue(t.ctx, 'WH', { title: 'Notice me' });
    await dispatchWebhookEvents(t.ctx);
    await deliver();
    received.length = 0;
    await updateIssue(t.ctx, issue.key, { priority: 2 });
    await dispatchWebhookEvents(t.ctx);
    expect(await deliver()).toBe(1);
    const [r] = received;
    const events = await listEvents(t.ctx, { issue: issue.id });
    const event = events.data.at(-1)!;
    expect(r!.body).toBe(
      JSON.stringify({
        seq: event.seq,
        id: event.id,
        type: 'issue.updated',
        projectId: event.projectId,
        issueId: issue.id,
        actorId: event.actorId,
        createdAt: event.createdAt,
      }),
    );
    expect(Buffer.byteLength(r!.body)).toBeLessThan(8192);
    const headers = r!.headers as Record<string, string>;
    expect(headers['x-poietic-issues-event']).toBe('issue.updated');
    expect(() =>
      verifyWebhook(hook.secret, headers, r!.body, { toleranceSeconds: 1e10 }),
    ).not.toThrow();
    await deleteWebhook(t.ctx, hook.id);
  });

  it('full payload stays the default, and payload can be switched', async () => {
    const hook = await createWebhook(
      t.ctx,
      { url: receiverUrl, eventTypes: ['issue.*'], project: 'WH' },
      policy,
    );
    expect(hook.payload).toBe('full');
    received.length = 0;
    const issue = await createIssue(t.ctx, 'WH', { title: 'Full' });
    await dispatchWebhookEvents(t.ctx);
    await deliver();
    expect(JSON.parse(received[0]!.body).data.issue.key).toBe(issue.key);

    expect((await updateWebhook(t.ctx, hook.id, { payload: 'notice' }, policy)).payload).toBe(
      'notice',
    );
    received.length = 0;
    await updateIssue(t.ctx, issue.key, { priority: 3 });
    await dispatchWebhookEvents(t.ctx);
    await deliver();
    expect(JSON.parse(received[0]!.body)).not.toHaveProperty('data');
    await deleteWebhook(t.ctx, hook.id);
  });

  it('the test ping of a notice webhook is a notice', async () => {
    const hook = await createWebhook(
      t.ctx,
      { url: receiverUrl, project: 'WH', payload: 'notice' },
      policy,
    );
    received.length = 0;
    expect(await testWebhook(t.ctx, hook.id, policy)).toMatchObject({ ok: true });
    const ping = JSON.parse(received[0]!.body);
    expect(Object.keys(ping)).toEqual([
      'seq',
      'id',
      'type',
      'projectId',
      'issueId',
      'actorId',
      'createdAt',
    ]);
    expect(ping).toMatchObject({
      seq: 0,
      type: 'webhook.ping',
      projectId: hook.projectId,
      issueId: null,
      actorId: t.ctx.actor.id,
    });
    await deleteWebhook(t.ctx, hook.id);
  });

  it('a supplied secret is stored and signs deliveries', async () => {
    const secret = 'whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=';
    const hook = await createWebhook(
      t.ctx,
      { url: receiverUrl, eventTypes: ['issue.*'], project: 'WH', secret },
      policy,
    );
    expect(hook.secret).toBe(secret);
    expect('secret' in (await getWebhook(t.ctx, hook.id))).toBe(false);
    expect((await listWebhooks(t.ctx)).every((h) => !('secret' in h))).toBe(true);
    await createIssue(t.ctx, 'WH', { title: 'Signed with the bridge secret' });
    received.length = 0;
    await dispatchWebhookEvents(t.ctx);
    await deliver();
    expect(received).toHaveLength(1);
    expect(() =>
      verifyWebhook(secret, received[0]!.headers as Record<string, string>, received[0]!.body, {
        toleranceSeconds: 1e10,
      }),
    ).not.toThrow();
    await deleteWebhook(t.ctx, hook.id);
  });

  it('a secret the bridge could not verify is refused', async () => {
    for (const secret of [
      'AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=',
      'whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw_-',
      'whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw',
      'whsec_AAAAAAAAAAA=',
      `whsec_${Buffer.alloc(100, 7).toString('base64')}`,
      'whsec_',
    ]) {
      const error = await createWebhook(t.ctx, { url: receiverUrl, secret }, policy).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, secret).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(error), secret).toMatch(/secret/);
      // The rule's own message says whsec_, so look for the part only this secret has.
      const own = secret.slice('whsec_'.length);
      if (own) expect(JSON.stringify(error), secret).not.toContain(own);
    }
  });

  it('an unknown payload is refused', async () => {
    await expect(
      createWebhook(t.ctx, { url: receiverUrl, payload: 'snapshot' as never }, policy),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('pings, rotates secrets, validates URLs and requires admin', async () => {
    const hook = await createWebhook(t.ctx, { url: receiverUrl }, policy);
    received.length = 0;
    const ping = await testWebhook(t.ctx, hook.id, policy);
    expect(ping).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(JSON.parse(received[0]!.body)).toMatchObject({
      type: 'webhook.ping',
      data: { webhook: { id: hook.id } },
    });

    const rotated = await rotateWebhookSecret(t.ctx, hook.id);
    expect(rotated.secret).not.toBe(hook.secret);
    expect('secret' in (await getWebhook(t.ctx, hook.id))).toBe(false);

    await expect(
      createWebhook(t.ctx, { url: 'http://127.0.0.1:1/x' }, { allowPrivate: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      createWebhook(t.ctx, { url: 'https://example.com', eventTypes: ['nope.*'] }, policy),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      createWebhook(t.member, { url: 'https://example.com' }, policy),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await deleteWebhook(t.ctx, hook.id);
  });
});
