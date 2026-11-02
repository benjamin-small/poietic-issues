import {
  type Database,
  fromJson,
  type Selectable,
  toBool,
  toJson,
  type Tx,
  withWriteTx,
} from '@poietic-tech/issues-db';
import {
  type CreateWebhookInput,
  CreateWebhookInputSchema,
  isIdOf,
  newId,
  type Page,
  type TrackerEvent,
  type UpdateWebhookInput,
  UpdateWebhookInputSchema,
  type Webhook,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookTestResult,
  type WebhookWithSecret,
  toEventNotice,
  webhookMatchesType,
} from '@poietic-tech/issues-schema';
import { nowIso, type ServiceContext } from '../context.ts';
import { notFound, parseInput, validationError } from '../errors.ts';
import { toUserSummary } from '../mappers.ts';
import { getEventsBySeq } from './events.ts';
import { requireAdmin } from '../permissions.ts';
import { getProjectRow } from '../refs.ts';
import {
  assertWebhookUrl,
  sendWebhookRequest,
  type WebhookSender,
  WebhookUrlError,
} from '../webhooks/send.ts';
import { generateWebhookSecret, webhookHeaders } from '../webhooks/signing.ts';

/** How webhooks may reach the network (from server configuration). */
export interface WebhookPolicy {
  /** Allow http and private/loopback addresses (development and tests only). */
  allowPrivate: boolean;
  /** Override the HTTP sender (tests). */
  send?: WebhookSender;
}

type WebhookRow = Selectable<Database['webhooks']>;

function toWebhook(r: WebhookRow): Webhook {
  return {
    id: r.id,
    url: r.url,
    description: r.description,
    eventTypes: fromJson<string[]>(r.event_types, []),
    projectId: r.project_id,
    active: toBool(r.active),
    payload: r.payload,
    failureCount: r.failure_count,
    disabledAt: r.disabled_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function checkUrl(url: string, policy: WebhookPolicy) {
  try {
    assertWebhookUrl(url, policy.allowPrivate);
  } catch (error) {
    if (error instanceof WebhookUrlError)
      throw validationError(error.message, [{ path: 'url', message: error.message }]);
    throw error;
  }
}

async function webhookRow(db: Tx, id: string): Promise<WebhookRow> {
  if (!isIdOf('webhook', id)) throw notFound('Webhook', id);
  const row = await db.selectFrom('webhooks').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Webhook', id);
  return row;
}

export async function listWebhooks(ctx: ServiceContext): Promise<Webhook[]> {
  requireAdmin(ctx, 'manage webhooks');
  const rows = await ctx.db.kysely
    .selectFrom('webhooks')
    .selectAll()
    .orderBy('created_at')
    .execute();
  return rows.map(toWebhook);
}

export async function getWebhook(ctx: ServiceContext, id: string): Promise<Webhook> {
  requireAdmin(ctx, 'manage webhooks');
  return toWebhook(await webhookRow(ctx.db.kysely, id));
}

/** Registers a webhook. The signing secret is returned only here (and on rotation). */
export async function createWebhook(
  ctx: ServiceContext,
  input: CreateWebhookInput,
  policy: WebhookPolicy,
): Promise<WebhookWithSecret> {
  requireAdmin(ctx, 'manage webhooks');
  const data = parseInput(CreateWebhookInputSchema, input);
  checkUrl(data.url, policy);
  return withWriteTx(ctx.db, async (tx) => {
    const project = data.project ? await getProjectRow(ctx, tx, data.project, 'read') : null;
    const now = nowIso(ctx);
    await ensureDispatchCursor(tx, now);
    const secret = data.secret ?? generateWebhookSecret();
    const row = await tx
      .insertInto('webhooks')
      .values({
        id: ctx.ids('webhook'),
        url: data.url,
        secret,
        description: data.description,
        event_types: toJson(data.eventTypes),
        project_id: project?.id ?? null,
        active: data.active,
        payload: data.payload,
        failure_count: 0,
        created_by: ctx.actor.id,
        created_at: now,
        updated_at: now,
        disabled_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toWebhook(row), secret };
  });
}

/** Updates a webhook. Re-activating it clears the automatic-disable state. */
export async function updateWebhook(
  ctx: ServiceContext,
  id: string,
  input: UpdateWebhookInput,
  policy: WebhookPolicy,
): Promise<Webhook> {
  requireAdmin(ctx, 'manage webhooks');
  const patch = parseInput(UpdateWebhookInputSchema, input);
  if (patch.url !== undefined) checkUrl(patch.url, policy);
  return withWriteTx(ctx.db, async (tx) => {
    const row = await webhookRow(tx, id);
    const set: Partial<Selectable<Database['webhooks']>> = { updated_at: nowIso(ctx) };
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.eventTypes !== undefined) set.event_types = toJson(patch.eventTypes);
    if (patch.payload !== undefined) set.payload = patch.payload;
    if (patch.project !== undefined)
      set.project_id =
        patch.project === null ? null : (await getProjectRow(ctx, tx, patch.project, 'read')).id;
    if (patch.active !== undefined) {
      set.active = patch.active;
      if (patch.active && !toBool(row.active)) {
        set.failure_count = 0;
        set.disabled_at = null;
      }
    }
    const updated = await tx
      .updateTable('webhooks')
      .set(set)
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toWebhook(updated);
  });
}

export async function rotateWebhookSecret(
  ctx: ServiceContext,
  id: string,
): Promise<WebhookWithSecret> {
  requireAdmin(ctx, 'manage webhooks');
  return withWriteTx(ctx.db, async (tx) => {
    const row = await webhookRow(tx, id);
    const secret = generateWebhookSecret();
    const updated = await tx
      .updateTable('webhooks')
      .set({ secret, updated_at: nowIso(ctx) })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toWebhook(updated), secret };
  });
}

/** Deletes a webhook and its delivery log. */
export async function deleteWebhook(ctx: ServiceContext, id: string): Promise<Webhook> {
  requireAdmin(ctx, 'manage webhooks');
  return withWriteTx(ctx.db, async (tx) => {
    const row = await webhookRow(tx, id);
    await tx.deleteFrom('webhook_deliveries').where('webhook_id', '=', row.id).execute();
    await tx.deleteFrom('webhooks').where('id', '=', row.id).execute();
    return toWebhook(row);
  });
}

/**
 * Sends a signed `webhook.ping` to the webhook right away (not recorded as a delivery) and reports how the
 * receiver answered — a quick way to check a receiver's URL and signature verification.
 */
export async function testWebhook(
  ctx: ServiceContext,
  id: string,
  policy: WebhookPolicy,
): Promise<WebhookTestResult> {
  requireAdmin(ctx, 'manage webhooks');
  const row = await webhookRow(ctx.db.kysely, id);
  const now = ctx.clock.now();
  const owner = await ctx.db.kysely
    .selectFrom('users as u')
    .innerJoin('users as o', 'o.id', 'u.owner_id')
    .select(['o.id', 'o.handle'])
    .where('u.id', '=', ctx.actor.id)
    .executeTakeFirst();
  const ping = {
    seq: 0,
    id: newId('event'),
    type: 'webhook.ping',
    actorId: ctx.actor.id,
    // requireAdmin above narrows the actor to a stored user kind (never anonymous).
    actor: toUserSummary({ ...ctx.actor, avatarUrl: null }, owner ?? null),
    projectId: row.project_id,
    issueId: null,
    data: { webhook: { id: row.id, url: row.url } },
    createdAt: now.toISOString(),
  };
  const body = JSON.stringify(row.payload === 'notice' ? toEventNotice(ping) : ping);
  const deliveryId = newId('webhookDelivery');
  const result = await (policy.send ?? sendWebhookRequest)({
    url: row.url,
    body,
    headers: webhookHeaders(row.secret, deliveryId, Math.floor(now.getTime() / 1000), body),
    allowPrivate: policy.allowPrivate,
  });
  return {
    ok: result.statusCode !== null && result.statusCode >= 200 && result.statusCode < 300,
    statusCode: result.statusCode,
    error: result.error,
    response: result.response?.slice(0, RESPONSE_EXCERPT) ?? null,
    durationMs: result.durationMs,
  };
}

// ---- deliveries --------------------------------------------------------------------------------------------

/** Retry schedule after each failed attempt: 1m, 5m, 30m, 2h, 12h — then the delivery is dead. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
/** Consecutive dead deliveries after which a webhook is disabled. */
export const WEBHOOK_DISABLE_AFTER = 5;
const RESPONSE_EXCERPT = 2048;

function deliveryQuery(db: Tx) {
  return db
    .selectFrom('webhook_deliveries as d')
    .leftJoin('events as e', 'e.seq', 'd.event_seq')
    .selectAll('d')
    .select(['e.id as event_id', 'e.type as event_type']);
}

type DeliveryRow = Awaited<ReturnType<ReturnType<typeof deliveryQuery>['execute']>>[number];

function toDelivery(r: DeliveryRow): WebhookDelivery {
  return {
    id: r.id,
    webhookId: r.webhook_id,
    eventSeq: Number(r.event_seq),
    eventId: r.event_id ?? null,
    eventType: r.event_type ?? null,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastAttemptAt: r.last_attempt_at,
    lastStatusCode: r.last_status_code,
    lastError: r.last_error,
    lastResponse: r.last_response,
    lastDurationMs: r.last_duration_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

export interface ListDeliveriesInput {
  status?: WebhookDeliveryStatus | undefined;
  limit?: number | undefined;
  /** Opaque cursor from a previous page. */
  cursor?: string | null | undefined;
}

/** A webhook's deliveries, newest event first. */
export async function listWebhookDeliveries(
  ctx: ServiceContext,
  webhookId: string,
  input: ListDeliveriesInput = {},
): Promise<Page<WebhookDelivery>> {
  requireAdmin(ctx, 'manage webhooks');
  const hook = await webhookRow(ctx.db.kysely, webhookId);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let q = deliveryQuery(ctx.db.kysely)
    .where('d.webhook_id', '=', hook.id)
    .orderBy('d.event_seq', 'desc')
    .limit(limit + 1);
  if (input.status) q = q.where('d.status', '=', input.status);
  if (input.cursor) {
    const before = Number(input.cursor);
    if (!Number.isInteger(before)) throw validationError('Invalid cursor');
    q = q.where('d.event_seq', '<', before);
  }
  const rows = await q.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map(toDelivery),
    nextCursor: rows.length > limit ? String(page.at(-1)!.event_seq) : null,
  };
}

export async function getWebhookDelivery(
  ctx: ServiceContext,
  id: string,
): Promise<WebhookDelivery> {
  requireAdmin(ctx, 'manage webhooks');
  if (!isIdOf('webhookDelivery', id)) throw notFound('Webhook delivery', id);
  const row = await deliveryQuery(ctx.db.kysely).where('d.id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Webhook delivery', id);
  return toDelivery(row);
}

/** Queues a delivery to be sent again as soon as possible (with a fresh set of retries). */
export async function redeliverWebhook(
  ctx: ServiceContext,
  deliveryId: string,
): Promise<WebhookDelivery> {
  requireAdmin(ctx, 'manage webhooks');
  if (!isIdOf('webhookDelivery', deliveryId)) throw notFound('Webhook delivery', deliveryId);
  return withWriteTx(ctx.db, async (tx) => {
    const now = nowIso(ctx);
    const updated = await tx
      .updateTable('webhook_deliveries')
      .set({
        status: 'pending',
        attempts: 0,
        next_attempt_at: now,
        completed_at: null,
        updated_at: now,
      })
      .where('id', '=', deliveryId)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw notFound('Webhook delivery', deliveryId);
    return toDelivery((await deliveryQuery(tx).where('d.id', '=', deliveryId).executeTakeFirst())!);
  });
}

// ---- dispatch + delivery (driven by WebhookRunner) --------------------------------------------------------

const CURSOR_KEY = 'webhook_cursor';
const DISPATCH_BATCH = 500;

/**
 * Fans new events out to matching active webhooks as `pending` deliveries, advancing a durable cursor over the
 * event log. Runs under the write lock, so concurrent replicas never skip or duplicate (the unique
 * `(webhook_id, event_seq)` constraint backs this up). On first run the cursor starts at the end of the log:
 * history is never replayed to webhooks. Returns the number of deliveries created.
 */
export async function dispatchWebhookEvents(
  ctx: Pick<ServiceContext, 'db' | 'clock' | 'ids'>,
): Promise<number> {
  let created = 0;
  for (;;) {
    const { more, count } = await withWriteTx(ctx.db, async (tx) => {
      const now = nowIso(ctx);
      const cursor = await ensureDispatchCursor(tx, now);
      const events = await tx
        .selectFrom('events')
        .select(['seq', 'type', 'project_id', 'created_at'])
        .where('seq', '>', cursor)
        .orderBy('seq')
        .limit(DISPATCH_BATCH)
        .execute();
      if (events.length === 0) return { more: false, count: 0 };
      const hooks = (await tx.selectFrom('webhooks').selectAll().execute())
        .map(toWebhook)
        .filter((h) => h.active);
      const rows = [];
      for (const event of events)
        for (const hook of hooks)
          if (
            webhookMatchesType(hook.eventTypes, event.type) &&
            (hook.projectId === null || hook.projectId === event.project_id) &&
            event.created_at >= hook.createdAt
          )
            rows.push({
              id: ctx.ids('webhookDelivery'),
              webhook_id: hook.id,
              event_seq: Number(event.seq),
              status: 'pending' as const,
              attempts: 0,
              next_attempt_at: now,
              locked_until: null,
              last_status_code: null,
              last_error: null,
              last_attempt_at: null,
              last_duration_ms: null,
              last_response: null,
              created_at: now,
              updated_at: now,
              completed_at: null,
            });
      for (let i = 0; i < rows.length; i += 100)
        await tx
          .insertInto('webhook_deliveries')
          .values(rows.slice(i, i + 100))
          .onConflict((oc) => oc.columns(['webhook_id', 'event_seq']).doNothing())
          .execute();
      await tx
        .updateTable('system_state')
        .set({ value: toJson({ seq: Number(events.at(-1)!.seq) }), updated_at: now })
        .where('key', '=', CURSOR_KEY)
        .execute();
      return { more: events.length === DISPATCH_BATCH, count: rows.length };
    });
    created += count;
    if (!more) return created;
  }
}

/**
 * The dispatch cursor: the last event seq fanned out to webhooks. Created at the current end of the log (when
 * the first webhook is registered), so webhooks only receive events that happen after they exist.
 */
async function ensureDispatchCursor(tx: Tx, now: string): Promise<number> {
  const state = await tx
    .selectFrom('system_state')
    .select('value')
    .where('key', '=', CURSOR_KEY)
    .executeTakeFirst();
  if (state) return fromJson<{ seq: number }>(state.value, { seq: 0 }).seq;
  const max = await tx
    .selectFrom('events')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .executeTakeFirst();
  const seq = Number(max?.seq ?? 0);
  await tx
    .insertInto('system_state')
    .values({ key: CURSOR_KEY, value: toJson({ seq }), updated_at: now })
    .execute();
  return seq;
}

export interface DeliverOptions {
  policy: WebhookPolicy;
  /** Deliveries claimed per round (sent concurrently). */
  batchSize?: number;
  /** How long a claim lasts before another worker may take the delivery over. */
  leaseMs?: number;
}

/**
 * Claims due deliveries (under the write lock, with a lease so a crashed worker's claims expire), sends them
 * outside any transaction, and records each outcome. Returns the number of deliveries attempted.
 */
export async function deliverDueWebhooks(
  ctx: Pick<ServiceContext, 'db' | 'clock'>,
  options: DeliverOptions,
): Promise<number> {
  const batchSize = options.batchSize ?? 20;
  const leaseMs = options.leaseMs ?? 60_000;
  const claimed = await withWriteTx(ctx.db, async (tx) => {
    const now = ctx.clock.now();
    const nowText = now.toISOString();
    const due = await tx
      .selectFrom('webhook_deliveries as d')
      .innerJoin('webhooks as w', 'w.id', 'd.webhook_id')
      .select([
        'd.id',
        'd.event_seq',
        'd.attempts',
        'w.id as webhook_id',
        'w.url',
        'w.secret',
        'w.payload',
      ])
      .where('d.status', 'in', ['pending', 'failed'])
      .where('d.next_attempt_at', '<=', nowText)
      .where((eb) => eb.or([eb('d.locked_until', 'is', null), eb('d.locked_until', '<=', nowText)]))
      .where('w.active', '=', true)
      .orderBy('d.next_attempt_at')
      .orderBy('d.event_seq')
      .limit(batchSize)
      .execute();
    if (due.length)
      await tx
        .updateTable('webhook_deliveries')
        .set({ locked_until: new Date(now.getTime() + leaseMs).toISOString() })
        .where(
          'id',
          'in',
          due.map((d) => d.id),
        )
        .execute();
    return due;
  });
  if (claimed.length === 0) return 0;

  const events = new Map<number, TrackerEvent>(
    (
      await getEventsBySeq(
        ctx.db.kysely,
        claimed.map((d) => Number(d.event_seq)),
      )
    ).map((e) => [e.seq, e]),
  );
  const send = options.policy.send ?? sendWebhookRequest;
  await Promise.all(
    claimed.map(async (delivery) => {
      const event = events.get(Number(delivery.event_seq));
      const attemptAt = ctx.clock.now();
      const body =
        event && JSON.stringify(delivery.payload === 'notice' ? toEventNotice(event) : event);
      const result = event
        ? await send({
            url: delivery.url,
            body: body!,
            headers: {
              ...webhookHeaders(
                delivery.secret,
                delivery.id,
                Math.floor(attemptAt.getTime() / 1000),
                body!,
              ),
              'x-poietic-issues-event': event.type,
              'x-poietic-issues-event-seq': String(event.seq),
              // Deprecated pre-rename names, sent for one more release (ADR 0020).
              'x-tracker-event': event.type,
              'x-tracker-event-seq': String(event.seq),
            },
            allowPrivate: options.policy.allowPrivate,
          })
        : { statusCode: null, response: null, error: 'Event no longer exists', durationMs: 0 };
      await recordAttempt(ctx, delivery, attemptAt, result, !event);
    }),
  );
  return claimed.length;
}

async function recordAttempt(
  ctx: Pick<ServiceContext, 'db' | 'clock'>,
  delivery: { id: string; attempts: number; webhook_id: string },
  attemptAt: Date,
  result: {
    statusCode: number | null;
    response: string | null;
    error: string | null;
    durationMs: number;
  },
  permanent: boolean,
) {
  const ok = result.statusCode !== null && result.statusCode >= 200 && result.statusCode < 300;
  const attempts = delivery.attempts + 1;
  const retryDelay = WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
  const dead = !ok && (permanent || retryDelay === undefined);
  const finishedAt = ctx.clock.now().toISOString();
  await withWriteTx(ctx.db, async (tx) => {
    await tx
      .updateTable('webhook_deliveries')
      .set({
        status: ok ? 'succeeded' : dead ? 'dead' : 'failed',
        attempts,
        next_attempt_at:
          ok || dead ? finishedAt : new Date(attemptAt.getTime() + retryDelay!).toISOString(),
        locked_until: null,
        last_status_code: result.statusCode,
        last_error: ok ? null : (result.error ?? `HTTP ${result.statusCode}`),
        last_response: result.response?.slice(0, RESPONSE_EXCERPT) ?? null,
        last_attempt_at: attemptAt.toISOString(),
        last_duration_ms: result.durationMs,
        updated_at: finishedAt,
        completed_at: ok || dead ? finishedAt : null,
      })
      .where('id', '=', delivery.id)
      .execute();
    if (ok)
      await tx
        .updateTable('webhooks')
        .set({ failure_count: 0 })
        .where('id', '=', delivery.webhook_id)
        .where('failure_count', '>', 0)
        .execute();
    else if (dead) {
      const hook = await tx
        .updateTable('webhooks')
        .set((eb) => ({ failure_count: eb('failure_count', '+', 1) }))
        .where('id', '=', delivery.webhook_id)
        .returning(['failure_count'])
        .executeTakeFirst();
      if (hook && hook.failure_count >= WEBHOOK_DISABLE_AFTER)
        await tx
          .updateTable('webhooks')
          .set({ active: false, disabled_at: finishedAt, updated_at: finishedAt })
          .where('id', '=', delivery.webhook_id)
          .execute();
    }
  });
}
