import type { Kysely } from 'kysely';
import type { Dialect } from '../dialect.ts';
import { columnTypes } from './helpers.ts';

/**
 * What a webhook sends: `full` (the event as in `GET /events`, as before) or `notice` (only the event's seq, ids,
 * type and time, for receivers such as the bridge that must not hold issue content). Existing webhooks stay `full`.
 */
export function migration0008(dialect: Dialect) {
  const t = columnTypes(dialect);
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('webhooks')
        .addColumn('payload', t.text, (c) => c.notNull().defaultTo('full'))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('webhooks').dropColumn('payload').execute();
    },
  };
}
