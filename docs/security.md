# Security model

## Identity and authentication

- **Actors.** Every actor is a user: `human`, `agent` or the internal `system`. Roles are `admin` and `member` (see [api.md](api.md#authentication) for what each can do). Give every automated worker its own `agent` user, so history, events and webhooks attribute its changes.
- **No API tokens.** The old per-user API tokens are retired ([ADR 0028](adr/0028-sso-only-and-the-poietic-tech-module.md)): migration `0007_drop_api_tokens` deletes them, and a bearer value that is not a verifiable identity token is answered 401. The only way to call the API from outside the server process is an auth.poietic.tech identity, as a person or an agent.
- **Browser sessions** come from `POST /auth/sso` (below) or, in dev mode, `POST /auth/dev-login`: a random cookie, stored hashed, valid for 30 days (dev-login sessions only; SSO sessions are short, see below), `HttpOnly`, `SameSite=Lax`, and `Secure` in production. `POST /auth/logout` deletes the session.
- **SSO sessions** (when `POIETIC_ISSUES_SSO_ISSUER` is set) come from `POST /auth/sso`, which verifies the issuer's JWT cookie (ES256, `iss`/`aud`/`exp`/`iat` claims) against the issuer's JWKS. The user's SSO role and groups determine initial access: matching `POIETIC_ISSUES_SSO_ADMIN_ROLE` creates the user as an active admin, membership of `POIETIC_ISSUES_SSO_MEMBER_GROUP` (when set) as an active member; anyone else is created deactivated (answered with the `PENDING_APPROVAL` error) until an admin approves them. Signing out of the SSO provider does not end the tracker session at once; it lapses within its short lifetime. Agent identities cannot get a session this way. With `POIETIC_ISSUES_SSO_LIVENESS_URL` set, the cookie's session must also still be live at the issuer (the same `GET /session/live` check as identity-token writes below, failing closed with 503), so a JWT that outlives a sign-out or a revoked session at the issuer cannot be traded for a new tracker session. Sessions from `POST /auth/sso` are short (`POIETIC_ISSUES_SSO_SESSION_MINUTES`, default 15) and the web app renews them while it is open by signing in again, re-checking the issuer each time; a renewal replaces the old session, and a refused one deletes it. A session ended at the issuer therefore ends here within one lifetime. Live event streams close when the session or identity token they authenticated with expires (ADR 0025).
- **SSO directory.** With `POIETIC_ISSUES_SSO_DIRECTORY_KEY` set, the server holds a read-only service key for the issuer's directory. It is a server-side secret, never sent to browsers or logged. Refreshes only update names and avatars and create approval-group members; they never change roles or activation (ADR 0027).
- **SSO identity tokens** (`Authorization: Bearer <token>`, SSO configured; without SSO every bearer value is a 401) are verified the same way on every request and carry no ambient credentials. A new agent is created owned by the user its `owner` claim maps to, and is refused if that owner has never signed in. It is active exactly when its owner is, and it stops while its owner is deactivated. Agents are always `member`s, whatever their role claim says. With `POIETIC_ISSUES_SSO_LIVENESS_URL` set, every request made with an identity token, reads included, first asks the issuer's `GET /session/live` (the token as `Authorization: Bearer`; answer `{ "live": boolean }`) and answers 401 when the session has ended. A live event stream opened with an identity token asks again before each delivery and heartbeat, and ends once the session has ended. Answers are cached per token for 30 seconds, so a revoked agent stops within about 30 seconds. The check fails closed: if the issuer can't be reached within 5 seconds or answers anything but a well-formed 200, the request gets 503 `UNAVAILABLE` (and a stream ends), as when its keys can't be fetched. Without the setting, a revoked agent keeps working until its current token expires (at most 10 minutes for poietic.tech). See ADR 0023.
- **CSRF.** Cookie-authenticated `POST`/`PATCH`/`PUT`/`DELETE` requests must come from the server's own origin or one listed in `POIETIC_ISSUES_ALLOWED_ORIGINS`. Bearer-token requests carry no ambient credentials and are exempt.
- **Credentials and anonymous access.** A request with no credentials, or with a stale, expired or unknown session cookie, is treated as anonymous: it can read public projects, and it gets 401 on anything that needs sign-in. A bearer token that is invalid, expired or revoked is different: the request fails with 401 at once and never falls back to anonymous.
- **Sign-in redirect.** The web app's `/login?next=` target is sanitised by `safeNext` (`apps/web/src/lib/safe-next.ts`): only same-origin paths starting with a single `/` are followed, and backslashes, control characters and anything that resolves to another origin become `/`. The sign-in page, the SSO return target and the "Continue without signing in" link all use the sanitised value.
- **Dev login.** `POIETIC_ISSUES_AUTH_MODE=dev` lets anyone sign in as any user, for local development only. The server refuses it when `NODE_ENV=production`.
- **Trusted mode** is the operator tool's local mode (`poietic-issues-admin`). It acts as a configured user without credentials, and only runs in-process: it can never be selected for a listening server. Anyone who can open the database file or connection can do this anyway.
- **First admin.** `poietic-issues-admin db bootstrap` creates it, and works only while no human admin exists.

## Project access

See [ADR 0021](adr/0021-project-visibility-and-roles.md).

- **Public projects are readable by anyone**, including visitors who are not signed in. That covers issues, comments, activity, attachment downloads and the live event stream. Make a project public only if everything in it, history included, may be seen by the whole internet. Webhooks are not affected.
- **Private projects return 404** (the same response as an unknown project) to everyone except their members, holders of a group grant and global admins. Errors, search and filter-name resolution never confirm that a hidden project, issue or name exists.
- **Group grants follow the groups the caller's credential carries.** A project can grant a role to an auth.poietic.tech group ([ADR 0031](adr/0031-global-identity-local-access.md)). A caller's level is the highest of their direct membership and the grants for those groups; a grant never lowers a direct role. A bearer (identity) token carries the groups it was issued with, and a cookie session the groups it was created with; the tracker stores no group membership. Two changes take effect at different times. Removing or changing a grant in the tracker takes effect on the next request, for every credential type, and open event streams re-read access. Removing someone from a group at auth.poietic.tech takes effect only when their token or session is renewed: a new access token re-reads groups only once the current one has expired (its lifetime is set at auth), and the new session then copies that token's groups for `POIETIC_ISSUES_SSO_SESSION_MINUTES` (default 15). A cookie session can therefore keep a removed group for about one access-token lifetime plus one session lifetime. An agent uses its own groups, never its owner's. The grant key is the group slug alone, so a grant follows the slug, not a particular group: if a group is deleted at auth.poietic.tech and a new group later takes the same slug, the new group inherits the old group's grants, and with them access to private projects. Before deleting a group at auth.poietic.tech, or reusing a slug, remove its grants with `poietic-tech issues members remove <project> --group <slug>`; to find them, run `members list` on each project. Only users with `manage` can set or remove grants.
- **Known limitation: assignee suggestions.** `GET /projects/{project}/schema/issue` and the assignee suggestions list only direct editors and managers (and admins). A user who can write only through a group grant is not suggested, because the tracker never learns who is in a group. They can still be assigned an issue.
- **Anonymous requests are `GET` and `HEAD` only.** Everything else needs sign-in and returns 401. `/me` answers `{ anonymous: true }`. `/users` and `/users/{user}` need sign-in.
- **Emails** are visible only to admins and to the user themself, including in `user.*` events. Anonymous readers see handles and names only where they are embedded in public resources, such as authors and assignees. The issue input schema (`GET /projects/{project}/schema/issue`) lists assignable handles only to signed-in callers, and only the users who can write the project.
- **Links** into projects the viewer cannot read, and the events that create them, are hidden. Creating or removing a link needs write access to one of its issues and read access to the other.
- **Deleted content needs write.** Trashed issues, deleted comments and the attachments of either are visible only to actors with `write` (or more) on the project. A deleted attachment is visible to nobody: no one can list or fetch it, and writers see only its events. Below `write`:
  - a trashed issue is not found (`NOT_FOUND`), whatever the request, and so are its comments, attachments, links and activity, including attempts to edit or delete them;
  - deleted comments and attachments of deleted comments are left out of lists, and fetching such an attachment is not found;
  - `includeDeleted` is silently ignored for projects the caller cannot write in, so one cross-project list can show trash in some projects and not in others;
  - a trashed parent is cut out of its children (`parent` and `parentId` are `null`);
  - restoring an issue makes its history visible again, because the rules follow the current state of each row.
- **The event log hides the same content.** `GET /events`, issue activity and the live stream apply these rules to readers below `write`, with the same result on replay and live:
  - events of a trashed issue are dropped, and so are link events with a trashed end;
  - events of a deleted attachment, or of one on a deleted comment, are dropped;
  - events of a deleted comment stay, with the body emptied;
  - snapshots cut a trashed parent. A parent change to a trashed issue, or from one to no parent, is left out of `changes`; a move from a trashed parent to a live one keeps the live end as `{ from: null, to }`.

  On the live stream, live and on replay, readers get `issue.deleted` and `attachment.deleted` as tombstones instead: only the issue's id and key and the attachment's id, so open views drop the row. `GET /events` and issue activity leave them out. These rules do not apply in projects the viewer can write in. Admins and webhooks (delivered as the system actor) see every event unchanged; other signed-in viewers, writers included, still have other users' emails hidden in `user.*` events and see link events only when both ends are visible to them.

- **Live streams follow access changes.** `GET /events/stream` re-reads the viewer's access when memberships or projects change. A `user.updated` event about the viewer, including their own edits, is delivered and then ends the stream, with or without `?project=`; the client refetches and reconnects with the new account state. Each connection holds at most 1,000 pending events: one more sends `reset` and closes it, and the client reconnects and refetches. Email-only `user.updated` events are not shown to other non-admin viewers. An event that ends the viewer's read access to a project (their membership removed, the project made private) is delivered without its content, so their open pages refetch and show not found, and a `?project=` stream on that project then closes. Connections with the same access share the stream's content lookups while they run, and keep nothing afterwards.
- **Open anonymous streams cost resources.** Anyone can open `GET /events/stream` on public projects without signing in. On issues.poietic.tech an open stream counts as activity, so a stream left open keeps the Cloudflare container awake and prevents it from sleeping ([deployment.md](deployment.md#cloudflare-containers-issuespoietictech)).
- **Admin-only endpoints** answer an anonymous request with 401 and a signed-in non-admin with 403.
- **Roles** (`viewer`, `editor`, `manager`) are per project. Global admins always have `manage`, and no guard stops the last manager from leaving.

## Attachments

Uploaded files are untrusted content served from the app's origin, so:

- **Type detection.** The media type comes from the file's bytes; the client's declared type is ignored. Markup (SVG, HTML) is stored as `text/plain`.
- **Inline display.** Only PNG, JPEG, GIF and WebP are served `inline`. Everything else downloads (`Content-Disposition: attachment`).
- **Response headers.** Every download carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
- **Filenames** are sanitized. Storage keys are random, so the filename never becomes a path.
- **Size.** `POIETIC_ISSUES_MAX_UPLOAD_MB` limits uploads, and the body is rejected while streaming.
- **S3 presigned URLs** expire after 5 minutes and come from a different origin than the app.

## Webhooks

- **Admins only.** Only admins can create webhooks.
- **All projects, private ones included.** A webhook with no project receives the events of every project, and no per-viewer filtering applies: deliveries carry the raw events (emails, deleted content, private projects). Give a webhook's URL only to receivers you trust with the whole tracker.
- **Signing.** Each delivery is signed with a per-webhook secret (Standard Webhooks, HMAC-SHA256). Receivers should verify the signature and reject old timestamps ([events.md](events.md#verifying-signatures)).
- **SSRF guard.** Outgoing requests are restricted:
  - `https` only;
  - every resolved address must be public, and the connection is pinned to it;
  - no redirects, a 10 s timeout, and a 64 KB response cap.

  `POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE` lifts this for development and is refused in production.

## Data handling

- **Timestamps** are UTC and generated by the application.
- **Deletes.** Issue and comment deletes are soft (restorable) unless an admin deletes permanently. Attachment deletes remove the stored bytes.
- **Event log.** The log keeps full snapshots of changed resources, so deleted content remains in history. Plan retention accordingly.
- **Secrets at rest.** Webhook secrets are stored in plain text (they are needed to sign), so protect database backups. Session secrets are only stored hashed. There are no stored API tokens.

## Reporting

This is an internal project. Report suspected vulnerabilities privately to the maintainers rather than in a public issue.
