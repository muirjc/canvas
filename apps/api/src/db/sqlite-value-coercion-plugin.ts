/**
 * canvas-jtm.7: better-sqlite3 only accepts numbers, strings, bigints, buffers, and null as bound
 * parameters — it throws ("SQLite3 can only bind numbers, strings, bigints, buffers, and null") on
 * a raw JS `Date` or `boolean`, both of which `pg` accepts natively (and which this schema's
 * `Timestamp`/boolean column types allow on Insert/Update, matching what `pg` actually supports —
 * confirmed live: `new Date()` passed straight into `.set({ deleted_at: ... })`, a pattern used
 * throughout `diagrams/diagram.service.ts` and `projects/project.service.ts` for soft-delete/
 * restore timestamps, failed exactly this way under SQLite).
 *
 * Rather than hunting down and converting every current and future call site that binds a literal
 * `Date`/`boolean` (the approach `db/sql-helpers.ts`'s `dbBoolean()` took first, for the two call
 * sites found by that point — left in place as harmless, redundant documentation of intent, not
 * removed here), this transforms every bound value at the query-AST level, for the SQLite dialect
 * only: a `Date` becomes its `.toISOString()` string (parseable by SQLite's own `strftime()`/date
 * functions, and round-trips correctly through `db/sqlite-json-plugin.ts`-style read-back since
 * nothing here needs the reverse direction — every Timestamp column is read back as a string on
 * both engines' Select type in practice, per `schema.ts`'s own `Timestamp` comment), and a
 * `boolean` becomes `1`/`0`. Values inside a `VALUES (...)` list, a `WHERE`/`SET` literal, and a
 * `WHERE col IN (...)` list are all covered (`ValueNode`, `PrimitiveValueListNode`, every element
 * of a `ValueListNode`).
 */
import {
  OperationNodeTransformer,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
  type ValueNode,
  type PrimitiveValueListNode,
} from 'kysely';

function coerce(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class SqliteValueCoercionTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    return { ...super.transformValue(node), value: coerce(node.value) };
  }

  protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
    return { ...super.transformPrimitiveValueList(node), values: node.values.map(coerce) };
  }
}

export class SqliteValueCoercionPlugin implements KyselyPlugin {
  readonly #transformer = new SqliteValueCoercionTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node, args.queryId);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
