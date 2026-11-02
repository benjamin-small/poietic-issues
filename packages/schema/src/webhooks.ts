import { z } from 'zod';
import { TimestampSchema } from './common.ts';
import { EVENT_TYPES, type EventType } from './events.ts';

const EVENT_NOUNS = [...new Set(EVENT_TYPES.map((t) => t.split('.')[0]!))];

/** An event type, `<noun>.*` (e.g. `issue.*`) or `*` for everything. */
export const WebhookEventPatternSchema = z
  .string()
  .refine(
    (p) =>
      p === '*' ||
      (EVENT_TYPES as readonly string[]).includes(p) ||
      (p.endsWith('.*') && EVENT_NOUNS.includes(p.slice(0, -2))),
    { message: `Use an event type, "<noun>.*" (${EVENT_NOUNS.join(', ')}) or "*"` },
  )
  .meta({ example: 'issue.*' });

/** Whether an event type is selected by a webhook's patterns. */
export function webhookMatchesType(patterns: readonly string[], type: EventType | string): boolean {
  return patterns.some(
    (p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))),
  );
}

/** What a webhook sends: the whole event, or a content-free notice that it happened. */
export const WEBHOOK_PAYLOADS = ['full', 'notice'] as const;
export type WebhookPayload = (typeof WEBHOOK_PAYLOADS)[number];

const WebhookPayloadSchema = z.enum(WEBHOOK_PAYLOADS).meta({
  description:
    '`full` sends the event as in `GET /events`; `notice` sends only its seq, ids, type and time.',
});

/** The body of a `notice` webhook: which event happened, never what it contains. */
export const EventNoticeSchema = z
  .object({
    seq: z
      .number()
      .int()
      .meta({ description: 'Read `GET /events?after=<seq - 1>` for the event.' }),
    id: z.string(),
    type: z.string().meta({ example: 'issue.updated' }),
    projectId: z.string().nullable(),
    issueId: z.string().nullable(),
    actorId: z.string().nullable(),
    createdAt: TimestampSchema,
  })
  .meta({ id: 'EventNotice' });
export type EventNotice = z.infer<typeof EventNoticeSchema>;

/** The notice for an event, with its keys in a fixed order. */
export function toEventNotice(
  event: Pick<
    EventNotice,
    'seq' | 'id' | 'type' | 'projectId' | 'issueId' | 'actorId' | 'createdAt'
  >,
): EventNotice {
  return {
    seq: event.seq,
    id: event.id,
    type: event.type,
    projectId: event.projectId,
    issueId: event.issueId,
    actorId: event.actorId,
    createdAt: event.createdAt,
  };
}

const WEBHOOK_URL = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .meta({ example: 'https://example.com/hooks/tracker' });

export const WebhookSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    description: z.string(),
    eventTypes: z.array(z.string()).meta({ description: 'Event types, `<noun>.*` or `*`.' }),
    projectId: z
      .string()
      .nullable()
      .meta({ description: 'Only events from this project; null for all projects.' }),
    active: z.boolean(),
    payload: WebhookPayloadSchema,
    failureCount: z.number().int().meta({
      description:
        'Consecutive deliveries that exhausted their retries. The webhook is disabled at 5; re-activating resets it.',
    }),
    disabledAt: TimestampSchema.nullable().meta({
      description: 'Set when the webhook was disabled automatically after repeated failures.',
    }),
    createdBy: z.string(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'Webhook' });
export type Webhook = z.infer<typeof WebhookSchema>;

export const WebhookWithSecretSchema = WebhookSchema.extend({
  secret: z.string().meta({
    description:
      'Signing secret (`whsec_…`). Returned only when the webhook is created or its secret rotated.',
    example: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  }),
}).meta({ id: 'WebhookWithSecret' });
export type WebhookWithSecret = z.infer<typeof WebhookWithSecretSchema>;

const SECRET_PATTERN = /^whsec_((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;

/** Bytes encoded by canonical, padded base64 (its length says it all). */
function base64Bytes(b64: string): number {
  return (b64.length / 4) * 3 - (b64.match(/=+$/)?.[0].length ?? 0);
}

/**
 * A supplied signing secret: `whsec_` and standard, padded base64 of 16–64 bytes. That is what the bridge (and any
 * strict Standard Webhooks verifier) decodes, so a webhook can never hold a secret its receiver cannot check. The
 * messages name the rule and never the value.
 */
export const WebhookSecretSchema = z
  .string()
  .refine(
    (s) => {
      const b64 = SECRET_PATTERN.exec(s)?.[1];
      if (b64 === undefined) return false;
      const bytes = base64Bytes(b64);
      return bytes >= 16 && bytes <= 64;
    },
    { message: 'The secret must be whsec_ followed by standard, padded base64 of 16 to 64 bytes' },
  )
  .meta({
    description:
      'Signing secret to use instead of a generated one, for receivers that issue their own (such as the bridge): `whsec_` and standard base64 of 16–64 bytes.',
  });

export const CreateWebhookInputSchema = z
  .object({
    url: WEBHOOK_URL,
    description: z.string().max(500).default(''),
    eventTypes: z.array(WebhookEventPatternSchema).min(1).default(['*']),
    project: z
      .string()
      .optional()
      .meta({ description: 'Project key or id to scope the webhook to.', example: 'ENG' }),
    active: z.boolean().default(true),
    payload: WebhookPayloadSchema.default('full'),
    secret: WebhookSecretSchema.optional(),
  })
  .meta({ id: 'CreateWebhookInput' });
export type CreateWebhookInput = z.input<typeof CreateWebhookInputSchema>;

export const UpdateWebhookInputSchema = z
  .object({
    url: WEBHOOK_URL.optional(),
    description: z.string().max(500).optional(),
    eventTypes: z.array(WebhookEventPatternSchema).min(1).optional(),
    project: z.string().nullable().optional().meta({ description: 'null removes the scope.' }),
    active: z.boolean().optional(),
    payload: WebhookPayloadSchema.optional(),
  })
  .meta({ id: 'UpdateWebhookInput' });
export type UpdateWebhookInput = z.input<typeof UpdateWebhookInputSchema>;

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'dead'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const WebhookDeliverySchema = z
  .object({
    id: z.string().meta({ description: 'Also sent as the `webhook-id` header on every attempt.' }),
    webhookId: z.string(),
    eventSeq: z.number().int(),
    eventId: z.string().nullable(),
    eventType: z.string().nullable(),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES).meta({
      description:
        '`pending` (not yet attempted), `failed` (will retry at `nextAttemptAt`), `succeeded`, or `dead` (retries exhausted).',
    }),
    attempts: z.number().int(),
    nextAttemptAt: TimestampSchema,
    lastAttemptAt: TimestampSchema.nullable(),
    lastStatusCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
    lastResponse: z
      .string()
      .nullable()
      .meta({ description: 'Start of the last response body (up to 2 KB).' }),
    lastDurationMs: z.number().int().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'WebhookDelivery' });
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const WebhookTestResultSchema = z
  .object({
    ok: z.boolean(),
    statusCode: z.number().int().nullable(),
    error: z.string().nullable(),
    response: z.string().nullable(),
    durationMs: z.number().int(),
  })
  .meta({ id: 'WebhookTestResult' });
export type WebhookTestResult = z.infer<typeof WebhookTestResultSchema>;
