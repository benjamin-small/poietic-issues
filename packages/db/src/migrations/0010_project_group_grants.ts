import type { Kysely } from 'kysely';
import type { Dialect } from '../dialect.ts';
import { columnTypes, createTable } from './helpers.ts';

/**
 * A project can grant a role to an auth.poietic.tech group (ADR 0031 layer 3). `group_slug` is the group's slug
 * from the caller's token; no table holds groups here, since auth owns them. Grants only add access.
 */
export function migration0010(dialect: Dialect) {
  const t = columnTypes(dialect);
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await createTable(db, dialect, 'project_group_grants')
        .addColumn('project_id', t.id, (c) =>
          c.notNull().references('projects.id').onDelete('cascade'),
        )
        .addColumn('group_slug', t.text, (c) => c.notNull())
        .addColumn('role', t.text, (c) => c.notNull())
        .addColumn('created_at', t.ts, (c) => c.notNull())
        .addColumn('updated_at', t.ts, (c) => c.notNull())
        .addPrimaryKeyConstraint('project_group_grants_pk', ['project_id', 'group_slug'])
        .execute();
      await db.schema
        .createIndex('project_group_grants_group_idx')
        .on('project_group_grants')
        .column('group_slug')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropTable('project_group_grants').execute();
    },
  };
}
