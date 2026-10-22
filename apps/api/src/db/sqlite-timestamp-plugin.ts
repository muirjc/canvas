/**
 * canvas-d54: SQLite has no timestamp type -- this schema's timestamp columns are TEXT, and a
 * `DEFAULT CURRENT_TIMESTAMP` value is stored as 'YYYY-MM-DD HH:MM:SS': UTC, but with no zone
 * marker. The API returned it verbatim, and a browser's `new Date()` reads a zone-less string as
 * LOCAL time, so every DB-defaulted timestamp (created_at, updated_at, ...) showed shifted by the
 * viewer's UTC offset. Postgres returns real Dates, serialized with 'Z', so it was never affected.
 *
 * This normalizes those values to ISO 8601 UTC on read, for SQLite only. Values the app writes
 * itself are already ISO with 'Z' (SqliteValueCoercionPlugin binds a Date as `toISOString()`) and
 * pass through unchanged. Like SqliteJsonColumnsPlugin, it's keyed by column name -- this schema's
 * fixed set of timestamp columns (schema.ts's Timestamp/GeneratedTimestamp), plus the one alias a
 * query selects a timestamp under -- so a text column that merely looks like a date is never
 * touched; a value is only rewritten when it is also in SQLite's own format.
 */
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely';

const TIMESTAMP_COLUMN_NAMES = new Set([
  'created_at',
  'updated_at',
  'deleted_at',
  'restored_at',
  'published_at',
  'retired_at',
  'applied_at',
  // canvas-ez1.4
  'occurred_at',
  'locked_at',
  // sharing.service.ts selects 'sg.created_at as shared_at'.
  'shared_at',
]);

const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** 'YYYY-MM-DD HH:MM:SS[.fff]' (SQLite CURRENT_TIMESTAMP, UTC) -> 'YYYY-MM-DDTHH:MM:SS[.fff]Z';
 *  anything else is returned unchanged. */
export function normalizeSqliteTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = SQLITE_TIMESTAMP.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : value;
}

export class SqliteTimestampPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows.map((row) => {
      let transformed: UnknownRow | undefined;
      for (const key of TIMESTAMP_COLUMN_NAMES) {
        const value = row[key];
        const normalized = normalizeSqliteTimestamp(value);
        if (normalized !== value) (transformed ??= { ...row })[key] = normalized;
      }
      return transformed ?? row;
    });
    return { ...args.result, rows };
  }
}
