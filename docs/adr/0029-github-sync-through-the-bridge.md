# 0029. GitHub issues sync both ways, through Poietic Bridge

- **Status:** Accepted (tracker side amended 2026-11-10: woken by notices, no poll)
- **Date:** 2026-10-31

## Context

GitHub webhooks now reach poietic.tech through Poietic Bridge (`bridge.poietic.tech`): one verified, recorded,
ordered stream per terminal, which a listener follows through a named subscription with a saved position. Projects
already link repositories (`project.repos`, issue `repo`), but nothing kept GitHub issues and tracker issues in
step. persistent-agents has its own signed intake for one repository (`poietic-tech/persistent-agents` → PPA),
which records `poietic.github.url` on the issues it creates.

## Decision

- **A separate process, `apps/github-sync`, is a client of the public API.** It holds no database credentials and
  calls no `packages/core` code; it acts as its own auth.poietic.tech agent (`github-sync`), which must be a tracker
  admin (it creates projects) and a member of `bridge-admins` (terminal readers cannot be changed after creation).
  It runs on the local K3s cluster (`deploy/k3s/`), not in the issues.poietic.tech container, which sleeps when idle.
- **GitHub → tracker** reads `github.issues.*` and `github.issue_comment.*` from every `github` terminal it can see,
  through one subscription per terminal (`issues-sync`). Each event is handled against the issue as GitHub has it
  now (a REST read), so late or out-of-order deliveries never roll anything back.
- **Tracker → GitHub** reads `GET /events` from a saved cursor and writes through the GitHub REST API with a
  fine-grained token. Events the sync caused itself (its own actor id, `isOwnWrite`) are skipped.
  - _Amended 2026-11-10 ([ADR 0032](0032-notice-webhooks-and-change-reasons.md), PIB-3)._ It no longer polls every
    5 seconds. A second bridge listener, on the `poietic-issues` terminal with its own subscription (`github-sync`,
    types `issues.issue` and `issues.comment`), acknowledges each notice on receipt and wakes the shared `follow()`
    from `@poietic-tech/issues-client`; the tracker cursor stays the record of progress. Reconciliation reads the
    tracker at start, once the notice connection is back after more than 60 seconds down, and every 6 hours. Idle,
    the sync makes no tracker requests. Ready means the listener is connected (or reconnecting within its backoff)
    and the last read did not fail; live means no read has hung for 5 minutes. Every tracker write sends
    `X-Change-Reason` (`synced from GitHub issue owner/repo#12`).
- **Repositories map to projects** through `project.repos`; one project may hold several. A repository with no
  project gets a new one named after it in title case, with the repository's visibility (`poietic-bridge` →
  "Poietic Bridge", key `PB`, private); a project holding only that repository follows later visibility changes
  (`repository.publicized` / `privatized`). Webhooks come from one organization hook per GitHub owner. A tracker
  issue goes to GitHub only when its `repo` (or its project's only repo) is synced.
- **Synced fields:** title, body ↔ description, open/closed ↔ status category (closed completed ↔ completed, not
  planned/duplicate ↔ canceled, reopen → the first unstarted status), labels by name (created on demand), and
  comments with an attribution line. Deleting on GitHub trashes in the tracker; trashing in the tracker closes as
  not planned. Assignees are not synced: there is no mapping between GitHub and tracker users yet.
- **Loop prevention by snapshot.** The sync keeps, per linked pair, the fields both sides agreed on after the last
  sync. A change is a field that differs from that snapshot; it is written to the other side and the snapshot
  moves on, so the echo matches and does nothing. This does not depend on telling the sync's GitHub writes apart
  by sender, so a personal token works.
- **Links are recoverable.** State lives in a SQLite file (`node:sqlite`) on the pod's volume. Tracker issues carry
  `poietic.github.url` (the key persistent-agents already writes), GitHub bodies the sync writes end with an
  invisible `<!-- poietic-issues:<id> -->` marker, and mirrored comments carry a comment marker; so an empty store
  is rebuilt from the tracker, and a crash between a GitHub create and recording its link is adopted rather than
  duplicated. Tracker creates carry deterministic idempotency keys.
- **`poietic-tech/persistent-agents` is excluded by default** (`SYNC_EXCLUDE_REPOS`): its intake owns that flow.

## Consequences

- One replica only. Scaling out would need a lease; the work is a trickle and serialised anyway.
- A new subscription starts at the newest event, and a new tracker cursor at the newest tracker event: history
  from before the sync existed is not replayed. Existing GitHub issues appear once they next change.
- Conflicting edits to the same field on both sides within one sync interval resolve to whichever event is handled
  last. Edits to the sync's own mirrored comments are not propagated back.
- With a personal token, the sync's GitHub writes show as that person; a GitHub App would give it its own name.
