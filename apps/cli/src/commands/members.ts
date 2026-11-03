import type { ApiClient, Schemas } from '@poietic-tech/issues-client';
import type { Command } from 'commander';
import { usage } from '../errors.ts';
import type { CommandRuntime, Tree } from '../tree/runtime.ts';

export const PROJECT_ROLES = ['viewer', 'editor', 'manager'] as const;
export const PROJECT_VISIBILITIES = ['public', 'private'] as const;

/** `--role <role>`, required, limited to the project roles (a bad value is a usage error, exit 2). */
const roleOption = (cmd: Command, what: string) =>
  cmd.createOption('--role <role>', what).choices(PROJECT_ROLES).makeOptionMandatory();

/** `--visibility <visibility>`, limited to the two visibilities. */
export const visibilityOption = (cmd: Command, what: string) =>
  cmd.createOption('--visibility <visibility>', what).choices(PROJECT_VISIBILITIES);

const GROUP_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `--group <slug>`: act on an auth group instead of a user. */
const GROUP_OPTION = ['--group <slug>', 'an auth group (by its slug) instead of a user'] as const;

/**
 * Which one the command acts on: the user argument, or `--group`. Giving both, or neither, is a usage error (exit 2),
 * as is a slug the server would refuse.
 */
function target(user: unknown, group: unknown): { user: string } | { group: string } {
  if (user !== undefined && group !== undefined) throw usage('Give a user or --group, not both');
  if (group !== undefined) {
    if (!GROUP_SLUG.test(String(group)))
      throw usage('--group takes a group slug: lowercase letters, digits and "-"');
    return { group: String(group) };
  }
  if (user === undefined) throw usage('Give a user, or --group <slug>');
  return { user: String(user) };
}

/** `PUT` a group's grant; the row carries `kind: 'group'` so it prints like the list does. */
async function putGroup(rt: CommandRuntime, api: ApiClient, group: string, role: unknown) {
  const grant = await rt.call(
    api.PUT('/projects/{project}/group-grants/{group}', {
      params: { path: { project: rt.project(undefined), group } },
      body: { role } as Schemas['SetProjectGroupGrantInput'],
    }),
  );
  return { ...grant, kind: 'group' };
}

/**
 * `project members …`. The project comes from the global `-P/--project`, `POIETIC_ISSUES_PROJECT` or
 * `.poietic-issues.json`, so the positional slot is free for the user.
 */
export function registerMembers(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('members')
    .description(
      "Manage who can use a private project and how (a project's members; project is set with -P)",
    );
  cmd
    .command('list')
    .alias('ls')
    .description('List the project members')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        const project = rt.project(undefined);
        const people = (
          await rt.call(api.GET('/projects/{project}/members', { params: { path: { project } } }))
        ).data;
        const groups = (
          await rt.call(
            api.GET('/projects/{project}/group-grants', { params: { path: { project } } }),
          )
        ).data;
        rt.out.list('member', [
          ...people.map((m) => ({ ...m, kind: 'user' })),
          ...groups.map((g) => ({ ...g, kind: 'group' })),
        ]);
      }),
    );
  cmd
    .command('add')
    .description(
      'Give a user (or, with --group, an auth group) a role on the project (needs manage)',
    )
    .argument('[user]', 'handle, @handle or user id')
    .option(...GROUP_OPTION)
    .addOption(
      roleOption(cmd, 'viewer reads, editor also writes, manager also manages the project'),
    )
    .action(
      act(async (rt, [user], o) => {
        const who = target(user, o.group);
        const api = await rt.api();
        if ('group' in who)
          return rt.out.item('member', await putGroup(rt, api, who.group, o.role));
        rt.out.item(
          'member',
          await rt.call(
            api.POST('/projects/{project}/members', {
              params: { path: { project: rt.project(undefined) } },
              body: { user: who.user, role: o.role } as Schemas['AddProjectMemberInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('set')
    .description("Change a member's role, or a group's (needs manage)")
    .argument('[user]', 'handle, @handle or user id')
    .option(...GROUP_OPTION)
    .addOption(roleOption(cmd, 'the new role'))
    .action(
      act(async (rt, [user], o) => {
        const who = target(user, o.group);
        const api = await rt.api();
        if ('group' in who)
          return rt.out.item('member', await putGroup(rt, api, who.group, o.role));
        rt.out.item(
          'member',
          await rt.call(
            api.PATCH('/projects/{project}/members/{user}', {
              params: { path: { project: rt.project(undefined), user: who.user } },
              body: { role: o.role } as Schemas['UpdateProjectMemberInput'],
            }),
          ),
        );
      }),
    );
  cmd
    .command('remove')
    .alias('rm')
    .description("Remove a user's role on the project, or a group's (needs manage)")
    .argument('[user]', 'handle, @handle or user id')
    .option(...GROUP_OPTION)
    .action(
      act(async (rt, [user], o) => {
        const who = target(user, o.group);
        const api = await rt.api();
        const name = 'group' in who ? who.group : who.user;
        const res =
          'group' in who
            ? await api.DELETE('/projects/{project}/group-grants/{group}', {
                params: { path: { project: rt.project(undefined), group: who.group } },
              })
            : await api.DELETE('/projects/{project}/members/{user}', {
                params: { path: { project: rt.project(undefined), user: who.user } },
              });
        await rt.call(res as never);
        rt.out.item('raw', { id: name, removed: true }, () => `Removed ${name}\n`);
      }),
    );
  return cmd;
}

/** `project repo …`: the GitHub repositories linked to a project. The project comes from `-P` as above. */
export function registerRepo(parent: Command, tree: Tree): Command {
  const act: Tree['act'] = (fn) => tree.act(fn);
  const cmd = parent
    .command('repo')
    .description("Manage a project's linked GitHub repositories (project is set with -P)");
  cmd
    .command('list')
    .alias('ls')
    .description('List the linked repositories')
    .action(
      act(async (rt) => {
        const api = await rt.api();
        const project = await rt.call(
          api.GET('/projects/{project}', {
            params: { path: { project: rt.project(undefined) } },
          }),
        );
        rt.out.list('repo', project.repos);
      }),
    );
  cmd
    .command('add')
    .description('Link a GitHub repository to the project (needs manage)')
    .argument('<repo>', 'owner/name or a github.com URL')
    .action(
      act(async (rt, [repo]) => {
        const api = await rt.api();
        rt.out.item(
          'repo',
          await rt.call(
            api.POST('/projects/{project}/repos', {
              params: { path: { project: rt.project(undefined) } },
              body: { repo: String(repo) },
            }),
          ),
        );
      }),
    );
  cmd
    .command('remove')
    .alias('rm')
    .description(
      'Unlink a repository (needs manage); issues that named it are cleared. Takes owner/name, a URL or an rpo_ id',
    )
    .argument('<repo>', 'owner/name, github.com URL or repo id')
    .action(
      act(async (rt, [repo]) => {
        const api = await rt.api();
        const res = await api.DELETE('/projects/{project}/repos/{repo}', {
          params: { path: { project: rt.project(undefined), repo: String(repo) } },
        });
        await rt.call(res as never);
        rt.out.item('raw', { id: String(repo), removed: true }, () => `Unlinked ${String(repo)}\n`);
      }),
    );
  return cmd;
}
