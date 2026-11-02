import type { Generated } from 'kysely';

/**
 * Row types for every table, shared by both dialects.
 *
 * Storage conventions (see ADR 0002):
 * - `Timestamp`: ISO-8601 UTC string with millisecond precision (`timestamptz(3)` on Postgres, TEXT on SQLite).
 *   Always produced by the application clock, never by database defaults.
 * - `DateOnly`: `YYYY-MM-DD` (`date` on Postgres, TEXT on SQLite).
 * - `JsonText`: JSON serialized as a string on write; read back as a string on both dialects and parsed by row mappers.
 * - `Bool`: written as a JS boolean (converted to 0/1 for SQLite by `SqliteBooleanPlugin`); read back as
 *   boolean (Postgres) or 0/1 (SQLite) — always normalize with `toBool()`.
 */
export type Timestamp = string;
export type DateOnly = string;
export type JsonText = string;
export type Bool = boolean | number;

export interface UsersTable {
  id: string;
  handle: string;
  name: string;
  email: string | null;
  kind: 'human' | 'agent' | 'system';
  role: 'admin' | 'member';
  avatar_url: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  deactivated_at: Timestamp | null;
  /** The human an agent acts for (`kind = 'agent'`); null otherwise. */
  owner_id: string | null;
}

export interface SessionsTable {
  /** sha256 of the cookie value. */
  id: string;
  user_id: string;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface UserIdentitiesTable {
  /** The SSO issuer (`iss`), e.g. `https://auth.example.com`. */
  issuer: string;
  /** The issuer's stable user id (`sub`). */
  subject: string;
  user_id: string;
  created_at: Timestamp;
}

export interface ProjectsTable {
  id: string;
  key: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  next_issue_number: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export interface ProjectMembersTable {
  project_id: string;
  user_id: string;
  role: 'viewer' | 'editor' | 'manager';
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProjectReposTable {
  id: string;
  project_id: string;
  owner: string;
  name: string;
  created_at: Timestamp;
}

export type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export interface StatusesTable {
  id: string;
  project_id: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LabelsTable {
  id: string;
  project_id: string;
  name: string;
  color: string;
  description: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export interface IssuesTable {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status_id: string;
  priority: number;
  assignee_id: string | null;
  creator_id: string;
  parent_id: string | null;
  repo_id: string | null;
  estimate: number | null;
  due_date: DateOnly | null;
  rank: string;
  metadata: JsonText;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  canceled_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export interface IssueLabelsTable {
  issue_id: string;
  label_id: string;
  created_at: Timestamp;
}

export interface CommentsTable {
  id: string;
  issue_id: string;
  author_id: string;
  parent_comment_id: string | null;
  body: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export interface LinkTypesTable {
  id: string;
  key: string;
  name: string;
  outward_label: string;
  inward_label: string;
  symmetric: Bool;
  built_in: Bool;
  created_at: Timestamp;
}

export interface IssueLinksTable {
  id: string;
  type_id: string;
  source_id: string;
  target_id: string;
  created_by: string;
  created_at: Timestamp;
}

export type CustomFieldType =
  'text' | 'number' | 'date' | 'boolean' | 'select' | 'multi_select' | 'user' | 'url';

export interface CustomFieldsTable {
  id: string;
  project_id: string;
  key: string;
  name: string;
  description: string;
  type: CustomFieldType;
  config: JsonText;
  position: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export interface CustomFieldOptionsTable {
  id: string;
  field_id: string;
  value: string;
  label: string;
  color: string;
  position: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

/** EAV storage for custom field values: exactly one `v_*` column is set per row (multi_select → one row per option). */
export interface IssueFieldValuesTable {
  id: string;
  issue_id: string;
  field_id: string;
  v_text: string | null;
  v_number: number | null;
  v_date: DateOnly | null;
  v_bool: Bool | null;
  v_user_id: string | null;
  v_option_id: string | null;
  created_at: Timestamp;
}

export interface AttachmentsTable {
  id: string;
  issue_id: string;
  comment_id: string | null;
  uploader_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  storage_key: string;
  created_at: Timestamp;
  deleted_at: Timestamp | null;
}

export interface ViewsTable {
  id: string;
  project_id: string;
  owner_id: string | null;
  name: string;
  layout: 'list' | 'board';
  config: JsonText;
  position: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EventsTable {
  seq: Generated<number>;
  id: string;
  type: string;
  actor_id: string | null;
  project_id: string | null;
  issue_id: string | null;
  data: JsonText;
  created_at: Timestamp;
}

export interface WebhooksTable {
  id: string;
  url: string;
  secret: string;
  description: string;
  event_types: JsonText;
  project_id: string | null;
  active: Bool;
  failure_count: number;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  disabled_at: Timestamp | null;
  payload: 'full' | 'notice';
}

export type WebhookDeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'dead';

export interface WebhookDeliveriesTable {
  id: string;
  webhook_id: string;
  event_seq: number;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: Timestamp;
  locked_until: Timestamp | null;
  last_status_code: number | null;
  last_error: string | null;
  last_attempt_at: Timestamp | null;
  last_duration_ms: number | null;
  last_response: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface IdempotencyKeysTable {
  actor_id: string;
  key: string;
  method: string;
  path: string;
  request_hash: string;
  status_code: number | null;
  response: JsonText | null;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface SystemStateTable {
  key: string;
  value: JsonText;
  updated_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  user_identities: UserIdentitiesTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  project_repos: ProjectReposTable;
  statuses: StatusesTable;
  labels: LabelsTable;
  issues: IssuesTable;
  issue_labels: IssueLabelsTable;
  comments: CommentsTable;
  link_types: LinkTypesTable;
  issue_links: IssueLinksTable;
  custom_fields: CustomFieldsTable;
  custom_field_options: CustomFieldOptionsTable;
  issue_field_values: IssueFieldValuesTable;
  attachments: AttachmentsTable;
  views: ViewsTable;
  events: EventsTable;
  webhooks: WebhooksTable;
  webhook_deliveries: WebhookDeliveriesTable;
  idempotency_keys: IdempotencyKeysTable;
  system_state: SystemStateTable;
}
