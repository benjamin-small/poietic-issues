# Tracker events pushed to agents through the bridge

Date: 2026-11-01. Status: agreed. Rollout step 1 is poietic-tech/poietic-bridge#8; step 2 (tracker server and client) is in progress.

Repositories: `poietic-tech/poietic-issues` (this spec's home), `poietic-tech/poietic-bridge`, `poietic-tech/persistent-agents`.

## Why

Three mostly idle pipeline pods poll the tracker every 5 seconds. That is about 72 requests a minute, or roughly 100,000 a day. persistent-agents PR #6 caches the identity check and backs idle polling off to 30 seconds, which removes about 90% of it. That fix is still polling, though, and polling has two costs:

1. **It is slow.** An agent sees a change only on its next tick.
2. **It is expensive even when nothing happens.** The tracker's container sleeps after 30 idle minutes, and every request wakes it, so a 30-second poll keeps it running around the clock. GitHub sync adds its own 5-second poll of the same feed (ADR 0029).

The owner wants both things at once. Agents should react within a second or two of a change, and when nothing is happening they should cost almost nothing.

## Goals

- **Fast reaction.** An agent reacts within seconds of a tracker change that concerns it.
- **Near-zero idle traffic.** When nothing is happening, there is close to no traffic to the tracker or auth. The tracker container can sleep. A rough target is tracker requests in the low hundreds a day at idle, down from about 100,000.
- **The bridge is the only shared channel between agents.** No agent reads or writes another agent's database.
- **The tracker is the source of truth and the audit trail.** Every hand-off is a visible change on the issue, made under the acting agent's own identity, with a one-line reason.
- **A shared client for following events.** A published tracker client gives agents a robust way to learn what changed. Agents first, human review second.
- **GitHub sync moves onto the same push.**

## Non-goals

- **No new Cloudflare Tunnel, DNS record, Access application or ingress path into the cluster.** Listeners open their own connection to the bridge.
- **No outbound webhooks from the bridge.** That stays a non-goal in the bridge's own spec.
- **Intake keeps its GitHub path.** It still receives GitHub issue webhooks through the existing `agents.poietic.tech` Tunnel. Moving that onto the bridge's GitHub terminal is a possible later step, not part of this work. Two things about intake do change: its idle loop goes quiet, and it records the GitHub origin on the issue (section 5).
- **No acting on comments yet.** The coding agent records comments on its issues but does not act on them. Revising a PR or replying is a later design of its own, covering job keys, budget and authority.
- **The memory gateway is out of scope.** Its per-agent grants are a service with its own access control, like the bridge, so it does not count as shared private state.
- **No consumer groups or leader election.** Each listener has its own subscription.

## Anti-goals

These would make the work a failure even if it technically functions.

- **A push carries authority.** A bridge event is never the reason an agent acts. It only wakes the agent, which then reads the tracker as itself and acts on what the tracker says.
- **Issue content leaves the tracker's access control.** The bridge keeps everything forever and does not apply tracker permissions, so no issue title, body or snapshot may land in it.
- **Polling comes back under another name.** An idle loop that still renews tokens or checks identity every few minutes defeats the purpose.
- **Agents share private state.** No shared tables, and no agent reading another agent's rows.

## Design

```
tracker change ─► tracker webhook (notice only) ─► bridge terminal "poietic-issues"
                                                        │  (pushed over WebSockets the pods opened)
                          ┌─────────────────────────────┼──────────────────────────┐
                    project manager                coding agent                GitHub sync
                          │ wake → read /events from own cursor, as itself → act → advance own cursor
```

### 1. The tracker sends notices, not snapshots (poietic-issues)

- **A notice payload option for webhooks.** Today webhooks send the raw event, which includes the full snapshot. The new option, `payload: "notice"`, makes the body carry only `{ seq, id, type, projectId, issueId, actorId, createdAt }`.
- **The webhook can take a supplied secret.** `POST /webhooks` accepts an optional secret from the caller. Creating webhooks is already admin-only. This lets the tracker sign with the secret the bridge generated for the terminal (section 4). Without one, the tracker generates a secret as it does today.
- **Delivery is unchanged.** Signing (Standard Webhooks), retries, leasing and the auto-disable after 5 dead deliveries all work exactly as they do now.
- **Full payloads stay the default**, so existing webhooks are untouched.
- **One webhook feeds the bridge:** all projects, with an event-type glob covering at least `issue.*` and `comment.*`. Builder: decide whether `link.*` and `attachment.*` are useful to listeners now.
- **The container can still sleep.** A tracker change is itself a request, so the container is awake when the notice goes out. Retries that fall due while it sleeps go out the next time it wakes, and reconciliation (section 5) covers the gap.

### 2. The tracker records a reason on every change (poietic-issues)

- **A reason travels with the write.** Any mutating request may carry a one-line reason. My call: an `X-Change-Reason` header, at most 200 characters. It sits beside the existing `X-Request-Id`, so every endpoint accepts it without its body schema changing.
- **It is stored on the event** as `data.reason`. It appears in `GET /events`, in `GET /issues/{issue}/activity`, in the web activity view, and in the CLI.
- **It is optional for people.** Agents always send it, by convention, and the shared client makes that easy.
- **Bigger decisions go in comments.** When an agent makes a larger call, it explains it in a comment on the issue, posted under its own identity, in addition to the one-line reason.

### 3. A published client with an event follower (poietic-issues)

- **Publish `@poietic-tech/issues-client`** the same way as `@poietic-tech/bridge`. It is private today.
- **Add the follower API next to the generated client.** Builder: final names. In TypeScript terms it needs:
  - `changes({ after, projects?, types?, limit? })`. Reads `/events` pages in order and returns `{ events, through }`, where `through` is the cursor to save. It handles the case where `nextCursor` is null on the last page by taking the last `seq` itself, and it rejects a cursor that does not move forward.
  - `follow({ cursor: { load, save }, wake?, onBatch })`. Loops `changes()`. It calls `onBatch` and saves `through` only after `onBatch` resolves, so a crash means reading a batch again, never skipping one. `wake` is any signal source (the bridge listener). Without one, it runs only when called. It never polls on its own.
  - **Typed events.** A union of the event types with `changes` typed per field (`{ from, to }`), plus `actor`, `requestId` and `reason`.
  - **Helpers.** `isOwnWrite(event, me)` matches the actor id or a request id the caller generated, so an agent does not wake itself up. `concerns(event, me)` checks whether the event is assigned to me, newly assigned to me, in one of my projects, or a comment on an issue assigned to me. Each issue's events can be grouped and returned in order.
  - `history(issue)`. The issue's activity in order, with reasons, for review by people and for an agent that wants context.
  - **Writes take an optional `reason`,** which the client sends as `X-Change-Reason`.
- **The bridge part is a thin adapter.** It belongs either here or in persistent-agents, not in the bridge SDK. It connects a bridge subscription to `follow()`'s `wake`, and it acknowledges each bridge event straight away. The bridge position only tracks wake-ups; what each agent has handled is tracked by its own tracker cursor.

### 4. The bridge accepts tracker notices (poietic-bridge)

- **A new adapter** next to `adapters/github.ts`, for Standard Webhooks signatures. It verifies `webhook-signature` (an HMAC-SHA256 over `webhook-id.webhook-timestamp.body`) in constant time.
  - It rejects a timestamp outside a tolerance window. Builder's call: 5 minutes, the Standard Webhooks default.
  - It uses `webhook-id` as the delivery id, so a retried delivery is deduplicated.
  - The event type becomes `issues.<tracker type>`, e.g. `issues.issue.updated`. Listeners can then filter on `issues.issue` and `issues.comment`.
- **Size cap.** The adapter rejects bodies over a few KiB. That is a safety net, so a misconfigured full-payload webhook fails loudly and does not quietly store snapshots.
- **One terminal, `poietic-issues`,** with this adapter, created at runtime.
  - Readers: one group that holds the listening agents. Bridge readers groups cannot change after a terminal is created, so choose this group deliberately. Builder: confirm the group name with the owner before creating the terminal.
  - Writers: none.
  - Retention: the default 30 days is ample.
- **The shared secret.** The bridge generates it when the terminal is created and shows it once. It goes straight into the tracker's `POST /webhooks` as the supplied secret (section 1), and it is never printed or committed. The adapter verifies against those secret bytes. Builder: settle how the tracker encodes a supplied secret (for example, wrapping it as `whsec_<base64>`) so both sides agree, with a test on each side.

### 5. Agents listen, read and act as themselves (persistent-agents, and GitHub sync in poietic-issues)

Each role keeps one long-lived listener.

1. At start, it runs `follow()` once. This is the reconciliation pass. It then connects `bridge.listen("poietic-issues", { subscription: "<role>", types: [...] })` using its own agent identity.
2. Each pushed notice triggers `follow()`, which reads the tracker as that agent from its own cursor.

**Who reacts to what:**

| Role            | Subscribes to                    | Acts on                                                                                                                                                   |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project manager | `issues.issue`                   | new issues in its projects (triage, as today)                                                                                                             |
| Coding agent    | `issues.issue`, `issues.comment` | an issue newly assigned to it, with a hand-off it can prove (below); a comment on one of its issues is only recorded in its own store, with no action yet |
| GitHub sync     | `issues` (the types it syncs)    | what it syncs today, through its existing tracker cursor                                                                                                  |

Intake does not subscribe.

**Hand-offs go through the tracker.**

- The manager already sets the assignee and `poietic.pm.assignment` on the issue.
- The coding agent now learns about that assignment from the tracker event, not from `pipeline_assignments`.
- `codingInbox()` and `recordAssignment` as a channel between agents are removed. The coding agent's inbox is a table it alone writes, filled from its own follower.
- Each role's database login can read and write only that role's own tables. The shared `persistent_agents` database may stay, but no table is shared between roles. Builder: whether separate schemas or separate databases enforce this.

**A hand-off is proven from the tracker's log.**

- Today the coding agent trusts `poietic.pm.assignment` because it matches a `pipeline_assignments` row that only the manager can insert. Issue metadata alone can be edited by any project writer, so once that table is gone, the metadata proves nothing.
- Instead, the coding agent accepts a hand-off only when the event that last set the assignee to itself, and `poietic.pm.assignment` to its current value, has `actorId` equal to the manager's tracker user, and no later event changed either field.
- The tracker sets `actorId` from the verified identity token, so it cannot be forged.
- The shared client offers this as `provenance(issue, fields)`, which returns the event that last set those fields.
- Builder: test a forged metadata edit by another writer, and a later edit by a person.

**The GitHub origin moves onto the issue.** This replaces the manager's read of intake's `pipeline_origins` table.

- Intake writes the origin as metadata (`poietic.intake.origin`) in the same call that creates the tracker issue.
- The manager trusts that origin only when the actor of the issue's creating event is intake's tracker user.
- The manager no longer reads intake's tables, and triage's `origin_receipt_pending` wait goes away.

**Idle means idle, for every role including intake.**

- Between wake-ups, a role does nothing that reaches the tracker.
- `tracker.verify()` and the token exchange run only when the role is about to act, never on an idle tick.
- The local job loop (lease claims in its own database) can keep its timer, because it is in the cluster and free. It must not call the tracker.

**Reconciliation is a safety net, not a heartbeat.** `follow()` also runs:

- at start;
- after the bridge connection has been down for more than 60 seconds;
- every 6 hours.

These are my calls. 6 hours wakes the container at most 4 times a day. The bridge itself replays notices a subscription missed, so reconciliation only covers a notice the tracker never managed to deliver to the bridge.

**Background traffic to auth is accepted.** Each listener exchanges a token with auth about 24 times a day, because the bridge closes every socket after an hour to force re-authentication. GitHub sync's terminal discovery, every 5 minutes, also needs fresh tokens. Together that is a few hundred requests a day. They go to auth, a Worker, not to the tracker container, so the container can still sleep.

**Readiness.** Readiness today needs a tick within 60 seconds. It becomes: the listener is connected, or is reconnecting within its backoff, and the last `follow()` did not fail.

**Exactly once.** Bridge delivery is at least once and may repeat. Exactly-once handling comes from the existing pieces:

- the tracker cursor, which each role saves in the same transaction as its inbox insert (as `ingestEvents` does today);
- per-issue job keys;
- the manager's saved intents and `If-Match` versions.

A repeated or out-of-order notice just triggers a read that finds nothing new.

**GitHub sync.**

- It already holds a bridge connection for GitHub events. It adds a second listener on `poietic-issues`, hooked up to its existing tracker cursor.
- It drops the 5-second `SYNC_TRACKER_POLL_MS` loop, keeping the reconciliation schedule above.
- It moves to `follow()` from the shared client.

### 6. Operations (no infrastructure-as-code change)

Nothing changes in poietic-dot-tech. There is no Tunnel, DNS, Access or Worker binding change; the bridge terminal and subscriptions are runtime data. One-time steps, run by the owner or an admin agent, in order:

1. Create the readers group and add each listening agent to it.
2. Create the `poietic-issues` terminal with the shared secret.
3. Create the tracker webhook: notice payload, URL `https://bridge.poietic.tech/in/poietic-issues`, same secret.
4. Deploy the listeners.

The runbook is in [deployment.md](../../deployment.md#pushing-tracker-events-to-agents-through-the-bridge).

## Rollout

Each step is safe on its own. PR #6's 30-second backoff stays in place until step 4.

1. **poietic-bridge:** the Standard Webhooks adapter.
2. **poietic-issues, server and client:** notice payloads, supplied webhook secrets, `X-Change-Reason`, `data.reason` in events and activity, and the published client with the follower. Plus the runbook.
3. **Operations:** the terminal, the webhook and the group. Then check that notices appear on the terminal (`poietic-tech bridge` CLI).
4. **persistent-agents:** listeners per role, hand-offs read from the tracker, private per-role state, hand-off provenance from the tracker's log, intake's origin on the issue, verify-only-before-acting in every role including intake, comments recorded only, and reasons on every write. Switch to the shared client and delete `packages/integrations/poietic-issues/client.ts`'s polling paths.
5. **poietic-issues, GitHub sync:** listener plus the shared client, and drop the 5-second poll.

Steps 4 and 5 are independent once 2 and 3 are done.

## Success check

After rollout, with the pipeline idle for 24 hours:

- tracker requests that day are in the low hundreds;
- the tracker container spent most of the day asleep;
- creating an issue gets it triaged within a few seconds;
- assigning it gets the coding agent started within a few seconds.

Probe production, not only the tests.

## Calls made in this draft (for owner review)

- The `X-Change-Reason` header, capped at 200 characters.
- Reconciliation at start, after a bridge outage of more than 60 seconds, and every 6 hours.
- The `issues.<type>` naming for bridge events and the `poietic-issues` terminal name.
- A size cap on the bridge adapter to block full payloads.
- The bridge position acknowledged on receipt; the tracker cursor is the real progress record.
- Hand-off provenance proven from the event's actor, not from metadata or a shared table.
- The GitHub origin recorded on the issue by intake, and trusted by the actor of the creating event.
- The bridge generates the webhook secret, and the tracker accepts it as a supplied secret.
- Hourly re-authentication and GitHub sync's discovery traffic to auth accepted.
- The memory gateway out of scope for "no shared private state".

Decided by the owner: comments are recorded only, for now.
