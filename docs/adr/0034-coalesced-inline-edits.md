# 0034. Inline issue edits are coalesced

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

Each inline property edit in the web app sent its own PATCH at once. A number input commits on every spinner click,
and a picker can be changed and changed back in a second, so each step became an event and an activity entry. Setting
an estimate and clearing it again left two entries for a change that never happened (PIB-1).

## Decision

- Inline edits to an issue's properties (status, priority, assignee, labels, repository, estimate, due date and custom
  fields) go through `editIssue` in `apps/web/src/lib/issues.ts`. It shows the change at once, as before.
- Edits to one issue within 500 ms of each other (`EDIT_DELAY_MS`) are merged into one PATCH. Each edit restarts the
  wait. Label adds and removes cancel each other.
- Before sending, the merged patch is compared with the issue as it was before the first of those edits. Fields back at
  their starting value are dropped. Nothing is sent if nothing is left.
- Sends for one issue run in order. A failure restores the issue as it was before the batch and shows the error toast.
  Pending edits are sent at once when the page is hidden.
- Title and description edits, board moves and bulk actions are already explicit commits and still call the API
  directly.

## Consequences

- A change and its undo within half a second record nothing, and a run of quick edits is one event.
- A save reaches the server, and other viewers, up to 500 ms later.
- The API is unchanged. Scripts and agents that PATCH twice still get two events: the coalescing is the web app's, not
  the server's.
