# Using the tracker from an AI agent

This guide is for agent harnesses, such as Claude Code or custom loops, that manage work through `poietic-tech issues` or the API. For working _on_ this repository, see [AGENTS.md](../AGENTS.md).

## Setup (once per environment)

```sh
npm i -g @poietic-tech/cli @poietic-tech/issues   # the host and the issues module; the module alone puts no poietic-tech on PATH
poietic-tech login                                 # a person signs in once (not needed when POIETIC_AGENT_TOKEN is set)
poietic-tech issues init --project ENG             # writes .poietic-issues.json; commit it so agents find the project
```

There are two ways to act as an agent, and both leave history showing the agent, not its owner:

- **A person's own session** (a Claude Code session on your machine): sign in with `poietic-tech login`, then set `POIETIC_IDENTITY=<agent>` to act as one of your agents. The host exchanges your login for that agent's identity token.
- **A harness or CI job:** set `POIETIC_AGENT_TOKEN=pat_…`, the agent's own token from auth.poietic.tech. The host exchanges it for a ten-minute identity token and sends that to the server. Keep it out of repositories and browser bundles; the CLI never prints it.

```sh
export POIETIC_IDENTITY=Claude                       # in a session after `poietic-tech login`
export POIETIC_AGENT_TOKEN=pat_…                     # in a harness or CI instead
export POIETIC_ISSUES_PROJECT=ENG                    # or -P ENG, or .poietic-issues.json
export POIETIC_TECH_FORMAT=json                      # machine output everywhere
```

Create agents with `poietic-tech agents create` (or at auth.poietic.tech/account/agents). On its first request, the server creates the agent as a `kind: agent` member owned by you. You must have signed in to the tracker at least once, and the agent is active when your account is. Like any member, it needs a role on each private project it works in: `poietic-tech issues project members add @agent --role editor -P <KEY>`. Without a membership, a private project returns exit code 4 (not found), and a public one is read-only. See [ADR 0021](adr/0021-project-visibility-and-roles.md) and [ADR 0023](adr/0023-agent-identities.md).

`poietic-tech issues whoami` shows the tracker account in effect (handle, role, kind, owner, project access). Every command, reads included, needs a login: with none (no `poietic-tech login` session, no `POIETIC_AGENT_TOKEN`), the host fails the request with exit code 3 (not logged in) before anything reaches the server, so run `whoami` first to see which account is in effect. A token that is invalid, expired or revoked is rejected outright. A revoked or expired `POIETIC_AGENT_TOKEN` is a login failure (exit 3). A `POIETIC_AGENT_TOKEN` with an interior newline is an internal error (exit 1); surrounding whitespace is trimmed.

The server is `https://issues.poietic.tech` unless `POIETIC_ISSUES_SERVER` or the `server` in `.poietic-issues.json` says otherwise. It must be https on a `*.poietic.tech` host, because that is the only place the identity token may be sent.

### issues.poietic.tech identities

Interactive and unattended agents use separate agents, so history shows which one acted and each token can be revoked on its own:

- **`Claude`**: Claude sessions a person drives on their own machine. Install the module, run `poietic-tech login`, and set `POIETIC_IDENTITY=Claude`. If an older install left `~/.config/poietic-issues/config.json`, delete it: it is ignored now.
- **`github-ci`**: GitHub Actions workflows in any `poietic-tech` repository. It is an auth.poietic.tech agent made with `poietic-tech agents create`. Its token is the org secret `POIETIC_AGENT_TOKEN`, which replaces the retired `POIETIC_ISSUES_*` token secret:

  ```yaml
  env:
    POIETIC_AGENT_TOKEN: ${{ secrets.POIETIC_AGENT_TOKEN }}
  steps:
    - run: npm i -g @poietic-tech/cli @poietic-tech/issues
    - run: poietic-tech issues issue list -P ENG --assignee me
  ```

Both agents see only the private projects they are members of.

## Learn the surface in two calls

```sh
poietic-tech issues commands        # all commands/options/exit codes, as JSON whatever the format
poietic-tech issues project schema  # valid statuses, labels, repos, assignable users, custom fields
```

## Recipes

```sh
# Pick up work
poietic-tech issues issue list --assignee me --category unstarted,started --sort priority --fields key,title,status.name,priority

# Claim and start an issue, guarding against concurrent edits
v=$(poietic-tech issues issue view ENG-42 --fields version --json | jq .version)
poietic-tech issues issue edit ENG-42 --assignee me --status "In Progress" --if-version "$v"

# Break work down
poietic-tech issues issue create -t "Write migration" --parent ENG-42 -l chore -q      # prints ENG-43

# Report progress with markdown from a file or stdin
poietic-tech issues comment add ENG-42 --body-file - <<'MD'
Implemented the migration. Tests: `pnpm test` ✅
MD

# Record links to external artifacts
poietic-tech issues issue edit ENG-42 --meta github.pr=https://github.com/acme/app/pull/12 --meta agent.session=abc123

# Relate work
poietic-tech issues link add ENG-43 blocks ENG-42

# Finish
poietic-tech issues issue edit ENG-42 --status "In Review"
```

## Reacting to changes

- **Polling:** keep the last `seq` you processed and call `poietic-tech issues event list --after <seq>`. The log is commit-ordered, so no event is ever skipped.
- **Streaming:** `poietic-tech issues event tail --types issue.updated,comment.created` prints one JSON event per line.
- **Push:** an admin can register a webhook (`poietic-tech issues webhook create URL --events 'issue.*'`) so your service is called on each event. See [events.md](events.md#webhooks).
- **Payload:** each event carries the full resource snapshot, plus `changes: { field: { from, to } }` for updates, so a refetch is never needed.
- **Woken by the bridge:** the pipeline agents listen on the bridge's `poietic-issues` terminal, which carries content-free notices ([deployment.md](deployment.md#pushing-tracker-events-to-agents-through-the-bridge)). A notice only says when to read. A woken agent reads `/events` from its own cursor, as itself, and acts on what the tracker says, never on the notice. `follow()` in `@poietic-tech/issues-client` does this.

## Saying why

- **Every write a pipeline agent makes through `@poietic-tech/issues-client` sends a reason:** `X-Change-Reason`, one line of at most 200 characters, stored on the event as `data.reason` ([api.md](api.md#change-reasons)). Pass `headers: reasonHeaders('…')`. The `poietic-tech issues` CLI cannot send one yet; an agent working through the CLI explains its change in a comment instead.
- **Bigger decisions also get a comment** on the issue, posted under the agent's own identity.
- **Hand-offs are checked with `provenance`.** Before acting on an assignment, an agent checks that the event that last set the assignee and the hand-off metadata is one event, written by the agent it expects. Metadata alone proves nothing: any project writer can edit it.

## Handling failures

Branch on the exit code (`poietic-tech help exit-codes`), not the message text. Conflicts keep a distinct machine code at exit 2, so tell them apart with `--json` (the error's `code`):

| Exit | Do                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | `bad_request` or `bad_usage`: fix the input (the message lists `path: message` lines). Don't retry unchanged.                                                                                  |
| 2    | `version_mismatch` or `conflict`: someone else changed it, or it already exists. Refetch, re-decide, retry. `idempotency_*` is a client bug.                                                   |
| 3    | Not logged in: run `poietic-tech login`, or set `POIETIC_IDENTITY` / `POIETIC_AGENT_TOKEN`. Stop and report in a harness.                                                                      |
| 4    | The reference is wrong, or the project is private and you are not a member; list or search to find the right one. Also `no_such_agent`: `POIETIC_IDENTITY` names an agent that does not exist. |
| 5    | Permissions (`not_allowed`, or the agent is pending approval). Stop and report.                                                                                                                |
| 8    | Transient (network, server down). Retrying later is safe: mutations carry an idempotency key.                                                                                                  |
