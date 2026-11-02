import { createRoute, z } from '@hono/zod-openapi';
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhook,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  type WebhookPolicy,
} from '@poietic-tech/issues-core';
import {
  CreateWebhookInputSchema,
  EventNoticeSchema,
  EventSchema,
  pageOf,
  UpdateWebhookInputSchema,
  WEBHOOK_DELIVERY_STATUSES,
  WebhookDeliverySchema,
  WebhookSchema,
  WebhookTestResultSchema,
  WebhookWithSecretSchema,
} from '@poietic-tech/issues-schema';
import type { TrackerApp } from '../env.ts';
import { CursorQuery, errorResponses, json, jsonBody, LimitQuery, refParam } from './common.ts';

const tags = ['Webhooks'];
const idParam = z.object({ id: refParam('id', 'Webhook id.', 'whk_01h455vb4pex5vsknk084sn02q') });
const deliveryParam = z.object({
  id: refParam('id', 'Delivery id.', 'whd_01h455vb4pex5vsknk084sn02q'),
});

/** Webhook management (admins only). Deliveries are made by the server's background webhook runner. */
export function registerWebhookRoutes(app: TrackerApp, policy: WebhookPolicy) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks',
      tags,
      summary: 'List webhooks',
      responses: {
        200: json(z.object({ data: z.array(WebhookSchema) }), 'Webhooks'),
        ...errorResponses('FORBIDDEN'),
      },
    }),
    async (c) => c.json({ data: await listWebhooks(c.get('ctx')) }, 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks',
      tags,
      summary: 'Register a webhook',
      description:
        'Events matching `eventTypes` (and `project`, if set) are POSTed to `url`, signed per Standard Webhooks. The response is the only time the signing `secret` is shown (besides rotation).',
      request: { body: jsonBody(CreateWebhookInputSchema) },
      responses: {
        201: json(WebhookWithSecretSchema, 'Created'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => c.json(await createWebhook(c.get('ctx'), c.req.valid('json'), policy), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks/{id}',
      tags,
      summary: 'Get a webhook',
      request: { params: idParam },
      responses: {
        200: json(WebhookSchema, 'Webhook'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => c.json(await getWebhook(c.get('ctx'), c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/webhooks/{id}',
      tags,
      summary: 'Update a webhook',
      description: 'Setting `active: true` on an automatically disabled webhook re-enables it.',
      request: { params: idParam, body: jsonBody(UpdateWebhookInputSchema) },
      responses: {
        200: json(WebhookSchema, 'Updated'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json(
        await updateWebhook(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'), policy),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/webhooks/{id}',
      tags,
      summary: 'Delete a webhook and its delivery log',
      request: { params: idParam },
      responses: {
        200: json(WebhookSchema, 'Deleted'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => c.json(await deleteWebhook(c.get('ctx'), c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/{id}/rotate-secret',
      tags,
      summary: 'Replace the signing secret',
      request: { params: idParam },
      responses: {
        200: json(WebhookWithSecretSchema, 'Webhook with its new secret'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => c.json(await rotateWebhookSecret(c.get('ctx'), c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/{id}/test',
      tags,
      summary: 'Send a test ping',
      description:
        'Sends a signed `webhook.ping` event now and reports the receiver’s answer. Not recorded as a delivery.',
      request: { params: idParam },
      responses: {
        200: json(WebhookTestResultSchema, 'How the receiver answered'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => c.json(await testWebhook(c.get('ctx'), c.req.valid('param').id, policy), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks/{id}/deliveries',
      tags,
      summary: 'List a webhook’s deliveries (newest first)',
      request: {
        params: idParam,
        query: z.object({
          status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
          limit: LimitQuery,
          cursor: CursorQuery,
        }),
      },
      responses: {
        200: json(pageOf(WebhookDeliverySchema), 'Deliveries'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json(
        await listWebhookDeliveries(c.get('ctx'), c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/webhook-deliveries/{id}',
      tags,
      summary: 'Get a delivery',
      request: { params: deliveryParam },
      responses: {
        200: json(WebhookDeliverySchema, 'Delivery'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => c.json(await getWebhookDelivery(c.get('ctx'), c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhook-deliveries/{id}/redeliver',
      tags,
      summary: 'Send a delivery again',
      description: 'Queues the delivery immediately, with a fresh set of retries.',
      request: { params: deliveryParam },
      responses: {
        200: json(WebhookDeliverySchema, 'Queued'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) => c.json(await redeliverWebhook(c.get('ctx'), c.req.valid('param').id), 200),
  );

  // The outgoing payload, documented in the OpenAPI `webhooks` section (so clients can generate its types).
  const deliveryHeaders = z.object({
    'webhook-id': z.string().openapi({ example: 'whd_01h455vb4pex5vsknk084sn02q' }),
    'webhook-timestamp': z
      .string()
      .openapi({ description: 'Unix seconds.', example: '1790445358' }),
    'webhook-signature': z
      .string()
      .openapi({ description: 'Space-separated `v1,<base64>` signatures.' }),
    'x-poietic-issues-event': z.string().openapi({ example: 'issue.updated' }),
    'x-poietic-issues-event-seq': z.string().openapi({ example: '1042' }),
    'x-tracker-event': z.string().openapi({
      description: 'Deprecated: same as `x-poietic-issues-event`.',
      deprecated: true,
    }),
    'x-tracker-event-seq': z.string().openapi({
      description: 'Deprecated: same as `x-poietic-issues-event-seq`.',
      deprecated: true,
    }),
  });
  app.openAPIRegistry.registerWebhook({
    method: 'post',
    path: 'event',
    tags,
    summary: 'Tracker event',
    description:
      'Every delivery POSTs one event (the same shape as `GET /events`) as JSON. Verify `webhook-signature` (Standard Webhooks: HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}` with the base64-decoded part of the `whsec_` secret) and reject timestamps older than a few minutes. `webhook-id` is stable across retries of the same delivery — use it to deduplicate. Answer 2xx within 10 seconds; anything else is retried after 1m, 5m, 30m, 2h and 12h.',
    request: {
      headers: deliveryHeaders,
      body: jsonBody(EventSchema),
    },
    responses: { 200: { description: 'Any 2xx acknowledges the delivery.' } },
  });
  app.openAPIRegistry.registerWebhook({
    method: 'post',
    path: 'notice',
    tags,
    summary: 'Tracker event notice',
    description:
      "Sent instead of `event` when the webhook's `payload` is `notice`: only which event happened (its seq, ids, type and time), never what it contains. Read `GET /events` as yourself for the event. Signing, headers, retries and deduplication are as for `event`; the test ping is a notice with `seq` 0 and `type` `webhook.ping`.",
    request: { headers: deliveryHeaders, body: jsonBody(EventNoticeSchema) },
    responses: { 200: { description: 'Any 2xx acknowledges the delivery.' } },
  });
}
