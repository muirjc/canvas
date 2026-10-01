/**
 * Dialect-aware SQL fragments (canvas-jtm Phase 0 stub — see
 * /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md).
 *
 * Postgres-only today, matching `db/client.ts`'s own current scope. Each helper exists so later
 * phases have exactly one place to add the SQLite-dialect branch when `config.dbClient` exists
 * (canvas-jtm.6) — call sites converted in the meantime (Phase 1/2) should use these instead of
 * inlining `ILIKE`/`now()`/`to_char` directly, so this file stays the only place that changes when
 * SQLite support actually lands, rather than every call site needing a second pass.
 */
import { sql, type Expression, type RawBuilder } from 'kysely';

/** The current timestamp, as a SQL expression usable in an insert/update — replaces inline
 *  `now()`. Postgres and SQLite both understand `CURRENT_TIMESTAMP` (ANSI SQL), so this one
 *  doesn't need a dialect branch at all once SQLite support lands. */
export function currentTimestamp(): RawBuilder<Date> {
  return sql<Date>`CURRENT_TIMESTAMP`;
}

/**
 * A case-insensitive "contains" filter — replaces inline `ILIKE`.
 *
 * Postgres-only for now: compiles straight to `<column> ILIKE <pattern>`. SQLite has no `ILIKE`;
 * its default `LIKE` is already ASCII-case-insensitive, so the SQLite branch (added in
 * canvas-jtm.4, alongside the rest of the Postgres-specific construct cleanup) will compile to
 * plain `LIKE` instead — not full Unicode case-folding parity with Postgres's `ILIKE`, a disclosed
 * gap, see the plan's Risks section.
 *
 * `pattern` is the full `%...%`/`%...` wildcard pattern, matching how call sites build it today
 * (e.g. `` `%${search}%` ``) — this helper only swaps the operator, not the pattern-building.
 */
export function caseInsensitiveLike(column: Expression<string>, pattern: string): RawBuilder<boolean> {
  return sql<boolean>`${column} ilike ${pattern}`;
}

/**
 * Formats a timestamp column as `YYYY-MM-DD` — replaces inline `to_char(col, 'YYYY-MM-DD')`
 * (`diagrams/version.service.ts:74`, found during the canvas-jtm audit specifically because it
 * rides along with that file's `ILIKE` call — `to_char` is its own, separate Postgres-only
 * construct, not an `ILIKE` variant).
 *
 * Postgres-only for now; SQLite's equivalent is `strftime('%Y-%m-%d', col)` (canvas-jtm.4).
 */
export function dateToYMD(column: Expression<Date>): RawBuilder<string> {
  return sql<string>`to_char(${column}, 'YYYY-MM-DD')`;
}
