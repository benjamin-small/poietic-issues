# Deployment

The tracker ships as **one process**: the HTTP API, the web app and the webhook worker. It runs on Postgres (SQLite also works for a single small instance) with attachments on local disk or any S3-compatible store.

## Quick start with Docker Compose

`docker-compose.yml` runs the production shape: tracker, Postgres 16 and SeaweedFS for S3 storage.

```sh
docker compose up -d --build --wait poietic-issues
docker compose exec poietic-issues poietic-issues-admin db bootstrap --handle you --name "Your Name"
```

`bootstrap` creates the first admin user and mints no credential. This stack has **no SSO and no dev login**, so that admin cannot sign in to the web UI at http://localhost:3000, and nothing can call its API from outside the container: every bearer value is a 401 without SSO. The compose stack is for trying the image and for operator tasks. Run those with `poietic-issues-admin` inside the container, which works on the container's database in trusted mode:

```sh
docker compose exec poietic-issues poietic-issues-admin project create -k ENG --name Engineering
docker compose exec poietic-issues poietic-issues-admin user create --handle claude --name Claude --kind agent
docker compose exec poietic-issues poietic-issues-admin issue list -P ENG
```

For a working sign-in, run the stack with SSO configured (see [Single sign-on](#single-sign-on)), or develop with `pnpm dev`, whose dev auth mode signs in as any seeded user.

The compose file is a starting point, not a hardened production setup: it uses fixed passwords and plain HTTP. Put TLS in front of it (see [Reverse proxy](#reverse-proxy)) and change the credentials.

## The image

`docker build -t tracker .` produces a Node 22 slim image. It contains:

- `dist/server.mjs` and `dist/poietic-issues-admin.mjs`: single-file bundles made by `pnpm build` ([ADR 0014](adr/0014-packaging.md)).
- `web/`: the built SPA.
- The native SQLite driver.

The image runs as the `node` user, keeps state in `/data` (a volume), listens on port 3000, and has a `HEALTHCHECK` on `/readyz`. The operator tool `poietic-issues-admin` is on the `PATH`, so admin tasks run with `docker exec … tracker poietic-issues-admin …` in local mode against the same database. The published `poietic-tech issues` module is not in the image.

Its defaults:

| Setting                       | Value                     |
| ----------------------------- | ------------------------- |
| `NODE_ENV`                    | `production`              |
| `POIETIC_ISSUES_DATABASE_URL` | `sqlite:/data/tracker.db` |
| `POIETIC_ISSUES_BLOB_DIR`     | `/data/blobs`             |
| `POIETIC_ISSUES_AUTO_MIGRATE` | `1`                       |

Point `POIETIC_ISSUES_DATABASE_URL` at Postgres for anything beyond a single small instance.

Without Docker: `pnpm install && pnpm build`, then run `node dist/server.mjs` with `POIETIC_ISSUES_WEB_DIR=apps/web/build`. The bundles need only `better-sqlite3` from `node_modules`.

## Configuration

All settings are environment variables, validated at startup. An invalid value stops the process with a list of the problems. Defaults depend on `NODE_ENV`: development defaults (left) favour convenience, production defaults (right) favour safety.

| Variable                                                                        | Default (dev / production)      | Meaning                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POIETIC_ISSUES_DATABASE_URL`                                                   | `sqlite:./data/dev.db`          | `postgres://user:pass@host:5432/db` or `sqlite:/path/file.db`.                                                                                                                                                    |
| `POIETIC_ISSUES_HOST` / `POIETIC_ISSUES_PORT`                                   | `127.0.0.1` / `0.0.0.0`; `3000` | Listen address.                                                                                                                                                                                                   |
| `POIETIC_ISSUES_AUTH_MODE`                                                      | `dev` / `standard`              | `dev` adds a user picker to the sign-in page (anyone can act as anyone). Refused in production.                                                                                                                   |
| `POIETIC_ISSUES_AUTO_MIGRATE`                                                   | `1` / `0` (`1` in the image)    | Apply pending migrations at startup. Otherwise the server refuses to start until `poietic-issues-admin db migrate` has run.                                                                                       |
| `POIETIC_ISSUES_SEED`                                                           | `1` / `0`                       | Seed demo users and projects into an empty database.                                                                                                                                                              |
| `POIETIC_ISSUES_WEB_DIR`                                                        | —                               | Directory of the built web app to serve at `/`.                                                                                                                                                                   |
| `POIETIC_ISSUES_SECURE_COOKIES`                                                 | `0` / `1`                       | `Secure` session cookies (requires HTTPS).                                                                                                                                                                        |
| `POIETIC_ISSUES_ALLOWED_ORIGINS`                                                | —                               | Extra origins, comma-separated, that may send cookie-authenticated writes (CSRF allow-list).                                                                                                                      |
| `POIETIC_ISSUES_BLOB_STORE`                                                     | `local`                         | `local` or `s3`.                                                                                                                                                                                                  |
| `POIETIC_ISSUES_BLOB_DIR`                                                       | `./data/blobs`                  | Attachment directory for `local`.                                                                                                                                                                                 |
| `POIETIC_ISSUES_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | —                               | Required for `s3`. `POIETIC_ISSUES_S3_REGION` defaults to `us-east-1`.                                                                                                                                            |
| `POIETIC_ISSUES_S3_FORCE_PATH_STYLE`                                            | `true`                          | `endpoint/bucket/key` URLs. Set `false` for virtual-hosted buckets.                                                                                                                                               |
| `POIETIC_ISSUES_S3_PRESIGN`                                                     | `true`                          | Downloads redirect to presigned URLs. Set `0` to stream through the server when browsers can't reach the store.                                                                                                   |
| `POIETIC_ISSUES_S3_PUBLIC_ENDPOINT`                                             | —                               | Browser-facing endpoint for presigned URLs, if it differs from `POIETIC_ISSUES_S3_ENDPOINT`.                                                                                                                      |
| `POIETIC_ISSUES_MAX_UPLOAD_MB`                                                  | `25`                            | Attachment size limit.                                                                                                                                                                                            |
| `POIETIC_ISSUES_WEBHOOKS`                                                       | `1`                             | Run the webhook worker in this process.                                                                                                                                                                           |
| `POIETIC_ISSUES_WEBHOOK_ALLOW_PRIVATE`                                          | `1` / `0`                       | Allow webhooks to use `http` and private addresses. Refused in production.                                                                                                                                        |
| `POIETIC_ISSUES_LOG_LEVEL`                                                      | `info`                          | `trace` … `fatal`, or `silent`.                                                                                                                                                                                   |
| `POIETIC_ISSUES_LOG_FORMAT`                                                     | `pretty` / `json`               | JSON lines for log collectors, or compact human-readable lines.                                                                                                                                                   |
| `POIETIC_ISSUES_SHUTDOWN_TIMEOUT_MS`                                            | `10000`                         | How long shutdown waits for in-flight requests.                                                                                                                                                                   |
| `POIETIC_ISSUES_SSO_ISSUER`                                                     | —                               | The JWT issuer URL; set this to enable SSO. When set, also set `POIETIC_ISSUES_SSO_COOKIE`, `_AUDIENCE`, `_JWKS_URL`, `_LOGIN_URL`.                                                                               |
| `POIETIC_ISSUES_SSO_NAME`                                                       | issuer's hostname               | Display name for the SSO provider (e.g., `Example SSO`).                                                                                                                                                          |
| `POIETIC_ISSUES_SSO_COOKIE`                                                     | —                               | Name of the JWT cookie sent by the issuer (e.g., `__Secure-example-session`).                                                                                                                                     |
| `POIETIC_ISSUES_SSO_AUDIENCE`                                                   | —                               | The JWT `aud` claim this tracker expects.                                                                                                                                                                         |
| `POIETIC_ISSUES_SSO_JWKS_URL`                                                   | —                               | The issuer's public key set endpoint.                                                                                                                                                                             |
| `POIETIC_ISSUES_SSO_LOGIN_URL`                                                  | —                               | Where to send the user to sign in; append `redirect=<return URL>`.                                                                                                                                                |
| `POIETIC_ISSUES_SSO_REFRESH_URL`                                                | —                               | Optional: call this before sign-in to renew a lapsed cookie.                                                                                                                                                      |
| `POIETIC_ISSUES_SSO_ADMIN_ROLE`                                                 | `admin`                         | JWT role claim that makes new users admin. Anyone else starts deactivated and must be approved.                                                                                                                   |
| `POIETIC_ISSUES_SSO_MEMBER_GROUP`                                               | —                               | Issuer group whose members are created as active members on first sign-in. Unset: everyone who isn't admin waits for approval.                                                                                    |
| `POIETIC_ISSUES_SSO_DIRECTORY_KEY`                                              | —                               | Service key (`ptk_…`) for the issuer's directory API. Set: listing users refreshes names, handles and avatars from it and adds member-group people who have never signed in. A secret: never in a browser bundle. |
| `POIETIC_ISSUES_SSO_DIRECTORY_URL`                                              | the issuer's origin             | Origin of the directory API.                                                                                                                                                                                      |
| `POIETIC_ISSUES_SSO_LIVENESS_URL`                                               | —                               | Optional: the issuer's `/session/live`. Checked on identity-token requests and SSO sign-in.                                                                                                                       |
| `POIETIC_ISSUES_SSO_SESSION_MINUTES`                                            | `15`                            | Lifetime of a session from SSO sign-in (2–1440); the web app renews it.                                                                                                                                           |

## Database and migrations

- **Postgres 14+** is the production database. The server needs a normal user that owns its schema. Timestamps are `timestamptz`, and all times are UTC.
- **Migrations** are files compiled into the bundle. They run at startup when `POIETIC_ISSUES_AUTO_MIGRATE=1`. Kysely's migrator takes a lock, so replicas starting together are safe.
- **Explicit migrations.** To run migrations as a separate release step instead, set `POIETIC_ISSUES_AUTO_MIGRATE=0` and run `poietic-issues-admin db migrate` with `POIETIC_ISSUES_DATABASE_URL` set, e.g. `docker run --rm -e POIETIC_ISSUES_DATABASE_URL=… tracker poietic-issues-admin db migrate`.
- **Status.** `poietic-issues-admin db status` shows applied and pending migrations.
- **Back up before upgrading.** Once a release's migrations have run, older releases that migrate at startup (`POIETIC_ISSUES_AUTO_MIGRATE=1`, the image default) cannot start on that database: the migrator stops with `corrupted migrations: previously executed migration <name> is missing`. With `POIETIC_ISSUES_AUTO_MIGRATE=0` an older release does start, against a schema it doesn't know; that is unsupported. Take a backup (below) before deploying a release that adds a migration, and check that it opens with `poietic-issues-admin db status --database <url-of-the-copy>`.
- **Rolling back.** Prefer fixing forward. To run the previous release again, its database must not have the newer migrations. Either restore the pre-upgrade backup, losing every write since, or revert the schema in place:
  1. Stop the server.
  2. With the **new** release's CLI, run `poietic-issues-admin db migrate --down` once per migration to undo. Each run reverts the newest applied migration; older releases don't know the migration, so they can't revert it. It never reverts the first migration, and it refuses a SQLite path with no database file. Check with `poietic-issues-admin db status`: the reverted migrations are listed under `Pending`.
  3. Start the previous release.

  Reverting drops whatever the migration added. Reverting 0004 drops project visibility, memberships, linked repos and issues' repo links; migrating forward again re-runs its backfill (every project private, every active non-admin an editor).

- **Upgrading to project visibility (migration 0004).** Existing projects stay `private`, and every active user who is not an admin or the `system` user becomes an `editor` of every existing project, so nobody loses access. Admins need no membership. Users and agents created afterwards start with none: add them to a project to give them access. So do users who are deactivated when the migration runs, including SSO sign-ins still waiting for approval: after an admin activates them, they see only public projects until someone adds them to a project. Projects set to `public` are readable without signing in; see [security.md](security.md#project-access). The backfill is stamped with the time the migration runs.
- **Upgrading to short SSO sessions (migration 0006).** Every session of a user with an SSO identity is deleted once, so sessions from before ADR 0025 cannot outlive a sign-out at the issuer. Those users are signed back in from the sign-in page, silently while they are still signed in to the issuer. A token or dev login of an SSO user ends too. Users without an SSO identity keep their sessions.
- **SQLite** works for single-instance installs. It runs in WAL mode with `BEGIN IMMEDIATE` writes, so the server and CLI can share the file. Put it on a local disk, not network storage.

**Backups** need the database (e.g. `pg_dump`) and the blob store: the bucket, or `/data/blobs`. Restore both from the same point in time. An attachment row whose bytes are missing downloads as 404; bytes without a row are only wasted space.

## Health, logs and shutdown

- **Health probes:**
  - `GET /healthz` is liveness (the process is serving).
  - `GET /readyz` is readiness: it checks the database, and returns `503` once shutdown has begun.
- **Logs** are JSON lines on stdout in production. There is one `request` entry per API call, with `reqId`, `method`, `path`, `status`, `ms` and `actor`. `reqId` matches the `X-Request-Id` response header and the `requestId` in problem responses.
- **Shutdown.** On `SIGTERM`/`SIGINT` the server:
  1. stops accepting connections and fails readiness;
  2. ends live event streams with a `shutdown` event, so browsers reconnect elsewhere and resume with `Last-Event-ID`;
  3. waits up to `POIETIC_ISSUES_SHUTDOWN_TIMEOUT_MS` for in-flight requests;
  4. stops the webhook worker and the event tailer, and closes the database.

  Webhook deliveries in flight when a process dies are retried by any replica once their 60-second lease expires.

## Scaling out

Several replicas can run against one Postgres database:

- **Live events.** Every replica tails the event log and is woken by `LISTEN/NOTIFY`, so live updates reach clients on any replica.
- **Webhooks.** Every replica with `POIETIC_ISSUES_WEBHOOKS=1` may deliver. Fan-out and claiming are serialized, so each delivery is sent once per attempt.
- **Attachments** must use S3 (or shared storage).
- **Sessions** live in the database, so no sticky sessions are needed.

## Single sign-on

Set `POIETIC_ISSUES_SSO_ISSUER` and the related configuration variables to enable SSO. See [ADR 0018](adr/0018-sso-via-shared-cookie-jwt.md) for the design.

New users signed in via SSO start deactivated (the sign-in answers with the `PENDING_APPROVAL` error code) until an admin approves them, unless their SSO role matches `POIETIC_ISSUES_SSO_ADMIN_ROLE` (default `admin`) or they are in the group named by `POIETIC_ISSUES_SSO_MEMBER_GROUP` (issues.poietic.tech uses `issues-users`). Both are checked only when a user is first created: someone who signed in before joining the group stays pending until approved, and leaving the group later changes nothing ([ADR 0026](adr/0026-sso-member-group.md)). With `POIETIC_ISSUES_SSO_DIRECTORY_KEY` set (issues.poietic.tech uses the GitHub `production` secret `POIETIC_AUTH_SERVICE_KEY`), auth.poietic.tech owns who people are: listing users refreshes every linked user's name, handle and avatar from its directory, at most every five minutes, and adds member-group people who have never signed in, so they can be assigned before their first visit. If the directory is unreachable, the local users are served as they are ([ADR 0027](adr/0027-sso-directory.md)). Handles come from the issuer too, on every sign-in and refresh, and an account not linked to it that holds one is renamed `<handle>-legacy` (ADR 0031). To list and approve pending users:

```sh
poietic-tech issues user list --include-deactivated  # find pending users
poietic-tech issues user edit <handle> --reactivate   # approve them
```

The route returns `503 UNAVAILABLE` when the issuer's JWKS (signing keys) cannot be fetched.

## Reverse proxy

Terminate TLS in front of the server and set `POIETIC_ISSUES_SECURE_COOKIES=1` (the production default). Live updates use Server-Sent Events on `/api/v1/events/stream`, and **the proxy must not buffer them**:

```nginx
location / {
  proxy_pass http://tracker:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 30m;          # ≥ POIETIC_ISSUES_MAX_UPLOAD_MB
}
location /api/v1/events/stream {
  proxy_pass http://tracker:3000;
  proxy_buffering off;               # the server also sends X-Accel-Buffering: no
  proxy_read_timeout 1h;             # heartbeats are sent every 15 s
  proxy_http_version 1.1;
  proxy_set_header Connection '';
}
```

If the web app is served from a different origin than the API, add that origin to `POIETIC_ISSUES_ALLOWED_ORIGINS`.

Notes:

- Behind a TLS-terminating proxy, `POIETIC_ISSUES_ALLOWED_ORIGINS` must include the public origin (for example `https://issues.example.com`), or `POST /auth/sso` answers 403 (CSRF protection).
- A user's handle is the issuer's `handle` claim. A token without one (from an issuer that has no handles) gets a handle derived from its name; confirm that one with the person before approving.
- Signing out lands on `/login?signedout=1`, which skips the automatic SSO attempt so the user is not signed straight back in; they can press the SSO button to sign in again.

## Pushing tracker events to agents through the bridge

The pipeline agents are woken by Poietic Bridge instead of polling ([ADR 0032](adr/0032-notice-webhooks-and-change-reasons.md)). The tracker sends one webhook of content-free notices to the bridge's `poietic-issues` terminal. Listeners connect out to the bridge, so there is no Tunnel, DNS record or ingress for this. These steps are run once, by the owner or an admin agent, in order.

1. **Create the readers group** in auth and add each listening agent's identity to it. Confirm the group's name with the owner first: a terminal's readers cannot change after it is created.
2. **Create the terminal and the webhook in one pipe**, so the secret never appears on screen or in shell history. The bridge CLI writes only the secret to stdout (its messages go to stderr), and the tracker CLI reads it from stdin and does not print it back:

   ```sh
   poietic-tech bridge terminal create poietic-issues --adapter poietic-issues --readers <group> \
     | poietic-tech issues webhook create https://bridge.poietic.tech/in/poietic-issues \
         --payload notice --events 'issue.*,comment.*' --secret-stdin \
         --description 'Agent wake-ups through the bridge'
   ```

   If the pipe fails halfway, delete whichever of the two was created and run it again.

3. **Check the path.** Send the test ping and see it arrive:

   ```sh
   poietic-tech issues webhook test <whk_id>          # expect OK: HTTP 202
   poietic-tech bridge events poietic-issues          # an issues.webhook.ping event (tracker seq 0)
   ```

   Then change an issue and check that an `issues.issue.updated` event follows. `poietic-tech issues webhook deliveries <whk_id>` shows what the bridge answered.

4. **Deploy the listeners** (persistent-agents). Each subscribes to the terminal with its own identity.

**Rolling back.** Delete the webhook first (`poietic-tech issues webhook rm <whk_id>`), then the terminal. Listeners fall back to their reconciliation schedule. To keep the terminal but stop notices, disable the webhook instead (`webhook edit <whk_id> --disable`).

**Never rotate this webhook's secret.** `webhook rotate-secret` generates a secret the bridge does not know: every delivery then gets 401, and the webhook is disabled after 5 dead deliveries. To change the secret, delete the webhook and the terminal and run step 2 again. Deleting the terminal also removes its subscriptions, so the listeners must create theirs again; their reconciliation pass covers anything missed meanwhile.

**What the bridge refuses.** A body over 8 KiB, anything that is not a notice (a `full` webhook pointed at the terminal gets 400 on every delivery and is disabled after 5 dead deliveries), and a signature or timestamp that does not verify (401).

## Cloudflare Containers (issues.poietic.tech)

The production instance runs on Cloudflare Containers. See [ADR 0019](adr/0019-cloudflare-containers-with-litestream.md) for the design.

**Layout:** `deploy/cloudflare/` holds the Worker (`src/worker.ts`), container configuration (`src/container-env.ts`, `wrangler.jsonc`, `Dockerfile`), and Litestream setup (`litestream.yml`, `entrypoint.sh`). Requests flow: browser → Worker (`poietic-issues`) at https://issues.poietic.tech → container on `:3000`. The route is owned by OpenTofu in poietic-tech/poietic-dot-tech.

**Data:** The database is SQLite at `/data/tracker.db` inside the container, replicated by Litestream 0.5 to the R2 bucket `poietic-issues-db`. Attachments are stored in R2 bucket `poietic-issues-attachments` via the S3 API. The container sleeps after 30 minutes without requests (`sleepAfter = '30m'`; an open live-update stream counts as activity, including an anonymous one on a public project, so a browser tab or script left on `/api/v1/events/stream` keeps the container awake), and Litestream syncs on the way down.

**Restore:** The entrypoint restores only when `/data/tracker.db` is absent, which means a fresh container disk (every cold start, since Containers have no persistent disk). On the very first boot, when the bucket holds no replica, it starts a new, empty database and the tracker migrates it. Restore fails closed: if the replica cannot be read (wrong credentials, R2 unreachable, missing bucket), Litestream exits non-zero before the tracker starts, so the container never serves an empty database in place of the real one. `deploy/cloudflare/test/restore.sh` covers both. To recover, fix the cause and let the next start restore; delete nothing.

**Backups:** The replica is not a backup. Litestream's retention prunes old history, and the R2 bucket has no object versioning, so a bad write or a deleted bucket is not recoverable from it alone. Take periodic independent copies, for example locally, with the R2 credentials exported as `LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY`:

```sh
litestream restore -o tracker-$(date +%F).db \
  "s3://poietic-issues-db/tracker?endpoint=https://<account-id>.r2.cloudflarestorage.com&region=auto&forcePathStyle=true"
```

Store the file somewhere other than R2. Copy the attachments bucket at the same time.

**Upgrades and rollback:** The image migrates at startup (`POIETIC_ISSUES_AUTO_MIGRATE=1`), so a deploy that adds a migration changes the live database as soon as the new container starts. From then on the previous image cannot start: the tracker exits with `corrupted migrations: previously executed migration … is missing`, and the container restarts in a loop. Redeploying the previous image alone does not help, because every cold start restores the migrated database from the replica.

- **Before merging a release with a migration**, take a snapshot with the backup recipe above, named for the release (e.g. `tracker-pre-0004.db`), and check it with `poietic-issues-admin db status --database sqlite:tracker-pre-0004.db`.
- **Fix forward** if the release misbehaves. This is the default: push a fix to `main`, and the schema stays as it is.
- **Go back to the previous release** only if fixing forward is not possible. The container restores whatever the replica holds, so publish a database without the migration as a new replica first:
  1. Choose the database. Either take the current data (`litestream restore -o tracker-now.db "s3://poietic-issues-db/tracker?…"`, the same URL as the backup recipe) and revert the migration with the new release's CLI, from a checkout of it: `pnpm issues-admin db migrate --down --database sqlite:tracker-now.db`. This keeps the writes, but drops what the migration added. Or use the pre-deploy snapshot, which loses every write since the deploy.
  2. Replicate the file once to an empty bucket with the same R2 credential: `litestream replicate -once tracker-now.db "s3://<new-bucket>/tracker?endpoint=https://<account-id>.r2.cloudflarestorage.com&region=auto&forcePathStyle=true"`. Keep the path `tracker`: the container's `litestream.yml` restores from it. Then check the result, because this step decides what the container serves: restore it with `litestream restore -o check.db …` (same URL) and run `poietic-issues-admin db status --database sqlite:check.db`. The reverted migration must be listed under `Pending`, and the data must be there (e.g. `poietic-issues-admin issue list -P <KEY> --database sqlite:check.db`). An empty or wrong bucket boots an **empty tracker**, since a reachable empty replica counts as a first boot. The bucket and the credential's access to it are managed in poietic-tech/poietic-dot-tech.
  3. On `main`, revert the release and point `DB_BUCKET` in `wrangler.jsonc` at the new bucket in the same commit. The deploy workflow ships it, and the fresh container restores from the new bucket.

  The old bucket is left untouched, so this can be undone. The backup recipe above names `poietic-issues-db`; after a rollback, use the new bucket in it. These steps were checked with Litestream 0.5.17 against an S3-compatible store (revert, replicate once, restore, and the previous release reading the result). Writes made between step 1 and the deploy are lost, so keep that window short. Never delete or overwrite the live replica in place, because the running container keeps replicating to it.

**Deploys:** `.github/workflows/deploy.yml` runs after CI passes on a push to `main`. It can also be started by hand (`workflow_dispatch` on `main`); that is the owner's escape hatch and deploys `main` as it is, without waiting for CI. The workflow is the only deploy path: the deploy package has no `deploy` script, because a manual `wrangler deploy` without `--var R2_ENDPOINT:…` breaks every request. It requires these secrets:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with **Workers Scripts Write** and **Workers Containers Write**. It needs no R2 permission.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID.
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: the separate R2 S3 credential used by Litestream and attachments (minted by poietic-dot-tech's infra/api scripts for this repository, poietic-tech/poietic-issues).

The workflow sets the R2 credentials as Worker secrets, deploys, and smoke-checks `/readyz` for up to about 10 minutes (a cold start includes the restore).

**Environment changes:** The new Worker goes live before the container rollout replaces the image, so for a short window the old image can run with the new Worker's environment. Any change to the container's environment contract (`deploy/cloudflare/src/container-env.ts`) must therefore work with both the previous and the new image for one deploy. For example, send both the old and the new variable names for a release, then drop the old ones. See [ADR 0019](adr/0019-cloudflare-containers-with-litestream.md#consequences) for the 2026-10-08 incident.

**Admin:** There is no `docker exec` on a remote container. Use the module as an admin:

```sh
poietic-tech login                                # as an admin
poietic-tech issues user list
poietic-tech issues user edit <handle> --reactivate   # approve pending SSO users
```

**Local test:** `deploy/cloudflare/test/restore.sh` builds the container image and uses SeaweedFS to simulate S3 storage, proving on `linux/amd64` that data survives a container replacement and that a fresh container with an unreachable replica (wrong secret key, closed endpoint) exits without serving.
