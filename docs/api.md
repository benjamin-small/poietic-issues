# API guide

The REST API lives under `/api/v1`. The OpenAPI 3.1 document is the contract:

- **Committed:** [`docs/openapi.json`](openapi.json), regenerated with `pnpm openapi:gen`. CI fails if it is stale.
- **Served:** at `/api/v1/openapi.json`, with an interactive reference at **`/api/docs`**.
- **Consumed:** `@poietic-tech/issues-client`, and through it the web app and the CLI, is generated from the same document.

## Authentication

| Client               | How                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI, agents, scripts | `Authorization: Bearer <identity token>` from the SSO issuer (for poietic.tech, what `POIETIC_AGENT_TOKEN` is exchanged for), when the server is configured for SSO. Without SSO every bearer value is a 401 |
| Web app              | An HttpOnly session cookie from `POST /auth/sso` when configured for SSO, or `POST /auth/dev-login` when the server runs with `POIETIC_ISSUES_AUTH_MODE=dev`                                                 |

Every actor is a user. Create one `agent` user per automated worker (`POST /users` with `kind: "agent"`) so its changes are attributed in history, events and webhooks.

Roles: `admin` can manage users, webhooks, project creation and archiving, and permanent deletes, and has full access to every project. `member` acts on a project according to its role there (`viewer`, `editor` or `manager`) and sees private projects only as a member. Requests without credentials are allowed for `GET` and `HEAD` and read public projects only; anything else returns `UNAUTHENTICATED`. See [ADR 0021](adr/0021-project-visibility-and-roles.md).

A bearer value is always an identity token: with SSO configured it is verified against the issuer, and without SSO it is `UNAUTHENTICATED`. The retired API tokens get the same 401 ([ADR 0028](adr/0028-sso-only-and-the-poietic-tech-module.md)). The first request from a new agent creates a `kind: "agent"` member whose `ownerId` is its owner's user. The owner must have signed in before, and the agent is active exactly when the owner is. An agent cannot act while its owner is deactivated (`PENDING_APPROVAL`). An invalid bearer value is `UNAUTHENTICATED`, never a fallback to the session cookie. See [ADR 0023](adr/0023-agent-identities.md).

Cookie-authenticated `POST`/`PATCH`/`DELETE` requests must be same-origin (CSRF protection). Bearer requests are exempt.

## References

Path parameters and body fields accept ids or human references:

| Kind                             | Accepted                               |
| -------------------------------- | -------------------------------------- |
| Issue                            | `ENG-42` (case-insensitive) or `iss_…` |
| Project                          | `ENG` or `prj_…`                       |
| User                             | `ada`, `@ada`, `me` or `usr_…`         |
| Status, label (within a project) | name (case-insensitive) or id          |

## Lists and pagination

Lists return `{ "data": [...], "nextCursor": "…" | null }`. Pass `cursor=<nextCursor>` for the next page, and `limit` sets the page size (1–200, default 50). Cursors are opaque and tied to the sort order.

## Filtering issues

`GET /projects/{project}/issues` takes filters as query parameters:

| Form                  | Meaning                                                                    | Example                                                         |
| --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `field=a,b`           | any of (`eq` for one value)                                                | `status=Todo,In Progress`, `assignee=me,none`                   |
| `field.op=value`      | explicit operator                                                          | `priority.gte=2`, `dueDate.isNull=true`, `title.contains=crash` |
| `label=…`             | has any of these labels                                                    | `label=bug`                                                     |
| `cf.<key>=…`          | custom field                                                               | `cf.severity=high`, `cf.points.gte=3`                           |
| `q=…`                 | text in key, title, description                                            | `q=login`                                                       |
| `filter=<json>`       | a full `IssueFilter`, ANDed with the rest                                  |                                                                 |
| `sort=`               | comma-separated fields, `-` for descending                                 | `sort=-priority,updatedAt`                                      |
| `includeDeleted=true` | include trashed issues, in projects where you can write; ignored elsewhere |                                                                 |

- **Operators:** `eq neq in nin gt gte lt lte isNull contains`. `none` / `null` in a list means "empty".
- **Structured search:** `POST /issues/search` takes `{ project?, filter, sort, limit, cursor }`. Omit `project` to search every project.
- **Filter semantics:** conditions are ANDed. `in` gives OR within a field. Labels and multi-selects use "has" semantics.
- **Sortable fields:** `rank` (board order), `priority` (urgent first, none last), `createdAt`, `updatedAt`, `dueDate` and `estimate` (nulls last), `title`, `key`.

## Custom fields

Projects define typed fields with `POST /projects/{project}/fields`. The types are `text`, `number`, `date`, `boolean`, `select`, `multi_select`, `user` and `url`. `select` and `multi_select` fields also take `options`.

- **Setting values.** Issues carry values in `customFields`, keyed by field key:

  ```json
  {
    "customFields": {
      "severity": "high",
      "points": 3,
      "platforms": ["web", "ios"],
      "reviewer": "@ada"
    }
  }
  ```

  - Updates merge: only the fields you send change, and `null` clears one.
  - Select fields take option _values_.
  - User fields accept handles, `me` or ids. They are returned as ids.
  - Unset fields are omitted from responses.

- **Filtering.** Use `cf.<key>` in query strings (`cf.severity=high,critical`, `cf.points.gte=3`) and `cf:<key>` in `IssueFilter`.
- **Discovery.** `GET /projects/{project}/schema/issue` lists every field, with its options as enums.
- **Archiving.** Archiving a field or an option hides it without deleting stored values. Option values are immutable, while labels and colors can change.

## Attachments

Files belong to an issue (and optionally a comment on it).

- **Upload:** `POST /issues/{issue}/attachments` as `multipart/form-data` with a `file` part and an optional `commentId`. The limit is `POIETIC_ISSUES_MAX_UPLOAD_MB` (default 25); larger bodies get `413 PAYLOAD_TOO_LARGE`. The server detects the media type from the file's bytes and ignores the type the client declares.
- **Read:** `GET /issues/{issue}/attachments` lists them. `GET /attachments/{id}` returns metadata, including `sha256` and a `url`. `GET /attachments/{id}/content` returns the bytes.
- **Delete:** `DELETE /attachments/{id}` (the uploader or an admin). The row is soft-deleted and the stored bytes are removed.

Markdown can embed an attachment by its `url`, e.g. `![shot.png](/api/v1/attachments/att_…/content)`. The web editor does this for pasted and dropped files.

**Download safety.** Uploaded files are untrusted, so the content route never lets them run as part of the app:

- Only raster images (PNG, JPEG, GIF, WebP) are served `inline`. Everything else, SVG, HTML and PDF included, is served with `Content-Disposition: attachment`.
- Every response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
- Filenames are sanitized for the header (RFC 6266 `filename*`).

**Storage** is pluggable (`POIETIC_ISSUES_BLOB_STORE`):

| Setting           | Storage                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local` (default) | Files under `POIETIC_ISSUES_BLOB_DIR` (`./data/blobs`)                                                                                                                                       |
| `s3`              | Any S3-compatible store: `POIETIC_ISSUES_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE`. Downloads redirect to a short-lived presigned URL. |

Storage keys are random and never derived from the filename. Bytes are written before the database transaction and removed if it fails, so no network I/O happens inside a write transaction.

## Webhooks

Admins register webhooks with `POST /webhooks` (`url`, `eventTypes`, optional `project`). The response contains the signing `secret`, which is shown only once. `POST /webhooks/{id}/rotate-secret` issues a new one.

`POST /webhooks/{id}/test` sends a signed `webhook.ping` right away. `GET /webhooks/{id}/deliveries` is the delivery log, and `POST /webhook-deliveries/{id}/redeliver` retries a delivery.

The payload is documented in the OpenAPI document's `webhooks` section. Signatures, retries and network rules are covered in [events.md](events.md#webhooks).

## Errors

Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json` body:

```json
{
  "type": "urn:tracker:error:VALIDATION_FAILED",
  "title": "Validation failed",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "detail": "title: Too small: expected string to have >=1 characters",
  "errors": [{ "path": "title", "message": "Too small: expected string to have >=1 characters" }],
  "requestId": "req_01…"
}
```

`code` is stable and comes from a closed set (`packages/schema/src/errors.ts`):

| Code                      | HTTP | Meaning                                                                     |
| ------------------------- | ---- | --------------------------------------------------------------------------- |
| `VALIDATION_FAILED`       | 400  | Bad input; see `errors[]`                                                   |
| `UNAUTHENTICATED`         | 401  | Missing or invalid credentials                                              |
| `FORBIDDEN`               | 403  | Not allowed for this actor                                                  |
| `NOT_FOUND`               | 404  | Unknown issue, project, user, …                                             |
| `CONFLICT`                | 409  | Duplicate (key, name, link) or invalid state (e.g. editing a trashed issue) |
| `IDEMPOTENCY_IN_PROGRESS` | 409  | Same `Idempotency-Key` is still being processed                             |
| `VERSION_MISMATCH`        | 412  | `If-Match` / `expectedVersion` is stale                                     |
| `PAYLOAD_TOO_LARGE`       | 413  |                                                                             |
| `UNSUPPORTED_MEDIA_TYPE`  | 415  |                                                                             |
| `INVALID_RELATION`        | 422  | Self link, parent cycle, cross-project parent                               |
| `IDEMPOTENCY_KEY_REUSED`  | 422  | Same key, different request                                                 |
| `INTERNAL`                | 500  | Bug; report it with `requestId`                                             |

## Concurrency

Issues carry `version`, and responses include `ETag: "v<version>"`. Send `If-Match: "v<version>"`, or `expectedVersion` in the body, on `PATCH`, `DELETE` and `move` to fail with `412 VERSION_MISMATCH` instead of silently overwriting someone else's change. Omitting it means last-write-wins per field.

## Change reasons

Any write (`POST`, `PUT`, `PATCH`, `DELETE`) may carry a one-line reason, which is stored on the events it causes as `data.reason` ([events.md](events.md#event-shape)):

```http
X-Change-Reason: triaged%20as%20a%20bug%20%E2%80%94%20see%20ENG-12
```

- The value is percent-encoded UTF-8 (`encodeURIComponent`), because header values cannot hold non-ASCII text. Plain ASCII without `%` needs no encoding: `X-Change-Reason: triaged as a bug` works. A raw non-ASCII value (unencoded `café`) is refused rather than stored garbled.
- After decoding it must be one line (no control characters or line separators) of at most 200 characters. A malformed, multi-line or longer reason is refused with `400 VALIDATION_FAILED`, and nothing is changed. A blank reason is no reason.
- On reads the header is ignored.
- People may leave it out. Agents always send it, by convention; `reasonHeaders(reason)` in `@poietic-tech/issues-client` builds it. A bigger decision also gets a comment on the issue.

## Idempotency

`POST` requests accept `Idempotency-Key: <unique string>` (at most 255 characters, scoped to the actor, remembered for 24 hours):

- **Retry with the same body:** the original response is returned, with `Idempotent-Replayed: true`.
- **Reuse with a different body:** `422 IDEMPOTENCY_KEY_REUSED`.
- **Retry while the first request is still running:** `409 IDEMPOTENCY_IN_PROGRESS`.

The CLI sends a key on every mutation automatically.

## Board ordering

`POST /issues/{issue}/move` with `{ status?, afterId? | beforeId? | position: "top"|"bottom" }`. The server computes the ordering key. New issues go to the top of their column.

## Events

Every change is appended to the event log. Each event carries a full resource snapshot plus `changes` for updates.

- `GET /events?after=<seq>` pages through all events in commit order.
- `GET /issues/{issue}/activity` gives one issue's history, including comments and links.

`GET /events/stream` streams them live (Server-Sent Events). See [events.md](events.md) for the catalogue, live streaming and webhooks.

## Discovery for agents

`GET /projects/{project}/schema/issue` returns JSON Schemas for create and update with live enums: status names, label names, linked repos (`owner/name`), assignable user handles and custom fields. One call tells an agent every valid value.

The endpoint needs only read access, so it lists only the users who can be assigned: the project's editors and managers, plus admins. `me` is offered only to callers who can write the project. Anonymous readers of a public project get no user handles at all.
