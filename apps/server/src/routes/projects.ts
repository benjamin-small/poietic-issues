import { createRoute, z } from '@hono/zod-openapi';
import {
  createLabel,
  createProject,
  createStatus,
  deleteLabel,
  deleteStatus,
  getProject,
  issueInputJsonSchema,
  listLabels,
  listProjects,
  listStatuses,
  reorderStatuses,
  updateLabel,
  updateProject,
  updateStatus,
} from '@poietic-tech/issues-core';
import {
  CreateLabelInputSchema,
  CreateProjectInputSchema,
  CreateStatusInputSchema,
  LabelSchema,
  ProjectWithAccessSchema,
  StatusSchema,
  UpdateLabelInputSchema,
  UpdateProjectInputSchema,
  UpdateStatusInputSchema,
} from '@poietic-tech/issues-schema';
import type { TrackerApp } from '../env.ts';
import { BooleanQuery, errorResponses, json, jsonBody, refParam } from './common.ts';

const projectParam = z.object({
  project: refParam('project', 'Project key (e.g. `ENG`) or id.', 'ENG'),
});
const idParam = (example: string) => z.object({ id: refParam('id', 'Resource id.', example) });

export function registerProjectRoutes(app: TrackerApp) {
  let tags = ['Projects'];
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects',
      tags,
      summary: 'List projects',
      description:
        'Projects the caller can read: public ones (also for signed-out visitors), private ones they are a ' +
        "member of, and every project for admins. `myAccess` is the caller's level on each.",
      request: { query: z.object({ includeArchived: BooleanQuery }) },
      responses: {
        200: json(z.object({ data: z.array(ProjectWithAccessSchema) }), 'Projects'),
        ...errorResponses(),
      },
    }),
    async (c) => c.json({ data: await listProjects(c.get('ctx'), c.req.valid('query')) }, 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects',
      tags,
      summary: 'Create a project',
      description:
        'Admin only. Creates the default workflow (Backlog → Canceled) and shared list and board views. ' +
        '`visibility` defaults to `private`.',
      request: { body: jsonBody(CreateProjectInputSchema) },
      responses: {
        201: json(ProjectWithAccessSchema, 'Created'),
        ...errorResponses('FORBIDDEN', 'CONFLICT'),
      },
    }),
    async (c) => c.json(await createProject(c.get('ctx'), c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{project}',
      tags,
      summary: 'Get a project',
      description:
        'Public projects are readable by anyone, private ones by members, holders of a group grant, and admins; others get `NOT_FOUND`.',
      request: { params: projectParam },
      responses: {
        200: json(ProjectWithAccessSchema, 'Project'),
        ...errorResponses('NOT_FOUND'),
      },
    }),
    async (c) => c.json(await getProject(c.get('ctx'), c.req.valid('param').project), 200),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/projects/{project}',
      tags,
      summary: 'Update a project',
      description:
        'Name, description and visibility need manage. Archiving (`archived: true`) is admin only. ' +
        'Project keys are immutable.',
      request: { params: projectParam, body: jsonBody(UpdateProjectInputSchema) },
      responses: {
        200: json(ProjectWithAccessSchema, 'Updated'),
        ...errorResponses('FORBIDDEN', 'NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json(
        await updateProject(c.get('ctx'), c.req.valid('param').project, c.req.valid('json')),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{project}/schema/issue',
      tags,
      summary: 'JSON Schema for creating issues in this project',
      description:
        'Input JSON Schema for issue create/update with live enums: status names, label names, linked repos, ' +
        'assignable user handles (editors, managers and admins; `me` only for callers who can write; none for ' +
        'anonymous readers) and custom fields. Lets agents discover valid values in one call.',
      request: { params: projectParam },
      responses: {
        200: json(
          z.record(z.string(), z.unknown()).openapi('JsonSchema'),
          'JSON Schema (draft 2020-12)',
        ),
        ...errorResponses('NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json(await issueInputJsonSchema(c.get('ctx'), c.req.valid('param').project), 200),
  );

  tags = ['Statuses'];
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{project}/statuses',
      tags,
      summary: 'List workflow statuses (board columns) in order',
      request: { params: projectParam },
      responses: {
        200: json(z.object({ data: z.array(StatusSchema) }), 'Statuses'),
        ...errorResponses('NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json({ data: await listStatuses(c.get('ctx'), c.req.valid('param').project) }, 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{project}/statuses',
      tags,
      summary: 'Create a status',
      request: { params: projectParam, body: jsonBody(CreateStatusInputSchema) },
      responses: { 201: json(StatusSchema, 'Created'), ...errorResponses('NOT_FOUND', 'CONFLICT') },
    }),
    async (c) =>
      c.json(
        await createStatus(c.get('ctx'), c.req.valid('param').project, c.req.valid('json')),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{project}/statuses/reorder',
      tags,
      summary: 'Set the order of all statuses',
      request: {
        params: projectParam,
        body: jsonBody(
          z
            .object({
              ids: z
                .array(z.string())
                .openapi({ description: 'Every status id, in the new order.' }),
            })
            .openapi('ReorderStatusesInput'),
        ),
      },
      responses: {
        200: json(z.object({ data: z.array(StatusSchema) }), 'Reordered'),
        ...errorResponses('NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json(
        {
          data: await reorderStatuses(
            c.get('ctx'),
            c.req.valid('param').project,
            c.req.valid('json').ids,
          ),
        },
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/statuses/{id}',
      tags,
      summary: 'Update a status',
      request: {
        params: idParam('sts_01h455vb4pex5vsknk084sn02q'),
        body: jsonBody(UpdateStatusInputSchema),
      },
      responses: { 200: json(StatusSchema, 'Updated'), ...errorResponses('NOT_FOUND', 'CONFLICT') },
    }),
    async (c) =>
      c.json(await updateStatus(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/statuses/{id}',
      tags,
      summary: 'Delete a status',
      description:
        'If issues use the status, pass `moveIssuesTo` (status id or name) to move them first.',
      request: {
        params: idParam('sts_01h455vb4pex5vsknk084sn02q'),
        query: z.object({ moveIssuesTo: z.string().optional() }),
      },
      responses: { 200: json(StatusSchema, 'Deleted'), ...errorResponses('NOT_FOUND', 'CONFLICT') },
    }),
    async (c) =>
      c.json(await deleteStatus(c.get('ctx'), c.req.valid('param').id, c.req.valid('query')), 200),
  );

  tags = ['Labels'];
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{project}/labels',
      tags,
      summary: 'List labels',
      request: { params: projectParam },
      responses: {
        200: json(z.object({ data: z.array(LabelSchema) }), 'Labels'),
        ...errorResponses('NOT_FOUND'),
      },
    }),
    async (c) =>
      c.json({ data: await listLabels(c.get('ctx'), c.req.valid('param').project) }, 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{project}/labels',
      tags,
      summary: 'Create a label',
      request: { params: projectParam, body: jsonBody(CreateLabelInputSchema) },
      responses: { 201: json(LabelSchema, 'Created'), ...errorResponses('NOT_FOUND', 'CONFLICT') },
    }),
    async (c) =>
      c.json(
        await createLabel(c.get('ctx'), c.req.valid('param').project, c.req.valid('json')),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/labels/{id}',
      tags,
      summary: 'Update a label',
      request: {
        params: idParam('lbl_01h455vb4pex5vsknk084sn02q'),
        body: jsonBody(UpdateLabelInputSchema),
      },
      responses: { 200: json(LabelSchema, 'Updated'), ...errorResponses('NOT_FOUND', 'CONFLICT') },
    }),
    async (c) =>
      c.json(await updateLabel(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/labels/{id}',
      tags,
      summary: 'Delete a label (removes it from all issues)',
      request: { params: idParam('lbl_01h455vb4pex5vsknk084sn02q') },
      responses: { 200: json(LabelSchema, 'Deleted'), ...errorResponses('NOT_FOUND') },
    }),
    async (c) => c.json(await deleteLabel(c.get('ctx'), c.req.valid('param').id), 200),
  );
}
