import type { Schemas } from '@poietic-tech/issues-client';
import {
  type IssueFilter,
  isAdminRole,
  issuesPolicy,
  type SortSpec,
} from '@poietic-tech/issues-schema';
import { api, call, type Issue, type Project } from './api.ts';

/** `GET /me`: the signed-in user, or `{ anonymous: true }` for a signed-out visitor. */
export type Me = Schemas['Me'];

export function isSignedIn(me: Me | undefined): me is Schemas['User'] {
  return !!me && !('anonymous' in me);
}

/** A signed-in global admin, by the access policy's admin role (UI only: the server enforces it). */
export function isAdmin(me: Me | undefined): boolean {
  return isSignedIn(me) && isAdminRole(me.role);
}

/** The caller's level on a project (`myAccess`); anything below `write` is read-only (ADR 0021). */
export type Access = Project['myAccess'];
export const canWrite = (access: Access | undefined) =>
  access !== undefined && issuesPolicy.atLeast(access, 'write');
export const canManage = (access: Access | undefined) =>
  access !== undefined && issuesPolicy.atLeast(access, 'manage');

/** Query keys. Issues are cached by key (`ENG-42`), lists by project + query. */
export const keys = {
  me: ['me'] as const,
  authConfig: ['auth-config'] as const,
  projects: ['projects'] as const,
  project: (key: string) => ['project', key] as const,
  statuses: (key: string) => ['statuses', key] as const,
  labels: (key: string) => ['labels', key] as const,
  views: (key: string) => ['views', key] as const,
  members: (key: string) => ['members', key] as const,
  users: ['users'] as const,
  linkTypes: ['link-types'] as const,
  fields: (key: string) => ['fields', key] as const,
  issueLists: (project: string) => ['issues', project] as const,
  issueList: (project: string, query: IssueListQuery) => ['issues', project, query] as const,
  issue: (key: string) => ['issue', key] as const,
  comments: (key: string) => ['comments', key] as const,
  links: (key: string) => ['links', key] as const,
  attachments: (key: string) => ['attachments', key] as const,
  children: (key: string) => ['children', key] as const,
  activity: (key: string) => ['activity', key] as const,
  webhooks: ['webhooks'] as const,
  deliveries: (id: string) => ['webhooks', id, 'deliveries'] as const,
};

export interface IssueListQuery {
  filter: IssueFilter;
  sort: SortSpec[];
  includeDeleted?: boolean;
}

export const fetchers = {
  me: (): Promise<Me> => call(api.GET('/me')),
  authConfig: () => call(api.GET('/auth/config')),
  projects: async () => (await call(api.GET('/projects', { params: { query: {} } }))).data,
  project: (key: string) =>
    call(api.GET('/projects/{project}', { params: { path: { project: key } } })),
  members: async (key: string) =>
    (await call(api.GET('/projects/{project}/members', { params: { path: { project: key } } })))
      .data,
  statuses: async (key: string) =>
    (await call(api.GET('/projects/{project}/statuses', { params: { path: { project: key } } })))
      .data,
  labels: async (key: string) =>
    (await call(api.GET('/projects/{project}/labels', { params: { path: { project: key } } })))
      .data,
  views: async (key: string) =>
    (await call(api.GET('/projects/{project}/views', { params: { path: { project: key } } }))).data,
  users: async () => (await call(api.GET('/users', { params: { query: {} } }))).data,
  linkTypes: async () => (await call(api.GET('/link-types'))).data,
  fields: async (key: string) =>
    (
      await call(
        api.GET('/projects/{project}/fields', { params: { path: { project: key }, query: {} } }),
      )
    ).data,
  /**
   * Every issue matching a query (pages through the results; views show whole projects). Uses the `GET` listing,
   * which signed-out visitors may call too (anonymous requests are `GET`-only).
   */
  issues: async (project: string, query: IssueListQuery): Promise<Issue[]> => {
    const all: Issue[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Issue[]; nextCursor: string | null } = await call(
        api.GET('/projects/{project}/issues', {
          params: {
            path: { project },
            query: {
              limit: 200,
              ...(query.filter.conditions.length > 0 && { filter: JSON.stringify(query.filter) }),
              ...(query.sort.length > 0 && {
                sort: query.sort.map((s) => `${s.dir === 'desc' ? '-' : ''}${s.field}`).join(','),
              }),
              ...(query.includeDeleted && { includeDeleted: 'true' as const }),
              ...(cursor && { cursor }),
            },
          },
        }),
      );
      all.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor && all.length < 5000);
    return all;
  },
  issue: (key: string) => call(api.GET('/issues/{issue}', { params: { path: { issue: key } } })),
  comments: async (key: string) =>
    (
      await call(
        api.GET('/issues/{issue}/comments', { params: { path: { issue: key }, query: {} } }),
      )
    ).data,
  attachments: async (key: string) =>
    (await call(api.GET('/issues/{issue}/attachments', { params: { path: { issue: key } } }))).data,
  links: async (key: string) =>
    (await call(api.GET('/issues/{issue}/links', { params: { path: { issue: key } } }))).data,
  children: async (key: string) =>
    (await call(api.GET('/issues/{issue}/children', { params: { path: { issue: key } } }))).data,
  activity: async (key: string) =>
    (
      await call(
        api.GET('/issues/{issue}/activity', {
          params: { path: { issue: key }, query: { limit: 200 } },
        }),
      )
    ).data,
};
