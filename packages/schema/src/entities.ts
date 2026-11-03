import { z } from 'zod';
import {
  ColorSchema,
  DateOnlySchema,
  MetadataSchema,
  nullableRef,
  TimestampSchema,
} from './common.ts';

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export const UserKindSchema = z
  .enum(['human', 'agent', 'system'])
  .meta({ description: 'Humans and AI agents are both first-class actors; `system` is internal.' });
export const UserRoleSchema = z.enum(['admin', 'member']);

export const UserOwnerSchema = z
  .object({
    id: z.string().meta({ example: 'usr_01h455vb4pex5vsknk084sn02q' }),
    handle: z.string().meta({ example: 'ada' }),
  })
  .meta({ id: 'UserOwner' });
export type UserOwner = z.infer<typeof UserOwnerSchema>;

export const UserSummarySchema = z
  .object({
    id: z.string().meta({ example: 'usr_01h455vb4pex5vsknk084sn02q' }),
    handle: z.string().meta({ example: 'ada' }),
    name: z.string().meta({ example: 'Ada Lovelace' }),
    kind: UserKindSchema,
    avatarUrl: z.string().nullable(),
    owner: nullableRef(UserOwnerSchema).optional().meta({
      description:
        'For an agent signed in through SSO, the user it acts for; null otherwise. Absent from issue snapshots recorded before owners existed.',
    }),
  })
  .meta({ id: 'UserSummary' });
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const UserSchema = UserSummarySchema.extend({
  email: z.string().nullable(),
  role: UserRoleSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  deactivatedAt: TimestampSchema.nullable(),
  ownerId: z.string().nullable().meta({
    description: 'For an agent signed in through SSO, the user it acts for; null otherwise.',
  }),
}).meta({ id: 'User' });
export type User = z.infer<typeof UserSchema>;

/** `GET /me`: the signed-in user, or `{ anonymous: true }` for a visitor without credentials. */
export const MeSchema = z
  .union([UserSchema, z.object({ anonymous: z.literal(true) }).meta({ id: 'AnonymousMe' })])
  .meta({ id: 'Me' });
export type Me = z.infer<typeof MeSchema>;

export const HandleSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{1,38}$/i, 'handle must be 2–39 chars of letters, digits, "-" or "_"')
  .transform((v) => v.toLowerCase());

export const CreateUserInputSchema = z
  .object({
    handle: HandleSchema,
    name: z.string().min(1).max(100),
    email: z.email().nullish(),
    kind: z.enum(['human', 'agent']).default('human'),
    role: UserRoleSchema.default('member'),
    avatarUrl: z.url().nullish(),
  })
  .meta({ id: 'CreateUserInput' });
export type CreateUserInput = z.input<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z
  .object({
    handle: HandleSchema.meta({
      description:
        'Rename the user (admin only). Existing history refers to users by id, so it follows the rename.',
    }),
    name: z.string().min(1).max(100),
    email: z.email().nullable(),
    role: UserRoleSchema,
    avatarUrl: z.url().nullable(),
    deactivated: z
      .boolean()
      .meta({ description: 'Deactivate (true) or reactivate (false) the user.' }),
  })
  .partial()
  .meta({ id: 'UpdateUserInput' });
export type UpdateUserInput = z.input<typeof UpdateUserInputSchema>;

// ---------------------------------------------------------------------------
// Projects, statuses, labels
// ---------------------------------------------------------------------------

export const ProjectKeySchema = z
  .string()
  .transform((v) => v.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'key must be 2–10 chars: a letter then letters/digits'),
  )
  .meta({ example: 'ENG' });

export const ProjectVisibilitySchema = z.enum(['public', 'private']).meta({
  id: 'ProjectVisibility',
  description: '`public`: anyone can read, even signed out. `private`: members and admins only.',
});
export type ProjectVisibility = z.infer<typeof ProjectVisibilitySchema>;

export const ProjectRoleSchema = z.enum(['viewer', 'editor', 'manager']).meta({
  id: 'ProjectRole',
  description:
    '`viewer` reads, `editor` also writes, `manager` also manages settings, repos and members.',
});
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const ProjectAccessSchema = z
  .enum(['read', 'write', 'manage'])
  .meta({ id: 'ProjectAccess' });
export type ProjectAccess = z.infer<typeof ProjectAccessSchema>;

export const ProjectRepoSchema = z
  .object({
    id: z.string().meta({ example: 'rpo_01h455vb4pex5vsknk084sn02q' }),
    owner: z.string().meta({ example: 'acme' }),
    name: z.string().meta({ example: 'app' }),
    fullName: z.string().meta({ example: 'acme/app' }),
    url: z.string().meta({ example: 'https://github.com/acme/app' }),
    createdAt: TimestampSchema,
  })
  .meta({ id: 'ProjectRepo' });
export type ProjectRepo = z.infer<typeof ProjectRepoSchema>;

export const AddProjectRepoInputSchema = z
  .object({
    repo: z
      .string()
      .meta({ description: '`owner/name` or a github.com URL.', example: 'acme/app' }),
  })
  .meta({ id: 'AddProjectRepoInput' });
export type AddProjectRepoInput = z.input<typeof AddProjectRepoInputSchema>;

export const ProjectSchema = z
  .object({
    id: z.string(),
    key: z.string().meta({ description: 'Immutable issue-key prefix.', example: 'ENG' }),
    name: z.string(),
    description: z.string(),
    visibility: ProjectVisibilitySchema,
    repos: z.array(ProjectRepoSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'Project' });
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectWithAccessSchema = ProjectSchema.extend({
  myAccess: ProjectAccessSchema.meta({ description: "The caller's access to this project." }),
}).meta({ id: 'ProjectWithAccess' });
export type ProjectWithAccess = z.infer<typeof ProjectWithAccessSchema>;

export const CreateProjectInputSchema = z
  .object({
    key: ProjectKeySchema,
    name: z.string().min(1).max(100),
    description: z.string().max(10_000).default(''),
    visibility: ProjectVisibilitySchema.default('private'),
  })
  .meta({ id: 'CreateProjectInput' });
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(10_000),
    archived: z.boolean(),
    visibility: ProjectVisibilitySchema,
  })
  .partial()
  .meta({ id: 'UpdateProjectInput' });
export type UpdateProjectInput = z.input<typeof UpdateProjectInputSchema>;

export const ProjectMemberSchema = z
  .object({
    user: UserSummarySchema,
    role: ProjectRoleSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'ProjectMember' });
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const AddProjectMemberInputSchema = z
  .object({
    user: z.string().meta({ description: 'User id, handle or `me`.', example: '@ada' }),
    role: ProjectRoleSchema,
  })
  .meta({ id: 'AddProjectMemberInput' });
export type AddProjectMemberInput = z.input<typeof AddProjectMemberInputSchema>;

export const UpdateProjectMemberInputSchema = z
  .object({ role: ProjectRoleSchema })
  .meta({ id: 'UpdateProjectMemberInput' });
export type UpdateProjectMemberInput = z.input<typeof UpdateProjectMemberInputSchema>;

/** An auth.poietic.tech group slug, as a project can name it in a grant. */
export const GroupSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,39}$/,
    'group must be 1–40 chars of a-z, 0-9 or "-", not starting with "-"',
  )
  .meta({ id: 'GroupSlug', description: 'An auth group slug.', example: 'team' });

export const ProjectGroupGrantSchema = z
  .object({
    group: GroupSlugSchema,
    role: ProjectRoleSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'ProjectGroupGrant' });
export type ProjectGroupGrant = z.infer<typeof ProjectGroupGrantSchema>;

export const SetProjectGroupGrantInputSchema = z
  .object({ role: ProjectRoleSchema })
  .meta({ id: 'SetProjectGroupGrantInput' });
export type SetProjectGroupGrantInput = z.input<typeof SetProjectGroupGrantInputSchema>;

export const STATUS_CATEGORIES = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export const StatusCategorySchema = z
  .enum(STATUS_CATEGORIES)
  .meta({ description: 'Semantic bucket of a status; drives startedAt/completedAt/canceledAt.' });
export type StatusCategory = z.infer<typeof StatusCategorySchema>;

export const StatusSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string().meta({ example: 'In Progress' }),
    category: StatusCategorySchema,
    color: ColorSchema,
    position: z.number().int(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'Status' });
export type Status = z.infer<typeof StatusSchema>;

export const StatusSummarySchema = StatusSchema.pick({
  id: true,
  name: true,
  category: true,
  color: true,
}).meta({ id: 'StatusSummary' });
export type StatusSummary = z.infer<typeof StatusSummarySchema>;

export const CreateStatusInputSchema = z
  .object({
    name: z.string().min(1).max(50),
    category: StatusCategorySchema,
    color: ColorSchema.default('#8a8f98'),
    position: z.number().int().min(0).optional().meta({ description: 'Defaults to last.' }),
  })
  .meta({ id: 'CreateStatusInput' });
export type CreateStatusInput = z.input<typeof CreateStatusInputSchema>;

export const UpdateStatusInputSchema = z
  .object({ name: z.string().min(1).max(50), category: StatusCategorySchema, color: ColorSchema })
  .partial()
  .meta({ id: 'UpdateStatusInput' });
export type UpdateStatusInput = z.input<typeof UpdateStatusInputSchema>;

export const LabelSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string().meta({ example: 'bug' }),
    color: ColorSchema,
    description: z.string(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .meta({ id: 'Label' });
export type Label = z.infer<typeof LabelSchema>;

export const LabelSummarySchema = LabelSchema.pick({ id: true, name: true, color: true }).meta({
  id: 'LabelSummary',
});
export type LabelSummary = z.infer<typeof LabelSummarySchema>;

export const CreateLabelInputSchema = z
  .object({
    name: z.string().min(1).max(50),
    color: ColorSchema.default('#8a8f98'),
    description: z.string().max(500).default(''),
  })
  .meta({ id: 'CreateLabelInput' });
export type CreateLabelInput = z.input<typeof CreateLabelInputSchema>;

// Explicit (not CreateLabelInputSchema.partial()): `.partial()` keeps defaults, which would reset omitted fields.
export const UpdateLabelInputSchema = z
  .object({ name: z.string().min(1).max(50), color: ColorSchema, description: z.string().max(500) })
  .partial()
  .meta({ id: 'UpdateLabelInput' });
export type UpdateLabelInput = z.input<typeof UpdateLabelInputSchema>;

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export const PRIORITY_LABELS = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;
export const PrioritySchema = z
  .number()
  .int()
  .min(0)
  .max(4)
  .meta({ description: '0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low.', example: 2 });

export const IssueRefSchema = z
  .object({ id: z.string(), key: z.string().meta({ example: 'ENG-7' }), title: z.string() })
  .meta({ id: 'IssueRef' });
export type IssueRef = z.infer<typeof IssueRefSchema>;

export const CustomFieldValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
  .meta({
    id: 'CustomFieldValue',
    description:
      'Value of a custom field: string (text, url, date YYYY-MM-DD, select option value, user id), number, boolean, or string[] (multi_select option values).',
  });
export type CustomFieldValue = z.infer<typeof CustomFieldValueSchema>;

export const IssueSchema = z
  .object({
    id: z.string().meta({ example: 'iss_01h455vb4pex5vsknk084sn02q' }),
    key: z.string().meta({ description: 'Human key, stable forever.', example: 'ENG-42' }),
    number: z.number().int(),
    projectId: z.string(),
    title: z.string(),
    description: z.string().meta({ description: 'Markdown.' }),
    statusId: z.string(),
    status: StatusSummarySchema,
    priority: PrioritySchema,
    assigneeId: z.string().nullable(),
    assignee: nullableRef(UserSummarySchema),
    creatorId: z.string(),
    creator: UserSummarySchema,
    parentId: z.string().nullable(),
    parent: nullableRef(IssueRefSchema),
    repo: z.string().nullable().meta({
      description: "Linked GitHub repository (`owner/name`), one of the project's repos.",
      example: 'acme/app',
    }),
    labelIds: z.array(z.string()),
    labels: z.array(LabelSummarySchema),
    estimate: z.number().nullable(),
    dueDate: DateOnlySchema.nullable(),
    rank: z.string().meta({ description: 'Opaque ordering key within a status column.' }),
    customFields: z
      .record(z.string(), CustomFieldValueSchema)
      .meta({ description: 'Custom field values keyed by field key.' }),
    metadata: MetadataSchema,
    commentCount: z.number().int(),
    childCount: z.number().int(),
    version: z.number().int().meta({
      description: 'Incremented on every change. Send as If-Match to avoid lost updates.',
    }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    canceledAt: TimestampSchema.nullable(),
    deletedAt: TimestampSchema.nullable().meta({
      description: 'Set when the issue is in the trash.',
    }),
  })
  .meta({ id: 'Issue' });
export type Issue = z.infer<typeof IssueSchema>;

const issueWritable = {
  title: z.string().trim().min(1).max(500),
  description: z.string().max(100_000),
  status: z.string().meta({
    description: 'Status id or name (case-insensitive) within the project.',
    example: 'In Progress',
  }),
  priority: PrioritySchema,
  assignee: z.string().nullable().meta({
    description: 'User id, handle (with or without @), `me`, or null to unassign.',
    example: '@ada',
  }),
  parent: z
    .string()
    .nullable()
    .meta({ description: 'Parent issue key or id, or null.', example: 'ENG-1' }),
  repo: z
    .string()
    .nullable()
    .meta({ description: "One of the project's repos (`owner/name`, URL or id), or null." }),
  labels: z.array(z.string()).meta({ description: 'Label ids or names; replaces the full set.' }),
  estimate: z.number().min(0).nullable(),
  dueDate: DateOnlySchema.nullable(),
  customFields: z.record(z.string(), CustomFieldValueSchema).meta({
    description: 'Custom field values by key; null clears a field. Merged with existing values.',
  }),
  metadata: MetadataSchema,
};

export const CreateIssueInputSchema = z
  .object({
    ...issueWritable,
    description: issueWritable.description.default(''),
    priority: PrioritySchema.default(0),
    status: issueWritable.status
      .optional()
      .meta({ description: 'Defaults to the first backlog/unstarted status.' }),
    assignee: issueWritable.assignee.optional(),
    parent: issueWritable.parent.optional(),
    repo: issueWritable.repo.optional(),
    labels: issueWritable.labels.default([]),
    estimate: issueWritable.estimate.optional(),
    dueDate: issueWritable.dueDate.optional(),
    customFields: issueWritable.customFields.default({}),
    metadata: MetadataSchema.default({}),
  })
  .meta({ id: 'CreateIssueInput' });
export type CreateIssueInput = z.input<typeof CreateIssueInputSchema>;

export const UpdateIssueInputSchema = z
  .object({
    ...issueWritable,
    addLabels: z.array(z.string()).meta({ description: 'Label ids or names to add.' }),
    removeLabels: z.array(z.string()).meta({ description: 'Label ids or names to remove.' }),
    expectedVersion: z
      .number()
      .int()
      .meta({ description: 'Fail with VERSION_MISMATCH unless the issue is at this version.' }),
  })
  .partial()
  .meta({ id: 'UpdateIssueInput' });
export type UpdateIssueInput = z.input<typeof UpdateIssueInputSchema>;

export const MoveIssueInputSchema = z
  .object({
    status: z
      .string()
      .optional()
      .meta({ description: 'Target status id or name; defaults to the current status.' }),
    afterId: z
      .string()
      .nullish()
      .meta({ description: 'Place directly after this issue (id or key) in the target column.' }),
    beforeId: z.string().nullish().meta({
      description: 'Place directly before this issue (id or key). Omit both to move to the top.',
    }),
    position: z
      .enum(['top', 'bottom'])
      .optional()
      .meta({ description: 'Alternative to afterId/beforeId.' }),
    expectedVersion: z.number().int().optional(),
  })
  .meta({ id: 'MoveIssueInput' });
export type MoveIssueInput = z.input<typeof MoveIssueInputSchema>;

// ---------------------------------------------------------------------------
// Comments & links
// ---------------------------------------------------------------------------

export const CommentSchema = z
  .object({
    id: z.string(),
    issueId: z.string(),
    authorId: z.string(),
    author: UserSummarySchema,
    body: z.string().meta({ description: 'Markdown.' }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    editedAt: TimestampSchema.nullable(),
    deletedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'Comment' });
export type Comment = z.infer<typeof CommentSchema>;

export const CreateCommentInputSchema = z
  .object({ body: z.string().trim().min(1).max(100_000) })
  .meta({ id: 'CreateCommentInput' });
export type CreateCommentInput = z.input<typeof CreateCommentInputSchema>;
export const UpdateCommentInputSchema = CreateCommentInputSchema.meta({ id: 'UpdateCommentInput' });
export type UpdateCommentInput = z.input<typeof UpdateCommentInputSchema>;

export const LinkTypeSchema = z
  .object({
    id: z.string(),
    key: z.string().meta({ example: 'blocks' }),
    name: z.string().meta({ example: 'Blocks' }),
    outwardLabel: z.string().meta({ example: 'blocks' }),
    inwardLabel: z.string().meta({ example: 'is blocked by' }),
    symmetric: z.boolean(),
    builtIn: z.boolean(),
  })
  .meta({ id: 'LinkType' });
export type LinkType = z.infer<typeof LinkTypeSchema>;

export const LinkDirectionSchema = z.enum(['outward', 'inward']);

/** A link as seen from one issue's perspective. */
export const IssueLinkSchema = z
  .object({
    id: z.string(),
    type: z.string().meta({ description: 'Link type key.', example: 'blocks' }),
    direction: LinkDirectionSchema.meta({
      description:
        '`outward`: this issue is the source ("blocks"); `inward`: it is the target ("is blocked by").',
    }),
    label: z.string().meta({
      description: "Relation text from this issue's perspective.",
      example: 'is blocked by',
    }),
    issue: IssueRefSchema.extend({ status: StatusSummarySchema }).meta({
      description: 'The other issue.',
    }),
    createdAt: TimestampSchema,
  })
  .meta({ id: 'IssueLink' });
export type IssueLink = z.infer<typeof IssueLinkSchema>;

export const CreateLinkInputSchema = z
  .object({
    type: z.string().meta({ description: 'Link type key or id.', example: 'blocks' }),
    target: z.string().meta({ description: 'The other issue (key or id).', example: 'ENG-7' }),
    direction: LinkDirectionSchema.default('outward').meta({
      description: '`outward`: "this <type> target"; `inward`: "target <type> this".',
    }),
  })
  .meta({ id: 'CreateLinkInput' });
export type CreateLinkInput = z.input<typeof CreateLinkInputSchema>;
