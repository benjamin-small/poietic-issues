# CLI reference

<!-- Generated from `poietic-tech issues commands` by the CLI test suite. Do not edit; run `pnpm vitest run --project cli -u`. -->

See [cli.md](cli.md) for concepts, output formats and configuration.

## Global options

Options of `poietic-tech issues`, which every subcommand inherits. The output format is the host’s:
`--json`, `--format table|json|ndjson|ids` and `-q` come from `poietic-tech` (see `poietic-tech --help`).

| Option | Description |
| --- | --- |
| `-P, --project <key>` | project key (default from POIETIC_ISSUES_PROJECT or .poietic-issues.json) |
| `--fields <list>` | comma-separated fields to include, e.g. key,title,status |

## Exit codes

The exit codes of `poietic-tech` (`poietic-tech help exit-codes`), as this module’s failures use them.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected failure (internal) |
| 2 | Usage error, invalid request or conflict (bad_usage, bad_request, conflict, version_mismatch, idempotency_in_progress, idempotency_key_reused) |
| 3 | Not logged in, or the login was refused (not_logged_in): run `poietic-tech login` |
| 4 | Not found (not_found) |
| 5 | Not allowed (not_allowed) |
| 8 | Network or server failure (network, server_error) |

## Commands

### `poietic-tech issues issue list`

List issues in a project (filters are ANDed; comma lists mean "any of")

Aliases: `ls`

| Option | Description |
| --- | --- |
| `-s, --status <statuses>` | status names/ids |
| `--category <categories>` | status categories: backlog,unstarted,started,completed,canceled |
| `-a, --assignee <users>` | handles/ids, me, none |
| `--creator <users>` | creator handles/ids |
| `-l, --label <labels>` | has any of these labels |
| `-p, --priority <priorities>` | priorities (names or 0-4) |
| `--parent <issue>` | children of this issue, or none for top-level issues |
| `--search <text>` | text in key, title or description |
| `-w, --where <field.op=value>` | any filter, e.g. priority.gte=2, dueDate.isNull=true, cf.severity=high |
| `--filter-json <json|@file|->` | an IssueFilter JSON object |
| `--sort <fields>` | sort fields, - for descending (e.g. -priority,updatedAt) |
| `--limit <n>` | page size (1-200) |
| `--cursor <cursor>` | continue from a previous page |
| `--all` | fetch every page |
| `--include-deleted` | include issues in the trash (only in projects you can write in; ignored elsewhere) |
| `--all-projects` | search across all projects |

### `poietic-tech issues issue view <issue>`

Show one issue

Aliases: `show`

| Argument | Description |
| --- | --- |
| `issue` | issue key (ENG-42) or id |

### `poietic-tech issues issue create`

Create an issue (prints the new issue; -q prints only its key)

Aliases: `new`

| Option | Description |
| --- | --- |
| `-t, --title <title>` | title |
| `-d, --description <markdown>` | description (markdown) |
| `--body-file <path>` | read the description from a file, or - for stdin |
| `-s, --status <status>` | status name or id |
| `-p, --priority <priority>` | none\|urgent\|high\|medium\|low or 0-4 |
| `-a, --assignee <user>` | handle, @handle, me, or none to unassign |
| `--parent <issue>` | parent issue key, or none |
| `-e, --estimate <points>` | estimate, or none |
| `--due <date>` | due date YYYY-MM-DD, or none |
| `--repo <owner/name>` | one of the project's linked GitHub repos (owner/name, URL or id); none, null or '' clears it |
| `--set <field=value>` | custom field (repeatable), e.g. --set severity=high --set points=3 |
| `--meta <key=value>` | metadata entry (repeatable; merged) |
| `--input <json|@file|->` | full JSON payload (CreateIssueInput / UpdateIssueInput); flags override it |
| `-l, --label <labels>` | labels (repeatable or comma-separated) |

### `poietic-tech issues issue edit <issues...>`

Edit one or more issues (several issues are updated atomically)

Aliases: `update`

| Argument | Description |
| --- | --- |
| `issues` | issue keys or ids |

| Option | Description |
| --- | --- |
| `-t, --title <title>` | title |
| `-d, --description <markdown>` | description (markdown) |
| `--body-file <path>` | read the description from a file, or - for stdin |
| `-s, --status <status>` | status name or id |
| `-p, --priority <priority>` | none\|urgent\|high\|medium\|low or 0-4 |
| `-a, --assignee <user>` | handle, @handle, me, or none to unassign |
| `--parent <issue>` | parent issue key, or none |
| `-e, --estimate <points>` | estimate, or none |
| `--due <date>` | due date YYYY-MM-DD, or none |
| `--repo <owner/name>` | one of the project's linked GitHub repos (owner/name, URL or id); none, null or '' clears it |
| `--set <field=value>` | custom field (repeatable), e.g. --set severity=high --set points=3 |
| `--meta <key=value>` | metadata entry (repeatable; merged) |
| `--input <json|@file|->` | full JSON payload (CreateIssueInput / UpdateIssueInput); flags override it |
| `-l, --label <labels>` | replace all labels (repeatable or comma-separated) |
| `--add-label <labels>` | add labels |
| `--remove-label <labels>` | remove labels |
| `--if-version <n>` | fail with a version_mismatch conflict unless the issue is at this version |

### `poietic-tech issues issue move <issue>`

Move an issue on the board: change status and/or position within the column

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

| Option | Description |
| --- | --- |
| `-s, --status <status>` | target status (name or id) |
| `--after <issue>` | place directly after this issue |
| `--before <issue>` | place directly before this issue |
| `--top` | place at the top of the column (default) |
| `--bottom` | place at the bottom of the column |
| `--if-version <n>` | fail unless the issue is at this version |

### `poietic-tech issues issue delete <issue>`

Move an issue to the trash (restorable); --permanent deletes for good (admin)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

| Option | Description |
| --- | --- |
| `--permanent` | delete permanently, with comments and links |
| `--if-version <n>` | fail unless the issue is at this version |

### `poietic-tech issues issue restore <issue>`

Restore an issue from the trash

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `poietic-tech issues issue children <issue>`

List sub-issues

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `poietic-tech issues issue activity <issue>`

Show the history of an issue (changes, comments, links)

Aliases: `history`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

| Option | Description |
| --- | --- |
| `--after <seq>` | only events after this sequence number |
| `--limit <n>` | page size |

### `poietic-tech issues comment list <issue>`

List comments on an issue (oldest first)

Aliases: `ls`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `poietic-tech issues comment add <issue> [text...]`

Comment on an issue (markdown)

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |
| `text` | comment text (optional) |

| Option | Description |
| --- | --- |
| `-b, --body <markdown>` | comment text |
| `--body-file <path>` | read the text from a file, or - for stdin |

### `poietic-tech issues comment edit <id> [text...]`

Edit your comment

| Argument | Description |
| --- | --- |
| `id` | comment id |
| `text` | new text (optional) |

| Option | Description |
| --- | --- |
| `-b, --body <markdown>` | new text |
| `--body-file <path>` | read the text from a file, or - for stdin |

### `poietic-tech issues comment delete <id>`

Delete your comment

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | comment id |

### `poietic-tech issues link list <issue>`

List an issue's links from its perspective

Aliases: `ls`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `poietic-tech issues link add <issue> <relation> <target>`

Link two issues, e.g. `link add ENG-1 blocks ENG-2` or `link add ENG-2 blocked-by ENG-1`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |
| `relation` | link type key or alias (blocks, blocked-by, is-blocked-by, relates, relates-to, duplicates, duplicated-by, is-duplicated-by) |
| `target` | the other issue |

### `poietic-tech issues link remove <id>`

Remove a link by id (see `link list`)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | link id |

### `poietic-tech issues link types`

List link types

### `poietic-tech issues attachment add <issue> <files...>`

Upload one or more files to an issue (the media type is detected from the content)

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |
| `files` | paths to upload, or - for stdin (with --name) |

| Option | Description |
| --- | --- |
| `--name <filename>` | filename to store (default: the file’s basename) |
| `--comment <id>` | associate the upload with a comment on the issue |

### `poietic-tech issues attachment list <issue>`

List the files attached to an issue

Aliases: `ls`

| Argument | Description |
| --- | --- |
| `issue` | issue key or id |

### `poietic-tech issues attachment view <id>`

Show an attachment’s metadata

| Argument | Description |
| --- | --- |
| `id` | attachment id |

### `poietic-tech issues attachment download <id>`

Download an attachment’s content to a file (default: its filename) or - for stdout

Aliases: `get`

| Argument | Description |
| --- | --- |
| `id` | attachment id |

| Option | Description |
| --- | --- |
| `-o, --output <path>` | where to write it; - writes the bytes to stdout |

### `poietic-tech issues attachment remove <id>`

Delete an attachment (uploader or admin)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | attachment id |

### `poietic-tech issues project list`

List projects

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--include-archived` | include archived projects |

### `poietic-tech issues project view [project]`

Show a project

Aliases: `show`

| Argument | Description |
| --- | --- |
| `project` | project key or id (default: configured project) (optional) |

### `poietic-tech issues project create`

Create a project with the default workflow (admin)

| Option | Description |
| --- | --- |
| `-k, --key <KEY>` | issue key prefix, e.g. ENG (immutable) **(required)** |
| `-n, --name <name>` | name **(required)** |
| `--description <text>` | description |
| `--visibility <visibility>` | public: anyone can read; private (default): members, holders of a group grant, and admins |

### `poietic-tech issues project edit [project]`

Edit a project

| Argument | Description |
| --- | --- |
| `project` | project key or id (optional) |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | name |
| `--description <text>` | description |
| `--visibility <visibility>` | public: anyone can read; private: members, holders of a group grant, and admins |
| `--archive` | archive the project (admin) |
| `--unarchive` | unarchive the project (admin) |

### `poietic-tech issues project schema [project]`

JSON Schema for issue create/update in this project, with live enums (statuses, labels, repos, assignable users, custom fields)

| Argument | Description |
| --- | --- |
| `project` | project key or id (optional) |

### `poietic-tech issues project members list`

List the project members

Aliases: `ls`

### `poietic-tech issues project members add [user]`

Give a user (or, with --group, an auth group) a role on the project (needs manage)

| Argument | Description |
| --- | --- |
| `user` | handle, @handle or user id (optional) |

| Option | Description |
| --- | --- |
| `--group <slug>` | an auth group (by its slug) instead of a user |
| `--role <role>` | viewer reads, editor also writes, manager also manages the project **(required)** |

### `poietic-tech issues project members set [user]`

Change a member's role, or a group's (needs manage)

| Argument | Description |
| --- | --- |
| `user` | handle, @handle or user id (optional) |

| Option | Description |
| --- | --- |
| `--group <slug>` | an auth group (by its slug) instead of a user |
| `--role <role>` | the new role **(required)** |

### `poietic-tech issues project members remove [user]`

Remove a user's role on the project, or a group's (needs manage)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `user` | handle, @handle or user id (optional) |

| Option | Description |
| --- | --- |
| `--group <slug>` | an auth group (by its slug) instead of a user |

### `poietic-tech issues project repo list`

List the linked repositories

Aliases: `ls`

### `poietic-tech issues project repo add <repo>`

Link a GitHub repository to the project (needs manage)

| Argument | Description |
| --- | --- |
| `repo` | owner/name or a github.com URL |

### `poietic-tech issues project repo remove <repo>`

Unlink a repository (needs manage); issues that named it are cleared. Takes owner/name, a URL or an rpo_ id

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `repo` | owner/name, github.com URL or repo id |

### `poietic-tech issues status list`

List statuses in board order

Aliases: `ls`

### `poietic-tech issues status create`

Create a status

| Option | Description |
| --- | --- |
| `-n, --name <name>` | name **(required)** |
| `-c, --category <category>` | backlog\|unstarted\|started\|completed\|canceled **(required)** |
| `--color <hex>` | color like #5e6ad2 |
| `--position <n>` | column position (0 = first) |

### `poietic-tech issues status edit <status>`

Edit a status

| Argument | Description |
| --- | --- |
| `status` | status name or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | new name |
| `-c, --category <category>` | category |
| `--color <hex>` | color |

### `poietic-tech issues status delete <status>`

Delete a status (use --move-to if issues use it)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `status` | status name or id |

| Option | Description |
| --- | --- |
| `--move-to <status>` | move its issues to this status first |

### `poietic-tech issues status reorder <statuses...>`

Set the column order: list every status, in order

| Argument | Description |
| --- | --- |
| `statuses` | status names or ids |

### `poietic-tech issues label list`

List labels

Aliases: `ls`

### `poietic-tech issues label create <name>`

Create a label

| Argument | Description |
| --- | --- |
| `name` | label name |

| Option | Description |
| --- | --- |
| `--color <hex>` | color |
| `--description <text>` | description |

### `poietic-tech issues label edit <label>`

Edit a label

| Argument | Description |
| --- | --- |
| `label` | label name or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | new name |
| `--color <hex>` | color |
| `--description <text>` | description |

### `poietic-tech issues label delete <label>`

Delete a label (removes it from issues)

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `label` | label name or id |

### `poietic-tech issues field list`

List custom fields

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--include-archived` | include archived fields |

### `poietic-tech issues field create <key>`

Create a custom field, e.g. `field create severity --type select --option low,high`

| Argument | Description |
| --- | --- |
| `key` | immutable key (lowercase, digits, _) |

| Option | Description |
| --- | --- |
| `--type <type>` | text\|number\|date\|boolean\|select\|multi_select\|user\|url **(required)** |
| `-n, --name <name>` | display name (default: the key) |
| `--description <text>` | description |
| `--option <values>` | options for select types (repeatable or comma-separated) |
| `--config <json|@file|->` | display hints JSON, e.g. {"unit":"pts"} |

### `poietic-tech issues field edit <field>`

Rename, describe, reorder or (un)archive a field

| Argument | Description |
| --- | --- |
| `field` | field key or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | display name |
| `--description <text>` | description |
| `--position <n>` | display position |
| `--archive` | hide the field (values are kept) |
| `--unarchive` | show the field again |

### `poietic-tech issues field delete <field>`

Delete a field and all its values permanently (admin; prefer `field edit --archive`)

| Argument | Description |
| --- | --- |
| `field` | field key or id |

### `poietic-tech issues field option-add <field> <values...>`

Add options to a select / multi_select field

| Argument | Description |
| --- | --- |
| `field` | field key or id |
| `values` | option values |

| Option | Description |
| --- | --- |
| `--color <hex>` | color for the new options |

### `poietic-tech issues field option-edit <field> <value>`

Relabel, recolor or (un)archive an option

| Argument | Description |
| --- | --- |
| `field` | field key or id |
| `value` | option value |

| Option | Description |
| --- | --- |
| `--label <label>` | display label |
| `--color <hex>` | color |
| `--archive` | archive (cannot be chosen anymore; existing values stay) |
| `--unarchive` | unarchive |

### `poietic-tech issues view list`

List views (shared + yours)

Aliases: `ls`

### `poietic-tech issues view show <view>`

Show a view including its config

| Argument | Description |
| --- | --- |
| `view` | view name or id |

### `poietic-tech issues view create`

Save a view

| Option | Description |
| --- | --- |
| `-n, --name <name>` | name **(required)** |
| `--layout <layout>` | list\|board **(required)** |
| `--shared` | share with the project (default: personal) |
| `--config <json|@file|->` | ViewConfig JSON |

### `poietic-tech issues view edit <view>`

Rename a view or replace its config

| Argument | Description |
| --- | --- |
| `view` | view name or id |

| Option | Description |
| --- | --- |
| `-n, --name <name>` | new name |
| `--config <json|@file|->` | ViewConfig JSON |

### `poietic-tech issues view delete <view>`

Delete a view

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `view` | view name or id |

### `poietic-tech issues event list`

List events after a sequence number (use the last seq you saw as --after)

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--after <seq>` | exclusive cursor |
| `--limit <n>` | max events (1-1000) |
| `--issue <issue>` | only this issue (use the global --project to filter by project) |
| `--types <types>` | comma-separated event types, e.g. issue.created,issue.updated |

### `poietic-tech issues event tail`

Follow new events as NDJSON (one event per line) until interrupted

| Option | Description |
| --- | --- |
| `--after <seq>` | start after this seq (default: now) |
| `--interval <ms>` | poll interval (default: `1000`) |
| `--max <n>` | exit after this many events |
| `--issue <issue>` | only this issue (use the global --project to filter by project) |
| `--types <types>` | comma-separated event types, e.g. issue.created,issue.updated |

### `poietic-tech issues webhook list`

List webhooks

Aliases: `ls`

### `poietic-tech issues webhook create <url>`

Register a webhook; prints its signing secret (shown only now)

| Argument | Description |
| --- | --- |
| `url` | receiver URL (https) |

| Option | Description |
| --- | --- |
| `-e, --events <types>` | comma-separated event types, `<noun>.*` or `*` (default: `*`) |
| `--scope <project>` | only events from this project |
| `--description <text>` | what the webhook is for |
| `--inactive` | create it disabled |
| `--payload <payload>` | what to send: full (the event, default) or notice (only its seq, ids and type) |
| `--secret-stdin` | read a supplied signing secret (whsec_…) from stdin instead of generating one |

### `poietic-tech issues webhook view <id>`

Show a webhook

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `poietic-tech issues webhook edit <id>`

Change a webhook; --enable re-activates an automatically disabled one

| Argument | Description |
| --- | --- |
| `id` | webhook id |

| Option | Description |
| --- | --- |
| `--url <url>` | receiver URL |
| `-e, --events <types>` | comma-separated event types, `<noun>.*` or `*` |
| `--scope <project>` | only events from this project; `all` removes the scope |
| `--description <text>` | description |
| `--enable` | activate |
| `--disable` | deactivate |
| `--payload <payload>` | what to send: full (the event) or notice (only its seq, ids and type) |

### `poietic-tech issues webhook delete <id>`

Delete a webhook and its delivery log

Aliases: `rm`

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `poietic-tech issues webhook rotate-secret <id>`

Replace the signing secret; prints the new one

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `poietic-tech issues webhook test <id>`

Send a signed webhook.ping now and show the answer (a failure unless it was 2xx)

| Argument | Description |
| --- | --- |
| `id` | webhook id |

### `poietic-tech issues webhook deliveries <id>`

Show recent deliveries, newest first

| Argument | Description |
| --- | --- |
| `id` | webhook id |

| Option | Description |
| --- | --- |
| `--status <status>` | pending \| succeeded \| failed \| dead |
| `--limit <n>` | page size (1-200) |

### `poietic-tech issues webhook redeliver <delivery>`

Send a delivery again (with a fresh set of retries)

| Argument | Description |
| --- | --- |
| `delivery` | delivery id (whd_…) |

### `poietic-tech issues user list`

List users

Aliases: `ls`

| Option | Description |
| --- | --- |
| `--include-deactivated` | include deactivated users |

### `poietic-tech issues user view <user>`

Show a user

Aliases: `show`

| Argument | Description |
| --- | --- |
| `user` | handle, @handle, me or id |

### `poietic-tech issues user create`

Create a user (admin). Give every agent its own user so its work is attributed.

| Option | Description |
| --- | --- |
| `--handle <handle>` | unique handle **(required)** |
| `-n, --name <name>` | display name **(required)** |
| `--email <email>` | email |
| `--kind <kind>` | human\|agent (default: `human`) |
| `--role <role>` | admin\|member (default: `member`) |

### `poietic-tech issues user edit <user>`

Edit a user

| Argument | Description |
| --- | --- |
| `user` | handle or id |

| Option | Description |
| --- | --- |
| `--handle <handle>` | rename the user (admin only) |
| `-n, --name <name>` | display name |
| `--email <email>` | email |
| `--role <role>` | admin\|member (admin only) |
| `--deactivate` | deactivate (admin only) |
| `--reactivate` | reactivate (admin only) |

### `poietic-tech issues whoami`

Show the user the CLI acts as

### `poietic-tech issues init`

Write .poietic-issues.json here: the --project given, and the server from POIETIC_ISSUES_SERVER when it is set (never tokens)

| Option | Description |
| --- | --- |
| `--force` | overwrite an existing file |

### `poietic-tech issues schema [name]`

Print a JSON Schema: resources and inputs (use `project schema` for live per-project enums)

| Argument | Description |
| --- | --- |
| `name` | one of: issue, issue-create, issue-update, issue-move, issue-filter, comment, comment-create, link, link-create, project, project-create, view-create, view-config, event, problem (optional) |

### `poietic-tech issues api <method> <path>`

Call any API endpoint directly and print the JSON response (like `gh api`)

| Argument | Description |
| --- | --- |
| `method` | GET, POST, PATCH, DELETE |
| `path` | path under /api/v1, e.g. /issues/ENG-1 |

| Option | Description |
| --- | --- |
| `--input <json|@file|->` | request body (JSON) |
| `-f, --field <key=value>` | body field (repeatable; values parsed as JSON when possible) |
| `--query <key=value>` | query parameter (repeatable) |

### `poietic-tech issues commands`

Describe every command, option, exit code and error code as JSON (for agents)

