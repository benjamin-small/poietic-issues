# 0033. Access decisions via @poietic-tech/access

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Project access (ADR 0021) was decided by hand-written level ordering, role mapping and error selection in `packages/core/src/access.ts`. poietic-dot-tech now publishes `@poietic-tech/access` (its ADR 0001) so that apps share one policy engine, and ADR 0031 layer 3 (group grants) needs it.

## Decision

`packages/core` depends on `@poietic-tech/access`. `access.ts` keeps its SQL and its error messages, but delegates the level ordering, the public floor and the outcome (not found, sign in, forbidden) to `issuesPolicy`. ADR 0021's access matrix is unchanged, and its tests pass unmodified. Group grants (ADR 0031 layer 3) follow in a later change.

**Update (2026-11-03).** `issuesPolicy` moved to `packages/schema` (`access.ts`), which is isomorphic, so the web app checks the same rules the server enforces. `packages/core` re-exports it. Nothing else in core or the web app restates the policy. The admin and system bypass asks it (`unrestricted()` resolves an empty scope to `top`). Global admin checks use its `adminRole` (`isAdminRole`). The web app's `canWrite`/`canManage` use its `atLeast`. Only the public floor's SQL (`visibility = 'public'` in `readableProjectIds`) restates a rule, because the library decides levels but doesn't build queries.

## Consequences

The ordering and the outcome rules live in one shared, conformance-tested place. The tracker takes on a runtime dependency that must be kept up to date. Behavior is unchanged, so rolling back means reverting `access.ts`.
