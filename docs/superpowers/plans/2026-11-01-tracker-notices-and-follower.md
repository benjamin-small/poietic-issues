# Tracker notices, change reasons and the event follower: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rollout step 2 of the push design. The tracker can send content-free notice webhooks, signed with a secret the bridge supplies. Every write can carry a one-line reason, which is stored on its event. `@poietic-tech/issues-client` is published with a follower API, so agents can read what changed as themselves.

**Architecture:**

- **Webhooks.** A webhook gets a `payload` mode (`full`, the default, or `notice`) and an optional supplied secret. Delivery code picks the body per webhook. Signing, retries and leasing are untouched.
- **Reasons.** `X-Change-Reason` is read by middleware into `ServiceContext.reason`, the same way `X-Request-Id` becomes `requestId`. `recordEvent` stores it as `data.reason`.
- **Client.** The client package gains plain functions over the generated `ApiClient`: `changes`, `follow`, `history`, `provenance`, typed events and helpers. It is built with tsdown and released from a tag through npm trusted publishing, like `@poietic-tech/issues`.

**Tech Stack:** TypeScript (strict, ESM), Hono + `@hono/zod-openapi`, Kysely on SQLite and Postgres, zod 4, openapi-fetch, Vitest, tsdown, Svelte 5 (activity timeline), commander (CLI).

**Spec:** `docs/superpowers/specs/2026-11-01-tracker-push-design.md` (sections 1, 2, 3 and 6; section 4 is shipped in poietic-tech/poietic-bridge#8).

## Global Constraints

- `pnpm check` must pass before every commit. Database tests must pass under both `TEST_DB=sqlite` and `TEST_DB=postgres` (`pnpm test:pg`, after `pnpm pg start`).
- Business logic goes in `packages/core`. `packages/schema` stays isomorphic.
- Portable SQL only. Write through `withWriteTx`. Timestamps come from the injected clock.
- A route or schema change regenerates `docs/openapi.json` and the client types (`pnpm openapi:gen`), committed with the change.
- CLI output changes refresh the golden files and `docs/cli-reference.md` (`pnpm vitest run --project cli -u`).
- **Full payloads stay the default.** Existing webhooks behave exactly as before.
- **Delivery is unchanged:** Standard Webhooks signing, retries after 1m, 5m, 30m, 2h and 12h, leasing, and disabling a webhook after 5 dead deliveries.
- The notice body is exactly `{ seq, id, type, projectId, issueId, actorId, createdAt }`, in that key order, with no other field. The bridge's adapter refuses anything else, and anything over 8 KiB.
- `X-Change-Reason` holds at most 200 characters. It is stored on the event as `data.reason`.
- **Secrets.** A supplied secret is never echoed in an error, a log line or a list response. It is returned only by the create call, as today. Never print, commit or paste a real secret.
- The new ADR is **0032**: 0030 and 0031 are taken by the open PRs #40 and #41.
- Migration **0008** is the next free one.
- `follow()` never polls on its own. The bridge part is not in this repository (spec section 3, last bullet); persistent-agents owns it.

## Review Focus

These are inputs the spec implies but its words don't cover. Each is pinned by a test in the task named.

1. **A reason with non-ASCII characters** (an em dash, curly quotes, emoji). `fetch` refuses header values outside Latin-1, so the wire format is percent-encoded UTF-8. The reason must reach `data.reason` exactly as the agent wrote it. → Task 3 and Task 4.
2. **A supplied secret the bridge could not verify.** Examples: base64url, missing padding, or under 16 bytes. The tracker refuses it, so a webhook can never be created that the bridge would 401 forever. → Task 2.
3. **A last `/events` page whose events were all hidden by content rules, or an empty page.** `through` must still be a valid cursor, never moving backwards and never looping. → Task 5.
4. **A forged hand-off.** Another project writer edits `poietic.pm.assignment` and the assignee to the agent. `provenance` must name the forger as actor, not the manager. → Task 6.
5. **The test ping on a notice webhook.** It must be notice-shaped (`seq: 0`, `type: "webhook.ping"`) or the bridge refuses it with a 400, and the operator's first check fails. → Task 1.

---

### Task 1: Notice payload for webhooks

**Files:**

- Create: `packages/db/src/migrations/0008_webhook_payload.ts`
- Modify: `packages/db/src/migrate.ts` (register `0008_webhook_payload`), `packages/db/src/types.ts` (`WebhooksTable.payload`)
- Modify: `packages/schema/src/webhooks.ts`, `packages/core/src/services/webhooks.ts`, `apps/server/src/routes/webhooks.ts`, `apps/cli/src/commands/webhooks.ts`, `apps/cli/src/output.ts` (webhook table)
- Test: `packages/core/src/webhooks.test.ts`, `apps/server/src/webhooks.test.ts`, `packages/db/src/db.test.ts` (if it pins the migration list), CLI tests and golden files

**Interfaces:**

- Produces:
  - `WEBHOOK_PAYLOADS = ['full', 'notice'] as const` and `type WebhookPayload`.
  - `EventNoticeSchema` (id `EventNotice`) and `type EventNotice`.
  - `toEventNotice(event: Pick<TrackerEvent, 'seq'|'id'|'type'|'projectId'|'issueId'|'actorId'|'createdAt'>): EventNotice`, which returns the keys in the fixed order.
  - `Webhook.payload: WebhookPayload`. `CreateWebhookInput.payload` defaults to `'full'`. `UpdateWebhookInput.payload` is optional.

- [ ] **Step 1: Write the failing tests** in `packages/core/src/webhooks.test.ts`, alongside the existing delivery tests and using their fake `send`:
  - `'notice webhooks send only the notice'`. Create a webhook with `payload: 'notice'` and update an issue, then dispatch and deliver. The sent body must equal `JSON.stringify({ seq, id, type: 'issue.updated', projectId, issueId, actorId, createdAt })` for that event. Its byte length must be under 8192. The headers must still carry `x-poietic-issues-event` and a `webhook-signature` that `verifyWebhook` accepts.
  - `'full payload stays the default'`. A webhook created without `payload` reports `payload: 'full'`, and its body still includes `data`.
  - `'payload can be switched'`. `updateWebhook(ctx, id, { payload: 'notice' })` returns `payload: 'notice'`, and the next delivery sends a notice.
  - `'the test ping of a notice webhook is a notice'`. `testWebhook` on a notice webhook sends exactly `{ seq: 0, id, type: 'webhook.ping', projectId: <scope or null>, issueId: null, actorId: <admin id>, createdAt }`, with no `actor` and no `data`.
  - `'an unknown payload is refused'`. `createWebhook(ctx, { url, payload: 'snapshot' as never })` throws `VALIDATION_FAILED`.
- [ ] **Step 2: Run** `pnpm vitest run --project core -t "notice|payload"`. Expected: FAIL, because `payload` is unknown or the body is the full event.
- [ ] **Step 3: Implement.**
  - **Migration 0008** adds `payload` (`t.text`, not null, default `'full'`) to `webhooks`. `down` drops it. Follow `0002_webhook_delivery_details.ts`.
  - **Schema.** Add `payload: z.enum(WEBHOOK_PAYLOADS)` to `WebhookSchema`, with the description "`full` sends the event as in `GET /events`; `notice` sends only its seq, ids, type and time." Add it to `CreateWebhookInputSchema` with `.default('full')` and to `UpdateWebhookInputSchema` as `.optional()`.
  - **Service.** `toWebhook` maps `payload`; `createWebhook` and `updateWebhook` store it.
  - **Delivery.** `deliverDueWebhooks` selects `w.payload`, then builds `body` once per delivery: `JSON.stringify(payload === 'notice' ? toEventNotice(event) : event)`. Use that same string for signing and sending.
  - **Ping.** `testWebhook` builds the notice ping when `row.payload === 'notice'`.
  - **OpenAPI.** Register a second webhook, `path: 'notice'`, with the same headers and `body: jsonBody(EventNoticeSchema)`, plus a description saying it is sent instead of `event` when `payload` is `notice`.
- [ ] **Step 4: Run** `pnpm vitest run --project core -t "notice|payload"`. Expected: PASS.
- [ ] **Step 5: Add the server test** `'POST /webhooks accepts payload: notice and the receiver gets a notice'` to `apps/server/src/webhooks.test.ts`, using the real receiver server already in that file. Then add `--payload <full|notice>` to `webhook create` and `webhook edit` in the CLI, and a `PAYLOAD` column to the webhook table in `output.ts`. Add a CLI test that `webhook create … --payload notice` sends `payload: 'notice'`.
- [ ] **Step 6: Regenerate.** Run `pnpm openapi:gen`, then `pnpm vitest run --project cli -u`, then `pnpm check`. Run `pnpm pg start && pnpm test:pg` too, because of the migration. Expected: all PASS. The diff to `docs/openapi.json` and `cli-reference.md` shows only the payload additions.
- [ ] **Step 7: Commit** `feat(webhooks): notice payloads that carry only the event's seq, ids and type`.

### Task 2: A supplied webhook secret

**Files:**

- Modify: `packages/schema/src/webhooks.ts`, `packages/core/src/services/webhooks.ts`, `packages/core/src/webhooks/signing.ts`, `apps/cli/src/commands/webhooks.ts`
- Test: `packages/core/src/webhooks.test.ts`, `apps/server/src/webhooks.test.ts`, CLI tests

**Interfaces:**

- Produces:
  - `WebhookSecretSchema`, which is `whsec_` followed by canonical standard base64 (with padding, alphabet `A-Za-z0-9+/`) decoding to 16–64 bytes.
  - `CreateWebhookInput.secret?: string`.
  - The CLI flag `webhook create --secret-stdin`.

- [ ] **Step 1: Write the failing tests** in `packages/core/src/webhooks.test.ts`:
  - `'a supplied secret is stored and signs deliveries'`. Create with `secret: 'whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw='`. The create response returns that same secret, and a delivery verifies with it.
  - `'the signature matches the bridge's vector'`. `signWebhook('whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=', 'whd_01jvector', 1800000000, <the bridge test's body>)` must equal `'v1,wpoJY0Zmwpy23ozMFAcZH13pC1MEPU36DKHDLIKD/z8='`. The body is copied byte for byte from `apps/worker/test/poietic-issues.test.ts` in poietic-bridge:
    ```
    {"seq":7,"id":"evt_01jvector","type":"issue.created","projectId":"prj_01jvector","issueId":"iss_01jvector","actorId":"usr_01jvector","createdAt":"2026-11-01T12:00:00.000Z"}
    ```
    This is the cross-side test the spec asks for in section 4.
  - `'a secret the bridge could not verify is refused'`. Each of these fails with `VALIDATION_FAILED` on path `secret`:
    - no prefix: `AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw=`
    - base64url characters: `whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw_-`
    - padding stripped: `whsec_AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw`
    - 8 bytes: `whsec_AAAAAAAAAAA=`
    - 100 bytes
    - empty: `whsec_`

    None of the error messages may contain the submitted value. Assert `JSON.stringify(error)` does not include it.

  - `'list and get never return the secret'`. After a supplied-secret create, `listWebhooks` and `getWebhook` results have no `secret` key.
- [ ] **Step 2: Run** `pnpm vitest run --project core -t "secret"`. Expected: FAIL, with `secret` stripped or not stored.
- [ ] **Step 3: Implement.** Add `secret: WebhookSecretSchema.optional()` to `CreateWebhookInputSchema`. Its description: "Signing secret to use instead of a generated one (for receivers that issue their own, such as the bridge). `whsec_` and standard base64 of 16–64 bytes." Its error message names the rule, not the value. In `createWebhook`, use `data.secret ?? generateWebhookSecret()`. `rotateWebhookSecret` stays generated-only (YAGNI: the bridge rotates by recreating the terminal, as its runbook says).
- [ ] **Step 4: Run** `pnpm vitest run --project core -t "secret"`. Expected: PASS.
- [ ] **Step 5: Add the CLI flag.** `--secret-stdin` reads the whole of stdin, trims one trailing newline, and sends it as `secret`. The secret never travels as an argument, so it stays out of shell history. Combined with `--payload notice`, the human output still prints the secret once, as today. Add a CLI test that piped stdin reaches the body, and that `--secret-stdin` with an empty stdin is a usage error (exit 2). Add a server test that `POST /webhooks` with a malformed `secret` answers 400 and the response body does not contain it.
- [ ] **Step 6: Regenerate.** Run `pnpm openapi:gen`, then `pnpm vitest run --project cli -u`, then `pnpm check`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(webhooks): accept a supplied signing secret`.

### Task 3: `X-Change-Reason`, stored as `data.reason`

**Files:**

- Modify: `apps/server/src/middleware/auth.ts` (new `changeReason` middleware next to `requestId`, and `reason` in the context `authenticate` builds), `apps/server/src/app.ts` (`root.use('*', changeReason)` after `requestId`), `apps/server/src/env.ts` (`Variables.changeReason`)
- Modify: `packages/core/src/context.ts` (`ServiceContext.reason?: string`), `packages/core/src/events.ts` (`recordEvent`), `packages/schema/src/events.ts` (`base.reason`)
- Modify: `apps/web/src/lib/components/ActivityTimeline.svelte`, `apps/cli/src/output.ts` (event table)
- Test: `apps/server/src/api.test.ts` (or a new `apps/server/src/reason.test.ts`), `packages/core/src/events.test.ts` or the nearest events test, CLI golden files, `apps/web/e2e` (one assertion in an existing activity spec)

**Interfaces:**

- Produces:
  - **Wire format.** `X-Change-Reason: <percent-encoded UTF-8>`. Plain ASCII without `%` passes through unchanged, so `curl -H 'X-Change-Reason: triaged'` works.
  - **Server rules.**
    1. The header is read only on POST, PUT, PATCH and DELETE.
    2. The value is decoded with `decodeURIComponent`, then trimmed. An empty result means there is no reason.
    3. The request is refused with 400 `VALIDATION_FAILED` when the value is malformed percent-encoding, when it is over 200 characters after decoding (counted in code points), or when it contains a control character (`\p{Cc}`).
  - `data.reason?: string` on every event type.

- [ ] **Step 1: Write the failing tests** in the server test file, against the real app:
  - `'a reason is stored on the event'`. PATCH an issue with `X-Change-Reason: triaged as a bug`. `GET /events` and `GET /issues/{issue}/activity` both show `data.reason === 'triaged as a bug'` next to `data.requestId`.
  - `'a percent-encoded reason is decoded'`. Send the header `encodeURIComponent('handed off — see “plan”')` and expect `data.reason === 'handed off — see “plan”'`.
  - `'a bad reason is refused'`:
    - each of `%E0%A4%A`, `'x'.repeat(201)` and `'a%0Ab'` (decodes to a newline) gets a 400 `VALIDATION_FAILED`, and no event is recorded;
    - `'é'.repeat(200)`, percent-encoded, is accepted, because the limit counts characters.
  - `'a reason on a read is ignored'`. A GET with an invalid reason header still answers 200.
  - `'no reason, no key'`. Events from writes without the header have no `reason` key.
  - `'a whitespace reason is no reason'`. The header `'   '` gives no `reason` key.
  - `'a reason goes out in full webhooks'`. A full-payload delivery's `data.reason` is set.
- [ ] **Step 2: Run** `pnpm vitest run --project server -t "reason"`. Expected: FAIL, because `data.reason` is undefined.
- [ ] **Step 3: Implement.**
  - **Middleware.** `changeReason` validates per the rules above and returns `problem(c, 'VALIDATION_FAILED', 'X-Change-Reason must be one line of at most 200 characters, percent-encoded UTF-8')`. The message never includes the value.
  - **Context.** `authenticate` passes `reason: c.get('changeReason')` into the `ServiceContext`.
  - **Recording.** `recordEvent` merges `{ requestId, reason }` into `data`, leaving each key out when it is undefined.
  - **Schema.** Add `reason: z.string().max(200).optional().meta({ description: 'Why the change was made (from X-Change-Reason).' })` to `base` in `packages/schema/src/events.ts`.
- [ ] **Step 4: Run** `pnpm vitest run --project server -t "reason"`. Expected: PASS.
- [ ] **Step 5: Show the reason.**
  - **Web.** In `ActivityTimeline.svelte`, an event entry whose `data.reason` is set shows it after the description line, as muted text: `— {reason}`, inside a `<span data-testid="change-reason">`. Svelte escapes it, so don't use `{@html}`. Add one assertion to an existing activity e2e spec: an issue updated through the API with a reason shows that text.
  - **CLI.** Add a `REASON` column to the `event` table in `output.ts`, after `SUBJECT`. Then refresh the golden files.
- [ ] **Step 6: Document.** In `docs/api.md`, describe the header next to the request-id behaviour (the wire format, the rules, and that agents always send it). In `docs/events.md`, describe `data.reason`.
- [ ] **Step 7: Verify.** Run `pnpm openapi:gen`, then `pnpm vitest run --project cli -u`, then `pnpm check`, then `pnpm e2e`. Expected: PASS. Stop any running preview before `pnpm e2e`.
- [ ] **Step 8: Commit** `feat: record a one-line reason on every change (X-Change-Reason)`.

### Task 4: Client: typed events, reasons and helpers

**Files:**

- Create: `packages/client/src/events.ts`, `packages/client/src/events.test.ts`
- Modify: `packages/client/src/index.ts` (re-export), `packages/client/package.json` (`@poietic-tech/issues-schema` moves to `devDependencies`, because only the tests import it)

**Interfaces:**

- Consumes: `Schemas['Event']`, `Schemas['Issue']`, `Schemas['Comment']` and `Schemas['IssueRef']` from the generated types (regenerated in Tasks 1–3).
- Produces:

  ```ts
  type Change<T = unknown> = { from: T; to: T };
  type EventMeta = { requestId?: string; reason?: string };
  type IssueEvent = Omit<Schemas['Event'], 'type' | 'data'> & {
    type: 'issue.created' | 'issue.updated' | 'issue.deleted' | 'issue.restored';
    data: EventMeta & {
      issue: Schemas['Issue'];
      changes?: Partial<Record<keyof Schemas['Issue'], Change>>;
    };
  };
  type CommentEvent = Omit<Schemas['Event'], 'type' | 'data'> & {
    type: 'comment.created' | 'comment.updated' | 'comment.deleted';
    data: EventMeta & { comment: Schemas['Comment']; issue: Schemas['IssueRef'] };
  };
  type OtherEvent = Omit<Schemas['Event'], 'data'> & {
    type: Exclude<Schemas['Event']['type'], IssueEvent['type'] | CommentEvent['type']>;
    data: EventMeta & Record<string, unknown>;
  };
  type TypedEvent = IssueEvent | CommentEvent | OtherEvent;
  function typed(event: Schemas['Event']): TypedEvent; // a cast with a type guard; no runtime copy
  const REASON_MAX = 200;
  function reasonHeaders(reason: string | undefined): Record<string, string>; // {} for undefined/blank; throws RangeError over 200 chars or with a control char
  interface Me {
    userId: string;
    ownRequest?: (requestId: string) => boolean;
    projectIds?: readonly string[];
    issueIds?: ReadonlySet<string>;
  }
  function isOwnWrite(event: Schemas['Event'], me: Pick<Me, 'userId' | 'ownRequest'>): boolean;
  type Concern = 'newly_assigned' | 'assigned' | 'comment_on_mine' | 'in_my_project';
  function concerns(event: Schemas['Event'], me: Me): Concern | null; // most specific first, in the order above
  function byIssue(events: readonly Schemas['Event'][]): Map<string, Schemas['Event'][]>; // issueId → events in seq order; events without an issue left out
  ```

- [ ] **Step 1: Write the failing tests** in `events.test.ts`, using event fixtures shaped like real `GET /events` output:
  - `reasonHeaders`:
    - `reasonHeaders('handed off — see “plan”')` equals `{ 'x-change-reason': encodeURIComponent(…) }`;
    - `reasonHeaders(undefined)` and `reasonHeaders('  ')` equal `{}`;
    - `reasonHeaders('x'.repeat(201))` throws `RangeError`;
    - `reasonHeaders('a\nb')` throws `RangeError`.
  - `isOwnWrite`:
    - true when `actorId === me.userId`;
    - true when `ownRequest(data.requestId)` returns true and the actor is someone else;
    - false otherwise.
  - `concerns`:
    - an `issue.updated` with `changes.assignee.to.id === me.userId` gives `'newly_assigned'`. The `assignee` change carries user summaries; the server test in Task 6 checks that shape against the real server;
    - `data.issue.assigneeId === me.userId` with no assignee change gives `'assigned'`;
    - a `comment.created` with `data.issue.id` in `me.issueIds` gives `'comment_on_mine'`;
    - a `projectId` in `me.projectIds` gives `'in_my_project'`;
    - none of those gives `null`;
    - an `issue.updated` that unassigns me (`changes.assignee.from.id === me.userId`, `to: null`) gives `'in_my_project'` or `null`, never `'assigned'`.
  - `byIssue` groups by issue and keeps seq order.
  - **Type sync.** A compile-time check pins the client's event type unions to the real list: the union of `IssueEvent['type'] | CommentEvent['type'] | OtherEvent['type']` must equal `(typeof EVENT_TYPES)[number]` from `@poietic-tech/issues-schema`. `pnpm check`'s typecheck enforces it.
- [ ] **Step 2: Run** `pnpm vitest run --project client`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** `events.ts` to the interfaces above, and re-export it from `index.ts`.
- [ ] **Step 4: Run** `pnpm vitest run --project client`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(client): typed events, reasons and helpers for agents`.

### Task 5: Client: `changes()` and `follow()`

**Files:**

- Create: `packages/client/src/follow.ts`, `packages/client/src/follow.test.ts`
- Modify: `packages/client/src/index.ts`

**Interfaces:**

- Consumes: `ApiClient`, `unwrap` and `ApiError` from `index.ts`, and `Schemas['Event']`.
- Produces:
  ```ts
  interface ChangesQuery {
    after: number;
    project?: string;
    types?: readonly Schemas['Event']['type'][];
    limit?: number;
  }
  interface ChangesPage {
    events: Schemas['Event'][];
    through: number;
    more: boolean;
  }
  function changes(api: ApiClient, query: ChangesQuery): Promise<ChangesPage>;
  interface Cursor {
    load(): Promise<number>;
    save(through: number): Promise<void>;
  }
  /** Subscribe to wake-ups; returns an unsubscribe function. A bridge listener adapts to this in persistent-agents. */
  type WakeSource = (wake: () => void) => () => void;
  interface FollowBase extends Omit<ChangesQuery, 'after'> {
    cursor: Cursor;
    onBatch(events: Schemas['Event'][], through: number): Promise<void>;
  }
  // A wake-driven run has no caller to reject to, so a follower with `wake` must say where its errors go.
  type FollowOptions = FollowBase &
    ({ wake?: undefined } | { wake: WakeSource; onError(error: unknown): void });
  interface Follower {
    run(): Promise<number>;
    stop(): void;
  } // run → the cursor after draining every page
  function follow(api: ApiClient, options: FollowOptions): Follower;
  ```
- **My call: one `project`, not `projects?`** (the spec's sketch). `GET /events` filters one project, and a role watching several projects reads them all through one cursor and filters with `concerns`. One cursor per project would multiply the reads that each wake-up makes.

- [ ] **Step 1: Write the failing tests** in `follow.test.ts`, using a fake `fetch` that serves scripted `/events` pages and records the query strings it was asked for:
  - **`changes()`**
    - `'through is nextCursor when there is more'`: given `nextCursor: '120'`, it returns `{ through: 120, more: true }`.
    - `'through is the last seq on the last page'`: given events 101 and 105 with `nextCursor: null` and `after: 100`, it returns `{ through: 105, more: false }`.
    - `'an empty last page keeps the cursor'`: after 100 with no events, it returns `{ through: 100, more: false }`. This is Review Focus 3.
    - `'a cursor that moves backwards is an error'`: given `nextCursor: '90'` after 100, it throws.
    - `'a page that claims more but does not advance is an error'`: given `nextCursor: '100'` after 100, it throws. Otherwise the loop would never end.
    - `'project and types reach the query'`: the request carries `project=ENG&types=issue.created,issue.updated`.
  - **`follow()`**
    - `'run drains every page, then saves'`: three pages arrive in one `run()`, `onBatch` is called per non-empty page in order, and `save` is called after each `onBatch` resolves with that page's `through`.
    - `'a failing onBatch does not save'`: `onBatch` rejects on page 2. `run()` rejects, `save` was called once (for page 1), and the next `run()` starts from page 1's `through`.
    - `'no wake, no requests'`: create a follower without `wake` and wait 100 ms. The fetch was never called.
    - `'wakes during a run coalesce'`: three wakes fire while a run is in flight. Exactly one more run follows.
    - `'stop unsubscribes'`: after `stop()`, the wake source's unsubscribe has been called and later wakes do nothing.
    - `'a wake-driven failure goes to onError and the follower lives'`.
- [ ] **Step 2: Run** `pnpm vitest run --project client -t "changes|follow"`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** `follow.ts`.
  - **Single-flight.** At most one run is in flight. A wake during a run sets a `rerun` flag, and the run loops once more when it finishes. `run()` called during a run returns the in-flight promise.
  - **Empty pages.** An empty page that has `more` still saves its `through`, so hidden events are not re-read forever.
- [ ] **Step 4: Run** `pnpm vitest run --project client`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(client): follow the event log from a saved cursor, woken from outside`.

### Task 6: Client: `history()` and `provenance()`, against the real server

**Files:**

- Create: `packages/client/src/history.ts`, `packages/client/src/history.test.ts` (unit, fake fetch), `apps/server/src/follower.test.ts` (integration, real app and real users)
- Modify: `packages/client/src/index.ts`. Add `@poietic-tech/issues-client` to `apps/server` `devDependencies` if it is not already there.

**Interfaces:**

- Consumes: `typed` and `Change` from Task 4, and `changes` and `follow` from Task 5 (in the integration test).
- Produces:

  ```ts
  interface HistoryEntry {
    seq: number;
    type: Schemas['Event']['type'];
    at: string;
    actorId: string | null;
    actor: Schemas['Event']['actor'];
    changes: Record<string, Change>;
    reason: string | null;
    requestId: string | null;
  }
  function history(api: ApiClient, issue: string): Promise<HistoryEntry[]>; // every /issues/{issue}/activity page, oldest first
  /** `'assignee'` or `'metadata.<key>'`. */
  type ProvenanceField = 'assignee' | `metadata.${string}`;
  function provenance(
    api: ApiClient,
    issue: string,
    fields: readonly ProvenanceField[],
  ): Promise<Record<ProvenanceField, HistoryEntry | null>>;
  ```
  - **What counts as setting a field.** An `issue.created` sets each field whose value in `data.issue` is not null or absent. An `issue.updated` sets `assignee` when `changes.assignee` exists. It sets `metadata.<key>` when `JSON.stringify(changes.metadata.from?.[key]) !== JSON.stringify(changes.metadata.to?.[key])`.
  - The result for each field is the latest entry that set it, or `null` if nothing did.

- [ ] **Step 1: Write the failing unit tests** in `history.test.ts`, with a fake `fetch` serving two activity pages:
  - `history` joins the pages in order and copies `reason`/`requestId` from `data`, using null when they are absent.
  - `provenance`:
    - a metadata change to a different key does not count for `metadata.poietic.pm.assignment`;
    - a later unassign makes `assignee` point at the unassigning event;
    - a field never set gives `null`.
- [ ] **Step 2: Write the failing integration tests** in `apps/server/src/follower.test.ts`. Use the real app as `createClient({ baseUrl: 'http://t', fetch: app.fetch, token })`, with `testSso(t)` bearers for a `manager` agent, a `coder` agent and a `writer` person, all writers on one project. Read the existing server tests to see how they create agent users and grant roles.
  - `'a hand-off by the manager is proven'`. The manager PATCHes the issue with assignee `coder` and metadata `{ 'poietic.pm.assignment': 'a1' }`, sending `reasonHeaders('assigned to coding')`. Run as the coder, `provenance(..., ['assignee', 'metadata.poietic.pm.assignment'])` returns the same entry for both fields. Its `actorId` is the manager's user id and its `reason` is `'assigned to coding'`.
  - `'a forged hand-off names the forger'`. The writer PATCHes the same two fields on a second issue. Both entries have `actorId` equal to the writer, not the manager. This is Review Focus 4.
  - `'a later edit by a person moves provenance'`. After the manager's hand-off, the writer changes only `metadata.poietic.pm.assignment`. That field's entry is the writer's, while `assignee` stays the manager's. The persistent-agents rule then refuses the hand-off, because the two fields' entries differ.
  - `'concerns sees a real assignment'`. The `issue.updated` event from the manager's PATCH, read through `changes()` as the coder, gives `concerns(event, { userId: coder }) === 'newly_assigned'`. This pins the `changes.assignee` shape from Task 4.
  - `'follow reads what a notice announced'`. As the coder, `follow({ cursor: <in-memory>, onBatch })` sees the manager's event once with `run()`. A second `run()` delivers nothing new.
- [ ] **Step 3: Run** `pnpm vitest run --project client -t "history|provenance"` and `pnpm vitest run --project server -t "follower"`. Expected: FAIL, because the module is missing.
- [ ] **Step 4: Implement** `history.ts`.
- [ ] **Step 5: Run** both commands again, then `pnpm test:pg` for the server project. Expected: PASS on both dialects.
- [ ] **Step 6: Commit** `feat(client): issue history and field provenance from the event log`.

### Task 7: Publish `@poietic-tech/issues-client`

**Files:**

- Create: `packages/client/tsdown.config.ts`, `packages/client/README.md`, `packages/client/LICENSE` (copy the root one), `packages/client/src/bundle.test.ts`, `.github/workflows/release-issues-client.yml`
- Modify: `packages/client/package.json`, `docs/releases.md`, `.github/workflows/ci.yml` (only if it needs a step to build the client before `bundle.test.ts`; follow how `apps/cli/test/bundle.test.ts` is run)

**Interfaces:**

- Produces: an npm package with `exports: { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`, `files: ["dist", "README.md", "LICENSE"]`, `version: "0.1.0"`, no `private`, `license: "MIT"`, `engines.node: ">=22.12"`, `repository.directory: "packages/client"`, and `dependencies: { "openapi-fetch": "^0.17.0" }` only. The tag is `issues-client-vX.Y.Z`.
- Inside the monorepo, other workspace packages keep importing `src/index.ts`. Use a `development`/`source` export condition, or point `exports["."]` at `src` with `publishConfig.exports` overriding it for the tarball. Check which one the repo's `tsconfig.base.json` and Vitest resolve. Rule and record the choice; the internal-packages-export-`src` convention must keep working.

- [ ] **Step 1: Write the failing test** `bundle.test.ts`, modelled on `apps/cli/test/bundle.test.ts`:
  - it builds with `pnpm --filter @poietic-tech/issues-client build` (or expects `dist/` to exist, as the CLI test does);
  - it imports `dist/index.js` and checks `createClient`, `changes`, `follow`, `history`, `provenance`, `isOwnWrite`, `concerns` and `reasonHeaders` are functions;
  - `dist/index.d.ts` exists and references no `@poietic-tech/issues-schema`;
  - the package's `dependencies` hold no `workspace:` or `file:` specifier.
- [ ] **Step 2: Run** `pnpm vitest run --project client -t bundle`. Expected: FAIL, because there is no build.
- [ ] **Step 3: Implement.** Add the tsdown config (ESM, `dts: true`, entry `src/index.ts`, `openapi-fetch` external) and the package.json fields above, plus the `build` script. Add the README: install, `createClient`, a follower example with a cursor, `reasonHeaders` on a write, and `provenance` for hand-offs. Add the workflow, copied from `release-issues.yml` and changed only where it must be:
  - the package directory;
  - the tag glob `issues-client-v*`;
  - the test project;
  - environment `npm`.
    Keep its guards: the tag is on `main` and matches the version, and there are no `workspace:` dependencies.
- [ ] **Step 4: Run** `pnpm --filter @poietic-tech/issues-client build`, then `pnpm vitest run --project client`, then `pnpm check`. Expected: PASS.
- [ ] **Step 5: Document** in `docs/releases.md`, as a section "Releasing `@poietic-tech/issues-client`" mirroring the issues one. List the one-time owner steps:
  1. Claim the npm name with a manual placeholder publish (`0.0.1-stage`, `--tag stage`).
  2. Add a trusted publisher: `poietic-tech` / `poietic-issues` / `release-issues-client.yml` / `npm`.
  3. Extend the `npm` environment's tag rule and the tag ruleset to `issues-client-v*`.
- [ ] **Step 6: Commit** `build(client): publish @poietic-tech/issues-client from a tag`.

### Task 8: Runbook, ADR 0032 and agent guidance

**Files:**

- Create: `docs/adr/0032-notice-webhooks-and-change-reasons.md` (from `0000-template.md`)
- Modify: `docs/adr/README.md`, `docs/deployment.md` (the runbook), `docs/agents.md`, `docs/superpowers/specs/2026-11-01-tracker-push-design.md` (section 6 points to the runbook; the status line says the server work is in progress)

- [ ] **Step 1: Write the ADR.** It records:
  - **Context:** pods poll, and the bridge must never hold issue content.
  - **Decision:**
    - notice payloads as an opt-in, per-webhook mode;
    - a supplied secret restricted to what the bridge verifies;
    - `X-Change-Reason`, percent-encoded and at most 200 characters, stored as `data.reason`;
    - the published client, which owns following and provenance;
    - provenance from `actorId`, never from metadata alone.
  - **Consequences:**
    - the client is a public contract with its own version;
    - `rotate-secret` stays generated-only;
    - reasons are visible to everyone who can read the event.
- [ ] **Step 2: Write the runbook** in `docs/deployment.md`, under "Pushing tracker events to agents through the bridge": spec section 6's four steps, in order, with exact commands.
  1. **Readers group.** Create the readers group and add each listening agent. Confirm the group name with the owner first: a terminal's readers cannot change later.
  2. **Secret pipe.** Create the terminal and webhook in one pipe, so the secret never shows on screen or in history:
     ```sh
     poietic-tech bridge terminal create poietic-issues --adapter poietic-issues --readers <group> -q \
       | poietic-tech issues webhook create https://bridge.poietic.tech/in/poietic-issues \
           --payload notice -e 'issue.*,comment.*' --secret-stdin --description 'Agent wake-ups through the bridge'
     ```
     Verify that `-q` on the bridge's `out.secret` prints only the secret. If it does not, document the paste-into-stdin route instead: run the second command alone, paste, then Ctrl-D.
  3. **Test ping.** Run `poietic-tech issues webhook test <id>`. Expect `ok: true`, then see the ping on the terminal with the bridge CLI.
  4. **Deploy listeners.** That happens in persistent-agents.

  Then add:
  - **Rollback:** delete the webhook first, then the terminal.
  - **Event types:** `link.*` and `attachment.*` are not subscribed. No listener in the spec acts on them, so leaving them out keeps idle wake-ups down. Recorded as my call in the ADR.

- [ ] **Step 3: Agent guidance.** In `docs/agents.md`, add a short section:
  - every write an agent makes sends a reason;
  - bigger decisions also get a comment under the agent's own identity;
  - a woken agent reads `/events` from its own cursor, never from the notice;
  - hand-offs are checked with `provenance`.
- [ ] **Step 4: Run** `pnpm check`. Expected: PASS (Prettier covers the docs).
- [ ] **Step 5: Commit** `docs: runbook, ADR 0032 and agent guidance for tracker notices`.
