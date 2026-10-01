/**
 * canvas-jtm.7: node-postgres auto-deserializes JSONB columns on read (a real `object`/`array`
 * comes back, not text) — `schema.ts`'s `JsonColumn<T>`/`GeneratedJsonColumn<T>` Select type is
 * `T` specifically because of this, and every read call site (`standard.service.ts`,
 * `diagram.service.ts`, `diagram-chat.service.ts`, ...) relies on it, casting/using the selected
 * value directly with no `JSON.parse()` of its own. better-sqlite3 has no such behavior — a JSON
 * column is just `TEXT` there, and a SELECT hands back the raw string exactly as stored. The write
 * side needs no SQLite-specific handling: every call site already calls `JSON.stringify()`
 * explicitly before writing (required for Postgres too, per `JsonColumn<T>`'s own doc comment —
 * node-postgres only auto-stringifies plain objects, not the JS arrays every JSON column here
 * actually stores), and a plain string binds into a SQLite TEXT column natively.
 *
 * This plugin closes that one-directional gap for SELECT/RETURNING results only, scoped to this
 * schema's fixed, enumerable set of JSON column names (each globally unique across every table —
 * confirmed via `schema.ts`), so no table/alias context is needed to tell a JSON column from an
 * ordinary TEXT one. A column selected under a different alias (e.g. `.select('tool_calls as x')`)
 * would not be recognized — none of this codebase's call sites do that for a JSON column, a
 * disclosed, verified-absent limitation rather than a silent gap.
 */
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely';

const JSON_COLUMN_NAMES = new Set([
  'allowed_icon_library_refs',
  'color_palette',
  'font_constraints',
  'last_validation_result',
  'violations_at_save',
  'tool_calls',
]);

export class SqliteJsonColumnsPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows.map((row) => {
      let transformed: UnknownRow | undefined;
      for (const key of JSON_COLUMN_NAMES) {
        const value = row[key];
        if (typeof value === 'string') {
          (transformed ??= { ...row })[key] = JSON.parse(value);
        }
      }
      return transformed ?? row;
    });
    return { ...args.result, rows };
  }
}
