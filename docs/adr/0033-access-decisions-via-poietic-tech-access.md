# 0033. Access decisions via @poietic-tech/access

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Project access (ADR 0021) was decided by hand-written level ordering, role mapping and error selection in `packages/core/src/access.ts`. poietic-dot-tech now publishes `@poietic-tech/access` (its ADR 0001) so that apps share one policy engine, and ADR 0031 layer 3 (group grants) needs it.

## Decision

`packages/core` depends on `@poietic-tech/access`. `access.ts` keeps its SQL and its error messages, but delegates the level ordering, the public floor and the outcome (not found, sign in, forbidden) to `issuesPolicy`. ADR 0021's access matrix is unchanged, and its tests pass unmodified. Group grants (ADR 0031 layer 3) follow in a later change.

## Consequences

The ordering and the outcome rules live in one shared, conformance-tested place. The tracker takes on a runtime dependency that must be kept up to date. Behavior is unchanged, so rolling back means reverting `access.ts`.
