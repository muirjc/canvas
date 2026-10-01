/**
 * Dialect-aware SQL fragments (canvas-jtm — see
 * /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md). Each helper reads
 * `config.dbClient` itself (cheap — `loadConfig()` just reads env vars, the same pattern
 * `db/client.ts`/`db/pool.ts` already use) so call sites stay dialect-agnostic one-liners.
 */
import { sql, type Expression, type RawBuilder } from 'kysely';
import { loadConfig } from '../config.js';

/** The current timestamp, as a SQL expression usable in an insert/update — replaces inline
 *  `now()`. Postgres and SQLite both understand `CURRENT_TIMESTAMP` (ANSI SQL), so this one
 *  doesn't need a dialect branch at all once SQLite support lands. */
export function currentTimestamp(): RawBuilder<Date> {
  return sql<Date>`CURRENT_TIMESTAMP`;
}

/**
 * A case-insensitive "contains" filter — replaces inline `ILIKE`.
 *
 * Postgres compiles straight to `<column> ILIKE <pattern>`. SQLite has no `ILIKE`; its default
 * `LIKE` is already ASCII-case-insensitive, so the SQLite branch compiles to plain `LIKE` instead
 * — not full Unicode case-folding parity with Postgres's `ILIKE`, a disclosed gap, see the plan's
 * Risks section.
 *
 * `pattern` is the full `%...%`/`%...` wildcard pattern, matching how call sites build it today
 * (e.g. `` `%${search}%` ``) — this helper only swaps the operator, not the pattern-building.
 *
 * Accepts `Expression<string | null>` (not just `Expression<string>`) — a LEFT JOIN'd column
 * (e.g. an unmatched owner/project name) is nullable, and `NULL ILIKE/LIKE anything` already
 * correctly evaluates to NULL/falsy on both engines, excluding that row exactly like the
 * pre-Kysely raw SQL did. This is a type-signature widening only, not a behavior change.
 */
export function caseInsensitiveLike(column: Expression<string | null>, pattern: string): RawBuilder<boolean> {
  return loadConfig().dbClient === 'sqlite'
    ? sql<boolean>`${column} like ${pattern}`
    : sql<boolean>`${column} ilike ${pattern}`;
}

/**
 * Formats a timestamp column as `YYYY-MM-DD` — replaces inline `to_char(col, 'YYYY-MM-DD')`
 * (`diagrams/version.service.ts:74`, found during the canvas-jtm audit specifically because it
 * rides along with that file's `ILIKE` call — `to_char` is its own, separate Postgres-only
 * construct, not an `ILIKE` variant).
 *
 * SQLite's equivalent is `strftime('%Y-%m-%d', col)` — works against `CURRENT_TIMESTAMP`'s own
 * default `YYYY-MM-DD HH:MM:SS` text storage format.
 */
export function dateToYMD(column: Expression<Date>): RawBuilder<string> {
  return loadConfig().dbClient === 'sqlite'
    ? sql<string>`strftime('%Y-%m-%d', ${column})`
    : sql<string>`to_char(${column}, 'YYYY-MM-DD')`;
}

/**
 * Converts a JS boolean to whatever bound-parameter value each driver actually accepts, for a
 * call site writing a literal boolean through Kysely's `.values()`/`.set()`/`.where()`.
 * better-sqlite3 throws ("can only bind numbers, strings, bigints, buffers, and null") on a raw
 * JS boolean — SQLite has no native boolean type, just INTEGER 0/1 — while `pg` accepts a real
 * boolean natively and would reject 0/1 bound against a genuine `boolean` column.
 *
 * Declared as returning `boolean` (not `boolean | number`) even though the SQLite branch actually
 * returns a number at runtime — deliberately, matching `JsonColumn<T>`'s own established
 * precedent in `schema.ts` (its type says `string`, not `T`, forcing an explicit
 * `JSON.stringify()`/`JSON.parse()` at every call site rather than letting the compiler paper over
 * a real storage-representation difference): every `*Table` boolean column in `schema.ts` is typed
 * as plain `boolean` for Select/Insert/Update, so callers can pass this straight into `.set()`/
 * `.where()` without a second cast, confirmed safe because nothing in this codebase does
 * arithmetic on this value after conversion, only hands it back to Kysely for binding.
 */
export function dbBoolean(value: boolean): boolean {
  return (loadConfig().dbClient === 'sqlite' ? (value ? 1 : 0) : value) as unknown as boolean;
}

/**
 * The read-side counterpart to `dbBoolean()`: a column selected back from SQLite comes back as a
 * real JS `number` (0/1) at runtime despite `schema.ts` typing it `boolean` (same intentional
 * representation gap as `dbBoolean()` itself) — this normalizes it back to a real boolean so an
 * API response serializes `true`/`false`, not `1`/`0`, identically on both engines. A plain
 * truthiness check (`if (row.active)`, `!row.active`) needs no such normalization — 0/1 are
 * already falsy/truthy exactly like false/true — this is only needed where the value itself is
 * returned or compared with `===`/`toBe()`.
 */
export function fromDbBoolean(value: boolean): boolean {
  return Boolean(value);
}

/**
 * Normalizes a `Timestamp` column's selected value to a real `Date`, regardless of dialect.
 * Postgres (`pg`) already deserializes `TIMESTAMPTZ`/`TIMESTAMP` to a `Date` on read, so this is a
 * no-op there. SQLite has no native timestamp type: `SqliteValueCoercionPlugin` stores a bound
 * `Date` as its `.toISOString()` string on write, and better-sqlite3 hands that string straight
 * back unconverted on read (there is no symmetric read-side plugin, unlike JSON columns) — so a
 * `Timestamp` column's Select-side TypeScript type (`Date`, per `schema.ts`) is a real `Date` on
 * Postgres but a plain ISO string at runtime on SQLite.
 *
 * This matters because a naive JS `>`/`<` comparison against a real `Date` (e.g.
 * `row.deleted_at > someDate`, as `diagram.service.ts`'s `restoreDiagram`/`project.service.ts`'s
 * `restoreProject` do against a computed retention boundary) silently miscompares on SQLite:
 * the relational comparison converts both operands via `ToPrimitive(Number)`, and `Number(isoString)`
 * (NOT `Date.parse`) returns `NaN` for an ISO-8601 date string — so the comparison is always
 * `false`, not merely wrong in direction. Confirmed live: this exact bug made `restoreDiagram`/
 * `restoreProject` treat every SQLite-backed diagram/project as already past its retention window,
 * even immediately after deletion. SQL-level filtering (e.g. `.where('deleted_at', '<=', ...)`,
 * used by `findExpiredDiagramIds`) needs no such normalization — both engines store/compare
 * ISO-8601 timestamp text lexicographically-equivalent to chronological order at the SQL level.
 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
