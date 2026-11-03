# The `poietic-tech issues` CLI

`poietic-tech issues` is the command-line interface to the tracker at issues.poietic.tech, built to be driven by AI agents as much as by people. It is a module (`@poietic-tech/issues`) of the `poietic-tech` command, so it signs in with the shared login and follows the host's output and exit-code conventions. Every command is listed in the generated [CLI reference](cli-reference.md).

```sh
npm i -g @poietic-tech/cli @poietic-tech/issues   # a global install of the module alone does not put poietic-tech on PATH
poietic-tech login
poietic-tech issues issue create -t "Fix login" -p high -l bug --json
poietic-tech issues issue list --assignee me --status "In Progress"
poietic-tech issues issue edit ENG-42 --status Done --add-label shipped
poietic-tech issues comment add ENG-42 --body-file notes.md
poietic-tech issues link add ENG-42 blocked-by ENG-7
```

Local mode (an in-process database, no server) is not part of the module. It lives in the operator tool, [`poietic-issues-admin`](#administration-the-operator-tool).

## Grammar

`poietic-tech issues <noun> <verb> [arguments] [options]`, for example `issue list`, `comment add`, `link add`, `status reorder`.

**Issue references.** Issues are referenced as `ENG-42` or by id, everywhere.

**Other references.** Anything with a name can be referenced by it:

- statuses: `--status "In Progress"`
- labels: `--label bug`
- users: `--assignee @ada`, `me` or `none`
- links: `blocks`, `blocked-by`, `relates-to`, `duplicates`, `duplicated-by`

## Connecting and signing in

The module talks to one server over HTTPS and holds no credential of its own. The host resolves who you are:

- **A person:** `poietic-tech login` once.
- **An agent in a person's session:** `POIETIC_IDENTITY=<agent>` after `poietic-tech login`.
- **A harness or CI job:** `POIETIC_AGENT_TOKEN=pat_…`.

See [agents.md](agents.md) and [ADR 0023](adr/0023-agent-identities.md). The module never prints an identity token and sends it only to `*.poietic.tech` over https.

Settings, first wins:

1. Module options on `issues`, inherited by every subcommand: `-P, --project <key>` and `--fields <list>`.
2. Environment: `POIETIC_ISSUES_SERVER`, `POIETIC_ISSUES_PROJECT`, and the host's `POIETIC_TECH_FORMAT`.
3. `.poietic-issues.json`, found by walking up from the current directory. Write it with `poietic-tech issues init --project KEY`. It holds `server` and `project`, **never tokens** (a file with a token is refused). Commit it to a repository so agents working there pick the right project.

The server is `https://issues.poietic.tech` by default. A `POIETIC_ISSUES_SERVER` or `server` override must be https on a `*.poietic.tech` host, or the command fails with a usage error.

The user config file `~/.config/poietic-issues/config.json` and the old token and format variables of the `poietic-issues` CLI are gone and ignored. Delete the file. `poietic-tech issues whoami` shows the tracker account in effect (handle, role, kind, owner, project access).

## Output contract

The output format belongs to the host:

| Format | Flag                                | Output                                                    |
| ------ | ----------------------------------- | --------------------------------------------------------- |
| table  | default                             | Aligned columns for humans. Hints go to stderr.           |
| json   | `--json` or `--format json`         | The resource objects. Lists are `{ "data": [...] }`.      |
| ndjson | `--format ndjson`                   | One JSON object per line. Good for streaming and `jq -c`. |
| ids    | `-q` / `--quiet`, or `--format ids` | Only identifiers, one per line.                           |

- `POIETIC_TECH_FORMAT=json` sets the default for a whole session.
- The format never switches automatically based on TTY detection.
- `--fields key,title,status,assignee.handle` narrows the table columns and projects the objects for json and ndjson. Plain names are resource fields or field-registry keys (e.g. `statusCategory`). Dotted paths reach into objects.
- `--all` fetches every page. `--limit` and `--cursor` page manually.
- **stdout carries only results.** Errors and hints go to **stderr**.
- Nothing ever prompts. A missing required input fails immediately with exit code 2.
- **Raw commands print the same bytes whatever the format:** `event tail` (one NDJSON line per event), `attachment download -o -` (the file's bytes), `schema`, `api` (the response body), `commands` (the JSON reference) and `fields describe` (text). Piped or redirected, they are exact. To a terminal the host cleans control characters, and refuses binary (`attachment download -o -` to a terminal is exit 2; redirect it or use `-o <file>`).
- A JSON list is `{"data":[...],"nextCursor":…}`: `nextCursor` is a string while more pages exist and `null` on the last page. The table, `ndjson` and `ids` forms keep stdout to rows and print the cursor hint on stderr.
- `-q` prints each resource's own identifier, on a single item too: an issue's key, even when `--fields` leaves it out.
- `issue view` in table format shows the description below its header with its line breaks.

Known limitation: some human hints the old CLI printed are not shown.

## Errors and exit codes

The exit codes are the host's table (`poietic-tech help exit-codes`). The module maps the API's error codes onto it by meaning:

| Exit | Meaning                             | Machine codes (`--json` error `code`)                                                                                             |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                             |                                                                                                                                   |
| 1    | Internal error                      | `internal`                                                                                                                        |
| 2    | Usage, invalid request, or conflict | `bad_usage`, `bad_request`, and the conflicts `conflict`, `version_mismatch`, `idempotency_in_progress`, `idempotency_key_reused` |
| 3    | Not logged in                       | `not_logged_in`                                                                                                                   |
| 4    | Not found                           | `not_found`, and the host's `no_such_agent` (`POIETIC_IDENTITY` names an unknown agent)                                           |
| 5    | Not allowed                         | `not_allowed` (forbidden, or an account pending approval)                                                                         |
| 8    | Network or server failure           | `network`, `server_error` (including 429 and 5xx)                                                                                 |

Conflicts share exit 2 with usage errors but keep their own machine code, so an agent can tell "someone else changed it, refetch" from "fix your input". Field-level validation errors are appended to the message, one `path: message` per line. The API's own codes are in [api.md](api.md#errors).

## Input

- **Long text:** `--body-file <path>`, or `--body-file -` to read stdin (descriptions, comments).
- **Structured input:** `--input <json | @file | ->` passes a full request payload (`CreateIssueInput` / `UpdateIssueInput`). Flags override its fields.
- **Custom fields:** `--set severity=high --set points=3`. Values are parsed as JSON when possible, so `--set tags='["a","b"]'` works.
- **Metadata:** `--meta github.pr=https://…` merges into the issue's `metadata`, a place for agent and integration bookkeeping.
- **Clearing a field:** `none` clears it, e.g. `--assignee none`, `--parent none`, `--due none`, `--repo none` (an empty `--repo ''` does too).

## Safety for automation

- **Retries are safe.** Every mutation in remote mode carries an `Idempotency-Key`. Network failures are retried twice with the same key, so a retried create never duplicates.
- **Optimistic concurrency.** `--if-version N` (from the issue's `version`) makes `edit`, `move` and `delete` fail with exit 2 (`version_mismatch`) instead of overwriting a concurrent change.
- **Deletes are restorable.** `issue delete` moves the issue to the trash, and `issue restore` brings it back. `--permanent` is admin-only.
- **Atomic multi-issue edits.** `issue edit ENG-1 ENG-2 …` updates several issues atomically.

## Project access

Projects are `private` (members, holders of a group grant, and admins) or `public` (anyone can read). Members have a role: `viewer`, `editor` or `manager`. A project can also grant a role to an auth group (`--group <slug>`, with `set` and `remove` too). Changing any of this needs `manage` on the project. These commands take the project from `-P`, `POIETIC_ISSUES_PROJECT` or `.poietic-issues.json`, like the rest of the CLI.

```sh
poietic-tech issues project edit ENG --visibility public
poietic-tech issues project members add @ada --role editor -P ENG
poietic-tech issues project members set @ada --role manager -P ENG
poietic-tech issues project members add --group issues-users --role viewer -P ENG   # an auth group
poietic-tech issues project members list -P ENG                                    # KIND is user or group
poietic-tech issues project repo add https://github.com/acme/app -P ENG   # or acme/app
poietic-tech issues issue edit ENG-42 --repo acme/app                      # one of the project's linked repos
```

Since `@poietic-tech/issues` 0.3.0, `project members list` prints `KIND MEMBER ROLE SINCE` (it was `USER ROLE SINCE`), and its JSON rows carry `kind: "user"` or `"group"`. Scripts that parse the table or the user rows should read the new column and field.

## Discovery

| Command                                                                           | What it gives                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `poietic-tech issues commands`                                                    | Every command, argument, option, exit code, error code and environment variable, as JSON, whatever the format       |
| `poietic-tech issues project schema`                                              | JSON Schema for issue create/update in the current project, with live enums: statuses, labels, users, custom fields |
| `poietic-tech issues schema <name>`                                               | JSON Schema of resources and inputs (`issue`, `issue-create`, `issue-filter`, `view-config`, …)                     |
| `poietic-tech issues api GET /issues/ENG-1`                                       | Any endpoint, raw (like `gh api`)                                                                                   |
| `poietic-tech issues event list --after <seq>` / `poietic-tech issues event tail` | What changed since a point in time (NDJSON with `tail`)                                                             |

## Administration: the operator tool

Local mode lives in `poietic-issues-admin`, which is never published. It is the same command tree over the in-process app on a local database in trusted mode, plus `db migrate|status|bootstrap|seed` and `serve`. It runs as `pnpm issues-admin …` in this repository and as `poietic-issues-admin` in the Docker image. It keeps the old local flags (`--database`, `--actor`) and its own output: `--json`, `--format`, `-q`, `POIETIC_ISSUES_FORMAT`, and exit codes 0 ok, 1 internal, 2 usage or validation, 3 not found, 4 conflict, 5 authentication or permission, 6 unavailable.

```sh
pnpm issues-admin --database sqlite:./data/dev.db db migrate    # apply migrations
pnpm issues-admin db seed                                       # demo data (empty database only)
pnpm issues-admin db bootstrap --handle you --name "Your Name"  # the first admin, with no token
pnpm issues-admin serve --port 3000                             # run the server on the local database
pnpm issues-admin user create --handle builder-bot --name "Builder Bot" --kind agent
```

Real agents are auth.poietic.tech agents, not users made here ([agents.md](agents.md)).
