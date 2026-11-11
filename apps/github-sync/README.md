# github-sync

Keeps GitHub issues and Poietic Issues in step, both ways ([ADR 0029](../../docs/adr/0029-github-sync-through-the-bridge.md)).

- **GitHub → tracker:** GitHub issue and comment webhooks arrive through [Poietic Bridge](https://bridge.poietic.tech).
  The sync follows every `github` terminal it can read (or those in `SYNC_TERMINALS`; the K3s deployment pins the
  organization-wide `github-poietic-tech`), through one subscription per terminal (`issues-sync`).
- **Tracker → GitHub:** it reads the tracker's event log from a saved cursor when woken, and writes through the GitHub
  REST API. Wake-ups are tracker notices on the bridge terminal `poietic-issues` (subscription `github-sync`, types
  `issues.issue` and `issues.comment`), each acknowledged on receipt; a notice only says "read now", never what
  changed. Reconciliation reads the tracker anyway at start, when the notice connection comes back after more than
  60 seconds down, and every 6 hours. With nothing happening it makes no tracker requests, so the tracker's
  container can sleep. Every tracker write says why (`X-Change-Reason`, such as
  `synced from GitHub issue poietic-tech/poietic-bridge#12`).
- **Repositories ↔ projects:** a repository belongs to the project that lists it under _repos_; one project can
  hold several. A repository with no project gets a new one named after it in title case (`poietic-bridge` →
  "Poietic Bridge", key `PB`), public or private as the repository is. When a repository is made public or
  private, a project that holds only that repository follows.

| GitHub                             | Tracker                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| title, body                        | title, description                                         |
| open                               | any backlog/unstarted/started status (reopen → first open) |
| closed as completed                | first completed status                                     |
| closed as not planned / duplicate  | first canceled status                                      |
| labels (by name)                   | labels (by name, created when missing)                     |
| comments (with "@login on GitHub") | comments (with "Name in Poietic Issues")                   |
| issue deleted                      | issue trashed                                              |
| closed as not planned              | issue trashed                                              |

A tracker issue reaches GitHub when its `repo` is set, or its project has exactly one repo. Assignees, priority,
estimates and other tracker-only fields stay in the tracker.

## Running

```sh
pnpm --filter @poietic-tech/issues-github-sync build   # dist/github-sync.mjs
POIETIC_AGENT_TOKEN=pat_… GITHUB_TOKEN=github_pat_… SYNC_STATE_FILE=./sync.db node apps/github-sync/dist/github-sync.mjs
```

| Variable                   | Default                          | Meaning                                                          |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `POIETIC_AGENT_TOKEN`      | (required)                       | The `github-sync` agent's token from auth.poietic.tech           |
| `GITHUB_TOKEN`             | (required)                       | Fine-grained token: Issues read/write on the synced repositories |
| `POIETIC_ISSUES_SERVER`    | `https://issues.poietic.tech`    | The tracker                                                      |
| `POIETIC_BRIDGE_URL`       | `https://bridge.poietic.tech`    | The bridge                                                       |
| `SYNC_STATE_FILE`          | `/data/sync.db`                  | The sync's SQLite state (links, snapshots, tracker cursor)       |
| `SYNC_TERMINALS`           | every `github` terminal          | Comma-separated terminal names to follow instead                 |
| `SYNC_EXCLUDE_REPOS`       | `poietic-tech/persistent-agents` | Comma-separated `owner/name` repositories to leave alone         |
| `SYNC_SUBSCRIPTION`        | `issues-sync`                    | The bridge subscription name on each GitHub terminal             |
| `SYNC_NOTICE_TERMINAL`     | `poietic-issues`                 | The bridge terminal tracker notices arrive on                    |
| `SYNC_NOTICE_SUBSCRIPTION` | `github-sync`                    | The sync's subscription on the notice terminal                   |
| `SYNC_DISCOVERY_MS`        | `300000`                         | How often to look for new GitHub terminals                       |
| `SYNC_HEALTH_PORT`         | `8080`                           | `/healthz` and `/readyz` (below)                                 |

`/readyz` answers 200 while the notice listener is connected, or reconnecting within the bridge SDK's backoff, and
the last tracker read did not fail. `/healthz` (liveness) answers 200 unless a tracker read has been in flight for
more than 5 minutes. Neither asks for recent activity: idle is healthy.

Logs are one JSON object per line. Events that fail for good (a validation error, say) are logged as
`bridge.event_skipped` / `tracker.event_skipped` and passed over; network and server failures are retried and
never skipped.

## Identity and access

The sync acts as its own agent, `github-sync`, and needs:

1. the agent and its token: `poietic-tech agents create github-sync` (or auth.poietic.tech/account/agents);
2. membership of the `bridge-admins` group at auth.poietic.tech/admin, so it can read every terminal, the
   `poietic-issues` notice terminal included (a terminal's readers cannot be changed after it is created);
3. the tracker **admin** role, because it creates projects. The agent appears in the tracker on its first request
   (start the sync once, or run `POIETIC_AGENT_TOKEN=pat_… poietic-tech issues whoami`); then, as an admin,
   `poietic-tech issues user edit github-sync --role admin` (add `--reactivate` if it is pending);
4. a fine-grained GitHub token, resource owner `poietic-tech`, with **Issues: read and write** (and the default
   Metadata: read) on the repositories to sync.

Deployment on the local K3s cluster is in [deploy/k3s/README.md](../../deploy/k3s/README.md).
