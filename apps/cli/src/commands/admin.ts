import type { ApiClient, Schemas } from '@poietic-tech/issues-client';
import type { Command } from 'commander';
import { CliError, usage } from '../errors.ts';
import { readJsonArg } from '../tree/args.ts';
import type { CommandRuntime, Tree } from '../tree/runtime.ts';
import { registerMembers, registerRepo, visibilityOption } from './members.ts';

type Opts = Record<string, unknown>;
const pick = (o: Opts, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

async function statusId(rt: CommandRuntime, api: ApiClient, ref: string): Promise<string> {
  if (ref.startsWith('sts_')) return ref;
  const list = (
    await rt.call(
      api.GET('/projects/{project}/statuses', { params: { path: { project: rt.project() } } }),
    )
  ).data;
  const found = list.find((s) => s.name.toLowerCase() === ref.toLowerCase());
  if (!found)
    throw new CliError(
      'NOT_FOUND',
      `Status "${ref}" not found in ${rt.project()} (${list.map((s) => s.name).join(', ')})`,
    );
  return found.id;
}

async function labelId(rt: CommandRuntime, api: ApiClient, ref: string): Promise<string> {
  if (ref.startsWith('lbl_')) return ref;
  const list = (
    await rt.call(
      api.GET('/projects/{project}/labels', { params: { path: { project: rt.project() } } }),
    )
  ).data;
  const found = list.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new CliError('NOT_FOUND', `Label "${ref}" not found in ${rt.project()}`);
  return found.id;
}

async function viewId(rt: CommandRuntime, api: ApiClient, ref: string): Promise<string> {
  if (ref.startsWith('viw_')) return ref;
  const list = (
    await rt.call(
      api.GET('/projects/{project}/views', { params: { path: { project: rt.project() } } }),
    )
  ).data;
  const found = list.find((v) => v.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new CliError('NOT_FOUND', `View "${ref}" not found in ${rt.project()}`);
  return found.id;
}

export function registerProject(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent.command('project').description('Manage projects');
  cmd
    .command('list')
    .alias('ls')
    .description('List projects')
    .option('--include-archived', 'include archived projects')
    .action(
      act(async (rt, _a, o) => {
        const api = await rt.api();
        rt.out.list(
          'project',
          (
            await rt.call(
              api.GET('/projects', {
                params: { query: o.includeArchived ? { includeArchived: 'true' } : {} },
              }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('view')
    .alias('show')
    .description('Show a project')
    .argument('[project]', 'project key or id (default: configured project)')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        rt.out.item(
          'project',
          await rt.call(
            api.GET('/projects/{project}', {
              params: { path: { project: rt.project(ref as string | undefined) } },
            }),
          ),
        );
      }),
    );
  cmd
    .command('create')
    .description('Create a project with the default workflow (admin)')
    .requiredOption('-k, --key <KEY>', 'issue key prefix, e.g. ENG (immutable)')
    .requiredOption('-n, --name <name>', 'name')
    .option('--description <text>', 'description')
    .addOption(
      visibilityOption(
        cmd,
        'public: anyone can read; private (default): members, holders of a group grant, and admins',
      ),
    )
    .action(
      act(async (rt, _a, o) => {
        const api = await rt.api();
        rt.out.item(
          'project',
          await rt.call(
            api.POST('/projects', {
              body: pick(o, [
                'key',
                'name',
                'description',
                'visibility',
              ]) as Schemas['CreateProjectInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('edit')
    .description('Edit a project')
    .argument('[project]', 'project key or id')
    .option('-n, --name <name>', 'name')
    .option('--description <text>', 'description')
    .addOption(
      visibilityOption(
        cmd,
        'public: anyone can read; private: members, holders of a group grant, and admins',
      ),
    )
    .option('--archive', 'archive the project (admin)')
    .option('--unarchive', 'unarchive the project (admin)')
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const body: Schemas['UpdateProjectInput'] = pick(o, ['name', 'description', 'visibility']);
        if (o.archive) body.archived = true;
        if (o.unarchive) body.archived = false;
        rt.out.item(
          'project',
          await rt.call(
            api.PATCH('/projects/{project}', {
              params: { path: { project: rt.project(ref as string | undefined) } },
              body,
            }),
          ),
        );
      }),
    );
  cmd
    .command('schema')
    .description(
      'JSON Schema for issue create/update in this project, with live enums (statuses, labels, repos, assignable users, custom fields)',
    )
    .argument('[project]', 'project key or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        const data = await rt.call(
          api.GET('/projects/{project}/schema/issue', {
            params: { path: { project: rt.project(ref as string | undefined) } },
          }),
        );
        rt.out.raw(`${JSON.stringify(data, null, 2)}\n`);
      }),
    );
  registerMembers(cmd, tree);
  registerRepo(cmd, tree);
  return cmd;
}

export function registerStatus(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('status')
    .description("Manage a project's workflow statuses (board columns)");
  cmd
    .command('list')
    .alias('ls')
    .description('List statuses in board order')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        rt.out.list(
          'status',
          (
            await rt.call(
              api.GET('/projects/{project}/statuses', {
                params: { path: { project: rt.project() } },
              }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('create')
    .description('Create a status')
    .requiredOption('-n, --name <name>', 'name')
    .requiredOption('-c, --category <category>', 'backlog|unstarted|started|completed|canceled')
    .option('--color <hex>', 'color like #5e6ad2')
    .option('--position <n>', 'column position (0 = first)', (v) => Number(v))
    .action(
      act(async (rt, _a, o) => {
        const api = await rt.api();
        rt.out.item(
          'status',
          await rt.call(
            api.POST('/projects/{project}/statuses', {
              params: { path: { project: rt.project() } },
              body: pick(o, [
                'name',
                'category',
                'color',
                'position',
              ]) as Schemas['CreateStatusInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('edit')
    .description('Edit a status')
    .argument('<status>', 'status name or id')
    .option('-n, --name <name>', 'new name')
    .option('-c, --category <category>', 'category')
    .option('--color <hex>', 'color')
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const id = await statusId(rt, api, String(ref));
        rt.out.item(
          'status',
          await rt.call(
            api.PATCH('/statuses/{id}', {
              params: { path: { id } },
              body: pick(o, ['name', 'category', 'color']) as Schemas['UpdateStatusInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('delete')
    .alias('rm')
    .description('Delete a status (use --move-to if issues use it)')
    .argument('<status>', 'status name or id')
    .option('--move-to <status>', 'move its issues to this status first')
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const id = await statusId(rt, api, String(ref));
        rt.out.item(
          'status',
          await rt.call(
            api.DELETE('/statuses/{id}', {
              params: { path: { id }, query: o.moveTo ? { moveIssuesTo: String(o.moveTo) } : {} },
            }),
          ),
        );
      }),
    );
  cmd
    .command('reorder')
    .description('Set the column order: list every status, in order')
    .argument('<statuses...>', 'status names or ids')
    .action(
      act(async (rt, [refs]) => {
        const api = await rt.api();
        const ids = [];
        for (const ref of refs as string[]) ids.push(await statusId(rt, api, ref));
        rt.out.list(
          'status',
          (
            await rt.call(
              api.POST('/projects/{project}/statuses/reorder', {
                params: { path: { project: rt.project() } },
                body: { ids },
              }),
            )
          ).data,
        );
      }),
    );
  return cmd;
}

export function registerLabel(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent.command('label').description("Manage a project's labels");
  cmd
    .command('list')
    .alias('ls')
    .description('List labels')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        rt.out.list(
          'label',
          (
            await rt.call(
              api.GET('/projects/{project}/labels', {
                params: { path: { project: rt.project() } },
              }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('create')
    .description('Create a label')
    .argument('<name>', 'label name')
    .option('--color <hex>', 'color')
    .option('--description <text>', 'description')
    .action(
      act(async (rt, [name], o) => {
        const api = await rt.api();
        rt.out.item(
          'label',
          await rt.call(
            api.POST('/projects/{project}/labels', {
              params: { path: { project: rt.project() } },
              body: {
                name: String(name),
                ...pick(o, ['color', 'description']),
              } as Schemas['CreateLabelInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('edit')
    .description('Edit a label')
    .argument('<label>', 'label name or id')
    .option('-n, --name <name>', 'new name')
    .option('--color <hex>', 'color')
    .option('--description <text>', 'description')
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const id = await labelId(rt, api, String(ref));
        rt.out.item(
          'label',
          await rt.call(
            api.PATCH('/labels/{id}', {
              params: { path: { id } },
              body: pick(o, ['name', 'color', 'description']),
            }),
          ),
        );
      }),
    );
  cmd
    .command('delete')
    .alias('rm')
    .description('Delete a label (removes it from issues)')
    .argument('<label>', 'label name or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        const id = await labelId(rt, api, String(ref));
        rt.out.item(
          'label',
          await rt.call(api.DELETE('/labels/{id}', { params: { path: { id } } })),
        );
      }),
    );
  return cmd;
}

export function registerView(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('view')
    .description('Saved list/board views (filters, sort, columns, card fields)');
  cmd
    .command('list')
    .alias('ls')
    .description('List views (shared + yours)')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        rt.out.list(
          'view',
          (
            await rt.call(
              api.GET('/projects/{project}/views', { params: { path: { project: rt.project() } } }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('show')
    .description('Show a view including its config')
    .argument('<view>', 'view name or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        const id = await viewId(rt, api, String(ref));
        rt.out.item(
          'view',
          await rt.call(api.GET('/views/{id}', { params: { path: { id } } })),
          (v) => `${JSON.stringify(v, null, 2)}\n`,
        );
      }),
    );
  cmd
    .command('create')
    .description('Save a view')
    .requiredOption('-n, --name <name>', 'name')
    .requiredOption('--layout <layout>', 'list|board')
    .option('--shared', 'share with the project (default: personal)')
    .option('--config <json|@file|->', 'ViewConfig JSON')
    .action(
      act(async (rt, _a, o) => {
        const api = await rt.api();
        const config = o.config
          ? await readJsonArg(rt.io, String(o.config), '--config')
          : undefined;
        rt.out.item(
          'view',
          await rt.call(
            api.POST('/projects/{project}/views', {
              params: { path: { project: rt.project() } },
              body: {
                name: String(o.name),
                layout: o.layout as 'list' | 'board',
                shared: Boolean(o.shared),
                ...(config && { config }),
              } as Schemas['CreateViewInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('edit')
    .description('Rename a view or replace its config')
    .argument('<view>', 'view name or id')
    .option('-n, --name <name>', 'new name')
    .option('--config <json|@file|->', 'ViewConfig JSON')
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const id = await viewId(rt, api, String(ref));
        const body: Schemas['UpdateViewInput'] = {};
        if (o.name) body.name = String(o.name);
        if (o.config)
          body.config = (await readJsonArg(
            rt.io,
            String(o.config),
            '--config',
          )) as Schemas['ViewConfig'];
        if (Object.keys(body).length === 0) throw usage('Nothing to change');
        rt.out.item(
          'view',
          await rt.call(api.PATCH('/views/{id}', { params: { path: { id } }, body })),
        );
      }),
    );
  cmd
    .command('delete')
    .alias('rm')
    .description('Delete a view')
    .argument('<view>', 'view name or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        const id = await viewId(rt, api, String(ref));
        rt.out.item('view', await rt.call(api.DELETE('/views/{id}', { params: { path: { id } } })));
      }),
    );
  return cmd;
}

export function registerUser(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent.command('user').description('Manage users (humans and agents)');
  cmd
    .command('list')
    .alias('ls')
    .description('List users')
    .option('--include-deactivated', 'include deactivated users')
    .action(
      act(async (rt, _a, o) => {
        const api = await rt.api();
        rt.out.list(
          'user',
          (
            await rt.call(
              api.GET('/users', {
                params: { query: o.includeDeactivated ? { includeDeactivated: 'true' } : {} },
              }),
            )
          ).data,
        );
      }),
    );
  cmd
    .command('view')
    .alias('show')
    .description('Show a user')
    .argument('<user>', 'handle, @handle, me or id')
    .action(
      act(async (rt, [ref]) => {
        const api = await rt.api();
        rt.out.item(
          'user',
          await rt.call(api.GET('/users/{user}', { params: { path: { user: String(ref) } } })),
        );
      }),
    );
  cmd
    .command('create')
    .description('Create a user (admin). Give every agent its own user so its work is attributed.')
    .requiredOption('--handle <handle>', 'unique handle')
    .requiredOption('-n, --name <name>', 'display name')
    .option('--email <email>', 'email')
    .option('--kind <kind>', 'human|agent', 'human')
    .option('--role <role>', 'admin|member', 'member')
    .action(
      act(async (rt, _a, o) => {
        const api = await rt.api();
        rt.out.item(
          'user',
          await rt.call(
            api.POST('/users', {
              body: pick(o, [
                'handle',
                'name',
                'email',
                'kind',
                'role',
              ]) as Schemas['CreateUserInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('edit')
    .description('Edit a user')
    .argument('<user>', 'handle or id')
    .option('--handle <handle>', 'rename the user (admin only)')
    .option('-n, --name <name>', 'display name')
    .option('--email <email>', 'email')
    .option('--role <role>', 'admin|member (admin only)')
    .option('--deactivate', 'deactivate (admin only)')
    .option('--reactivate', 'reactivate (admin only)')
    .action(
      act(async (rt, [ref], o) => {
        const api = await rt.api();
        const body: Schemas['UpdateUserInput'] = pick(o, ['handle', 'name', 'email', 'role']);
        if (o.deactivate) body.deactivated = true;
        if (o.reactivate) body.deactivated = false;
        rt.out.item(
          'user',
          await rt.call(
            api.PATCH('/users/{user}', { params: { path: { user: String(ref) } }, body }),
          ),
        );
      }),
    );
  return cmd;
}
