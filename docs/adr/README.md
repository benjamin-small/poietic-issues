# Architecture decision records

Short records of decisions that constrain future work. Copy `0000-template.md`, take the next number, and keep it brief. Superseded ADRs stay in place with their status updated.

| #                                                     | Decision                                                               | Status                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| [0001](0001-monorepo-layout.md)                       | pnpm monorepo with source-exported internal packages                   | Accepted                                  |
| [0002](0002-dual-dialect-kysely.md)                   | One Kysely codebase for SQLite and Postgres; STRICT SQLite             | Accepted                                  |
| [0003](0003-write-transactions.md)                    | All writes through `withWriteTx` (BEGIN IMMEDIATE / advisory lock)     | Accepted                                  |
| [0004](0004-event-log-bus-and-outbox.md)              | The events table is the bus and the outbox                             | Accepted                                  |
| [0006](0006-typeids-and-issue-keys.md)                | TypeID identifiers plus immutable issue keys                           | Accepted                                  |
| [0007](0007-eav-custom-fields.md)                     | Custom field values as typed EAV rows                                  | Accepted                                  |
| [0008](0008-fractional-ranks.md)                      | Fractional-index ranks with server-computed moves                      | Accepted                                  |
| [0010](0010-filter-language-and-field-registry.md)    | `IssueFilter` + field registry as the extension spine                  | Accepted                                  |
| [0005](0005-api-as-contract.md)                       | The HTTP API is the contract; CLI local mode runs it in-process        | Accepted                                  |
| [0009](0009-auth-v1.md)                               | Auth v1: actors, API tokens and cookie sessions                        | Accepted                                  |
| [0011](0011-committed-openapi.md)                     | OpenAPI generated from code and committed                              | Accepted                                  |
| [0012](0012-blob-storage.md)                          | Attachment bytes in a pluggable blob store (local disk or S3)          | Accepted                                  |
| [0013](0013-webhook-delivery.md)                      | Webhooks delivered from the event log with durable, leased deliveries  | Accepted                                  |
| [0014](0014-packaging.md)                             | One bundled process per deployment, structured logs, graceful shutdown | Accepted                                  |
| [0015](0015-browser-demo.md)                          | A self-contained browser demo built from the real code                 | Accepted                                  |
| [0016](0016-keyboard-and-command-layer.md)            | One keyboard, selection and command layer for the web app              | Accepted                                  |
| [0017](0017-shared-controls.md)                       | Shared controls instead of native form widgets                         | Accepted                                  |
| [0018](0018-sso-via-shared-cookie-jwt.md)             | SSO via a parent-domain cookie JWT                                     | Accepted (verifier superseded by 0022)    |
| [0019](0019-cloudflare-containers-with-litestream.md) | Cloudflare Containers with Litestream for issues.poietic.tech          | Accepted                                  |
| [0020](0020-rename-to-poietic-issues.md)              | Rename to poietic-issues                                               | Accepted                                  |
| [0021](0021-project-visibility-and-roles.md)          | Project visibility, per-project roles and anonymous read access        | Accepted                                  |
| [0022](0022-poietic-auth-package-verifier.md)         | Verify SSO tokens with `@poietic-tech/auth`                            | Accepted                                  |
| [0023](0023-agent-identities.md)                      | Agent identities from SSO identity tokens                              | Accepted (`trk_` part superseded by 0028) |
| [0024](0024-showing-agents-and-owners.md)             | Showing agents and their owners                                        | Accepted                                  |
| [0025](0025-short-renewed-sso-sessions.md)            | Short, renewed SSO sessions                                            | Accepted                                  |
| [0026](0026-sso-member-group.md)                      | Approve SSO users by group                                             | Accepted                                  |
| [0027](0027-sso-directory.md)                         | The SSO directory owns who people are                                  | Accepted                                  |
| [0028](0028-sso-only-and-the-poietic-tech-module.md)  | SSO only, and the CLI as a `poietic-tech` module                       | Accepted                                  |
| [0029](0029-github-sync-through-the-bridge.md)        | GitHub issues sync both ways, through Poietic Bridge                   | Accepted                                  |
| [0030](0030-renaming-handles.md)                      | Admins can rename handles                                              | Accepted                                  |
| [0031](0031-global-identity-local-access.md)          | Identity is global; access is layered                                  | Accepted (steps 3–4 to do)                |
| [0032](0032-notice-webhooks-and-change-reasons.md)    | Notice webhooks, change reasons and a published event follower         | Accepted                                  |
