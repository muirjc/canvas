type ZodDef = {
  type: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  innerType?: unknown;
};

/** Walks any Zod schema node (object/array/optional/nullable/default/readonly wrappers) looking
 *  for every reachable `ZodEnum`, collecting its literal option values into `out`. Schema shapes
 *  the tools don't currently use (union, record, etc.) are simply not recursed into -- extend
 *  here if a future tool introduces one. */
export function collectEnumValues(schema: unknown, out: Set<string>): void {
  const def = (schema as { def?: ZodDef } | undefined)?.def;
  if (!def) return;
  switch (def.type) {
    case 'enum':
      for (const value of (schema as { options: string[] }).options) out.add(value);
      return;
    case 'object':
      for (const key of Object.keys(def.shape!)) collectEnumValues(def.shape![key], out);
      return;
    case 'array':
      collectEnumValues(def.element, out);
      return;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
      collectEnumValues(def.innerType, out);
      return;
    default:
      return;
  }
}

/** Every enum value reachable through any tool's inputSchema in a tool set. */
export function collectToolEnumValues(tools: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(tools)) collectEnumValues((t as { inputSchema: unknown }).inputSchema, out);
  return out;
}
