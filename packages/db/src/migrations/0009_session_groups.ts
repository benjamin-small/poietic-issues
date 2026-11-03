import type { Kysely } from 'kysely';
import type { Dialect } from '../dialect.ts';
import { columnTypes } from './helpers.ts';

/**
 * The auth.poietic.tech groups a web session was signed in with, as a JSON array of strings. Sessions that predate
 * the column have none (`'[]'`), so they grant nothing through groups until the user signs in again.
 */
export function migration0009(dialect: Dialect) {
  const t = columnTypes(dialect);
  return {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('sessions')
        .addColumn('groups', t.text, (c) => c.notNull().defaultTo('[]'))
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('sessions').dropColumn('groups').execute();
    },
  };
}
