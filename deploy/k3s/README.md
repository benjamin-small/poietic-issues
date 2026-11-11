# github-sync on K3s

The [GitHub sync](../../apps/github-sync/README.md) runs on the local K3s cluster (`ssh papa`, `sudo k3s kubectl`)
in the namespace `poietic-issues-sync`: one StatefulSet replica, a 1 Gi `local-path` volume for its SQLite state,
a non-root read-only container, and network policy that allows only DNS and public HTTPS out.

## First deployment

1. Set up the identity and the GitHub token ([apps/github-sync/README.md](../../apps/github-sync/README.md#identity-and-access)).
2. Put both tokens in Infisical (Poietic Dot Tech, `prod`, `/agents/github-sync`): `POIETIC_API_KEY` (the
   agent's `pat_` token) and `GITHUB_API_KEY` (the fine-grained GitHub token). Then copy them into the cluster; the values never touch disk or the
   terminal:

   ```sh
   deploy/k3s/set-secret.sh
   ```

3. Build, import and roll out (from a clean tree; the image is tagged with the commit):

   ```sh
   deploy/k3s/deploy.sh
   ```

Every later deployment is step 3 again. To rotate a token, update it in Infisical, run `set-secret.sh`, then
`ssh papa sudo k3s kubectl -n poietic-issues-sync rollout restart statefulset/github-sync`.

## Operating

```sh
ssh papa sudo k3s kubectl -n poietic-issues-sync logs statefulset/github-sync -f
ssh papa sudo k3s kubectl -n poietic-issues-sync get pods,pvc
poietic-tech bridge terminal show github-poietic-tech     # the issues-sync subscription's position and lag
poietic-tech bridge terminal show poietic-issues          # the github-sync notice subscription
```

- **A skipped event** (`*.event_skipped` in the logs) failed for a reason a retry would not fix. Fix the cause,
  then make any edit on either side: the next event carries the whole current state.
- **Tracker → GitHub is woken by notices** on `poietic-issues` (see the [sync's README](../../apps/github-sync/README.md)).
  Idle, it makes no tracker requests; `tracker.reconcile` in the logs marks the reads at start, after a notice
  outage of more than a minute, and every 6 hours. Not ready (`/readyz` 503) means the notice listener stopped
  (`bridge.stopped` for `poietic-issues`, for example `not_allowed` when the agent is not a reader) or the last
  tracker read failed (`tracker.retry`).
- **Lost volume:** the sync rebuilds its links from `poietic.github.url` on tracker issues when it starts with an
  empty store, and its tracker cursor starts at the newest event.
- **Replay from the bridge:** `poietic-tech bridge subscription reset <terminal> issues-sync --to <seq>` with the
  pod stopped. Replays are safe: events are applied against GitHub's current state, and creates are idempotent.
