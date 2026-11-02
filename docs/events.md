# Events: history, live updates and integrations

Every change is appended to the `events` table in the same transaction as the change ([ADR 0004](adr/0004-event-log-bus-and-outbox.md)). That one log feeds:

| Consumer                   | How                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Issue activity             | `GET /issues/{issue}/activity`                                                                                |
| Agents and scripts polling | `GET /events?after=<seq>` · `poietic-tech issues event list --after <seq>` · `poietic-tech issues event tail` |
| The web app (live)         | `GET /events/stream` (Server-Sent Events)                                                                     |
| Webhooks                   | outbound HTTP POSTs to subscribed URLs (see below)                                                            |

## Event shape

```json
{
  "seq": 1042,
  "id": "evt_01j…",
  "type": "issue.updated",
  "actorId": "usr_01j…",
  "actor": {
    "id": "usr_01j…",
    "handle": "claude",
    "name": "Claude",
    "kind": "agent",
    "avatarUrl": null
  },
  "projectId": "prj_01j…",
  "issueId": "iss_01j…",
  "data": {
    "issue": { "…full Issue snapshot after the change…": true },
    "changes": { "status": { "from": { "name": "Todo" }, "to": { "name": "In Progress" } } },
    "requestId": "req_…"
  },
  "createdAt": "2026-09-26T13:49:00.123Z"
}
```

- `seq` increases in commit order. Rolled-back transactions may leave gaps, but an event never appears _behind_ one you have already seen. Resume with `after=<last seq>`.
- `data` always holds the resource snapshot after the change, so consumers never need to refetch.
- `data.changes` holds `{ field: { from, to } }` for updates.
- `GET /events` and the live stream show each viewer only what they may see: readers below `write` on a project do not get events of trashed issues or deleted attachments (the live stream sends them content-free tombstones of the deletions instead), deleted comments arrive with an empty body, and trashed parents are cut out of snapshots and parent changes ([security.md](security.md#project-access)). Webhooks deliver the raw events.
- `data.requestId` identifies the API request that caused the change. The web app uses it to ignore echoes of its own writes.
- `data.reason` is the one-line reason the write was made with (`X-Change-Reason`, see [api.md](api.md#change-reasons)). It is absent when none was given. Agents always give one; the web activity view and `poietic-tech issues issue activity` show it.

| Type                                                                | `data`                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `issue.created`, `issue.updated`, `issue.deleted`, `issue.restored` | `{ issue, changes? }` (`issue.deleted` with `permanent: true` for hard deletes) |
| `comment.created`, `comment.updated`, `comment.deleted`             | `{ comment, issue: { id, key, title } }`                                        |
| `link.created`, `link.deleted`                                      | `{ link: { id, type, source, target } }`                                        |
| `attachment.created`, `attachment.deleted`                          | `{ attachment, issue: { id, key } }`                                            |
| `project.created`, `project.updated`                                | `{ project, changes? }`                                                         |
| `status.created`, `status.updated`, `status.deleted`                | `{ status, changes? }`                                                          |
| `label.created`, `label.updated`, `label.deleted`                   | `{ label, changes? }`                                                           |
| `user.created`, `user.updated`                                      | `{ user, changes? }`                                                            |

## Live stream (SSE)

`GET /api/v1/events/stream?project=ENG` returns `text/event-stream`:

```
id: 1042
event: issue.updated
data: {"seq":1042,"type":"issue.updated",…}
```

- The first message is `event: ready` (with the current `seq`). Comment lines (`: heartbeat`) keep proxies from timing out.
- **Resuming:** reconnect with `Last-Event-ID: <seq>` (browsers do this automatically) or `?after=<seq>`, and missed events are replayed. When more than 1000 events were missed, the server sends `event: reset` and the client should refetch.
- **Falling behind:** a connection holds at most 1,000 events waiting to be sent. One more and the server sends `event: reset` (with the newest `seq` as its id) and closes the stream; the client refetches and reconnects.
- **Deletions for readers:** readers below `write` on a project get `issue.deleted` and `attachment.deleted` as tombstones, live and on replay: `data` is only `{ "issue": { "id", "key" } }`, plus `"attachment": { "id" }` for an attachment, so open views can drop the row. `GET /events` and issue activity leave these events out for readers.
- **Losing access:** an event that ends the viewer's read access to a project still reaches them, without its content. The removal of their own membership arrives as `project.member_removed` with `data: { "member": { "user": { "id": <viewer> } } }`, and a project made private as `project.updated` with empty `data`. Nothing more about that project follows, and a `?project=` stream on it then ends (reconnecting to it is not found).
- **Account changes:** a `user.updated` event about the viewer is delivered (on a `?project=` stream too, which carries no other `user.*` events) and then the stream ends, because the viewer's role or status may have changed. The client reconnects as who they are now. Replay after a reconnect runs as that new identity, so it never ends the stream.
- **Authentication:** the session cookie (browsers) or `Authorization: Bearer` (scripts).
- **Proxies:** they must not buffer the response. The server sends `X-Accel-Buffering: no`. For nginx, also set `proxy_buffering off` on this location.

### How delivery works across processes

Each server process runs an `EventTailer` that follows the event log. It wakes:

1. immediately after local commits;
2. on Postgres `NOTIFY poietic_issues_events`, which is sent inside every event-writing transaction and so reaches replicas;
3. on a 300 ms poll, which also picks up writes from other processes on SQLite, such as the CLI in local mode.

So an operator who runs `poietic-issues-admin issue create` against the same database shows up on everyone's board within a fraction of a second, even without talking to the server.

### How the web app applies events

`apps/web/src/lib/live.svelte.ts`:

- It writes the snapshot into the issue cache.
- For every cached issue list, it applies the list's `IssueFilter` with `matchesFilter`, which has the same semantics as the server (proven by a property test), to insert, update or remove the issue, then re-sorts with the list's sort.
- Comments, links and reference data (statuses, labels, users) trigger targeted refetches.
- A `user.updated` event about the viewer refetches everything (their global role may have changed), and a membership event naming them also refetches issue lists and open issues.
- A tombstone (`issue.deleted` with only the id and key, which readers get) or a permanent delete removes the issue from cached lists and refetches its page. A project event without content (the viewer lost access) refetches everything, so the project's open pages show not found.

## Webhooks

Webhooks push events to other services. They are managed by admins: through the web app (**Workspace → Webhooks**), `poietic-tech issues webhook …`, or the API (`/webhooks`).

```sh
poietic-tech issues webhook create https://ci.example.com/hooks/tracker --events 'issue.*,comment.created' --scope ENG
poietic-tech issues webhook test whk_…          # sends a signed webhook.ping now
poietic-tech issues webhook deliveries whk_…    # the delivery log, newest first
poietic-tech issues webhook redeliver whd_…
```

**Subscriptions.**

- `eventTypes` takes event types, `<noun>.*` (e.g. `issue.*`) or `*`.
- A webhook can be scoped to one project.
- A webhook receives only events that happen after it is created. History is never replayed.

**Payload.** A webhook's `payload` is `full` (the default) or `notice`:

- `full` sends the whole event, as described below.
- `notice` sends only which event happened, never what it contains: `{ seq, id, type, projectId, issueId, actorId, createdAt }`, documented under `webhooks.notice` in the OpenAPI document. The receiver reads `GET /events` as itself to learn more, so the tracker's access rules still apply. This is how the bridge wakes agents without holding issue content. The test ping of a notice webhook is a notice too, with `seq` 0 and `type` `webhook.ping`.

```sh
poietic-tech issues webhook create https://bridge.poietic.tech/in/poietic-issues --payload notice --secret-stdin
```

**Secret.** The tracker generates each webhook's `whsec_` signing secret, unless the create call supplies one (`secret`, or `--secret-stdin` in the CLI). A receiver that issues its own secret, such as the bridge, needs that. A supplied secret must be `whsec_` and standard, padded base64 of 16 to 64 bytes, which is what strict verifiers decode. The secret is returned only by the create call (and by rotation, which always generates a new one).

**Request.** Each delivery is a `POST` with the event as the JSON body. The body has exactly the shape returned by `GET /events` and documented under `webhooks.event` in the OpenAPI document. Headers:

| Header                                   | Value                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `webhook-id`                             | The delivery id (`whd_…`). It is the same on every retry, so use it to deduplicate.                                          |
| `webhook-timestamp`                      | Unix seconds of this attempt                                                                                                 |
| `webhook-signature`                      | `v1,<base64 HMAC-SHA256>`                                                                                                    |
| `x-poietic-issues-event`                 | The event type, e.g. `issue.updated`                                                                                         |
| `x-poietic-issues-event-seq`             | The event's `seq`. Deliveries can arrive out of order; sort by it if order matters.                                          |
| `x-tracker-event`, `x-tracker-event-seq` | Deprecated pre-rename copies of the two above, sent for one more release ([ADR 0020](adr/0020-rename-to-poietic-issues.md)). |

### Verifying signatures

Signatures follow [Standard Webhooks](https://www.standardwebhooks.com), so any of its libraries works: `standardwebhooks` on npm, PyPI, Go, Ruby and others.

- **Signed content:** `{webhook-id}.{webhook-timestamp}.{raw body}`.
- **Key:** the base64-decoded part of the secret after `whsec_`.
- **Replays:** reject timestamps more than about 5 minutes from now.

By hand in Node:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, headers: Headers, rawBody: string): boolean {
  const id = headers.get('webhook-id')!;
  const ts = headers.get('webhook-timestamp')!;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();
  return headers
    .get('webhook-signature')!
    .split(' ')
    .some((sig) => {
      const given = Buffer.from(sig.split(',')[1] ?? '', 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

`verifyWebhook(secret, headers, body)` from `@poietic-tech/issues-core` does the same. Rotating the secret (`poietic-tech issues webhook rotate-secret`) takes effect on the next attempt.

### Retries and failure handling

Any 2xx response within 10 seconds counts as delivered. Everything else is retried:

- **Failures:** non-2xx responses, timeouts, connection errors and refused addresses.
- **Retry schedule:** after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours.
- **Giving up:** after 6 attempts in total the delivery is marked `dead`.
- **Auto-disable:** after 5 dead deliveries in a row the webhook is disabled. Re-enabling it (`poietic-tech issues webhook edit whk_… --enable`) resumes its queued deliveries.
- **Redelivery:** `redeliver` queues any delivery again with a fresh set of retries.

### How delivery works

- **Scheduling:** every server process with `POIETIC_ISSUES_WEBHOOKS=1` (the default) runs a webhook runner. The event tailer wakes it on new events, and a 5-second timer covers retries.
- **Fan-out:** the runner turns new events into `webhook_deliveries` rows, advancing a durable cursor (`system_state.webhook_cursor`) under the write lock. Concurrent replicas never skip or duplicate an event.
- **Sending:** due deliveries are claimed with a 60-second lease and sent outside any transaction. A crashed worker's claims simply expire.
- **CLI local mode** never sends webhooks itself. A server running against the same database picks up its events.

### Network safety (SSRF)

Webhook URLs are admin-supplied, but the server still refuses to call into its own network:

- **URLs:** `https` only, with no credentials in the URL.
- **Addresses:** every address a hostname resolves to must be public. Refused: loopback, RFC 1918, link-local (including cloud metadata at `169.254.169.254`), CGNAT, multicast and reserved ranges, and IPv4-mapped or NAT64 forms of those.
- **DNS pinning:** the connection is pinned to the address that was checked, so DNS rebinding cannot swap it.
- **Responses:** redirects are not followed. Responses are capped at 64 KB (2 KB is kept in the log).

`POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE=1` lifts the address checks and allows `http`, for local receivers during development. It defaults to on outside `NODE_ENV=production` and must stay off in production.
