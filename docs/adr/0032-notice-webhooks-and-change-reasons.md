# 0032. Notice webhooks, change reasons and a published event follower

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

The persistent-agent pipeline pods poll `GET /events` every few seconds, about 100,000 requests a day while nothing happens, and each request wakes the tracker's sleeping container. They should instead react within seconds of a change and cost almost nothing at idle ([design](../superpowers/specs/2026-11-01-tracker-push-design.md)).

Poietic Bridge can push to listeners that connect out to it, but it keeps every payload forever and does not apply tracker permissions, so it must never hold issue content. Agents hand work to each other through the tracker, which is the audit trail, so every change needs to say why it was made, and a hand-off must be provable from something no project writer can forge.

## Decision

- **Notice payloads.** A webhook's `payload` is `full` (the default, unchanged) or `notice`. A notice carries only `{ seq, id, type, projectId, issueId, actorId, createdAt }`. A woken receiver reads `GET /events` as itself, so the tracker's access rules still decide what it sees. A notice webhook's test ping is a notice (`seq` 0, `type` `webhook.ping`).
- **Supplied secrets.** `POST /webhooks` accepts a `secret`, restricted to `whsec_` and standard, padded base64 of 16–64 bytes: what the bridge and other strict verifiers decode. It lets the bridge issue the secret for its terminal. Rotation still generates one, since the bridge changes a secret by recreating the terminal. The CLI reads a supplied secret from stdin and never prints it back.
- **Change reasons.** Any write may send `X-Change-Reason`: percent-encoded UTF-8, one line of at most 200 characters, stored on its events as `data.reason`. A malformed reason fails the write (400). It sits beside `X-Request-Id`, so no endpoint's body changes. Agents always send one, and explain bigger decisions in a comment.
- **A published client.** `@poietic-tech/issues-client` is published from `issues-client-v*` tags. Besides the generated API client it has `changes` and `follow` (read from a saved cursor, save only after the batch is handled, never poll on its own), typed events, `isOwnWrite`, `concerns`, `history`, `provenance` and `reasonHeaders`.
- **Provenance from the actor.** A hand-off is proven by the event that last set the fields (its `actorId` comes from the writer's verified identity), never by issue metadata alone.
- **One webhook for the bridge.** It covers `issue.*` and `comment.*` across all projects. No listener acts on links or attachments yet, and leaving them out keeps idle wake-ups down.

## Consequences

- The client is a public contract with its own version. Its follower and provenance rules change only through a release.
- Reasons are visible to everyone who can read the event, like the rest of it: they are not a private channel.
- A receiver of notices needs its own tracker identity to read events. That is the point, but it means one more account per listener.
- Bridge notices are best effort. A notice the tracker never delivered (retries exhausted, webhook disabled) is caught by each listener's reconciliation pass, not by the bridge.
- Escape hatch: setting the webhook back to `full`, or deleting it, returns listeners to polling with no tracker change.
