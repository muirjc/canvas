/**
 * Read/write helpers for the 7 join tables that replaced this schema's `TEXT[]` columns
 * (canvas-jtm.3 — see db/schema.ts's module doc and
 * /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md). Centralized here rather than
 * inlined per call site so every one of the ~10 files touching these columns reads/writes them
 * identically — in particular, the `position`-preserving order (required: a plain TEXT[] column's
 * element order is real content, see 0011_array_columns_to_join_tables.sql's own comment) is easy
 * to get subtly wrong by hand and should only need getting right once.
 *
 * Every `set*` function replaces the owning row's full list (delete all rows for that owner, then
 * bulk-insert the new set with fresh 0-based positions) — matching a plain array column's own
 * whole-column-replace-on-write semantics exactly, and the same "delete rows for this parent id,
 * bulk-insert the new set" shape `diagram_versions` (append rows, update parent pointer) already
 * uses elsewhere in this codebase. Every function takes a `DbExecutor` so it composes into a
 * caller's own transaction when needed (e.g. `createDraftStandard` writing a standard row and its
 * shape lists atomically) without forcing one when it isn't.
 */
import type { DbExecutor } from './client.js';

// No shared generic "replace owned list" helper: Kysely's table/column types are keyed off
// literal string names, and a function generic enough to cover all 7 tables here fights that
// (confirmed via `tsc` — every call site needed an `as never` cast, defeating the point of a typed
// query builder). Each set* function below is a few concrete, fully-typed lines instead.

// --- users_personas (users.personas) ---------------------------------------------------------

export async function getUserPersonas(db: DbExecutor, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('users_personas')
    .select('persona')
    .where('user_id', '=', userId)
    .orderBy('position')
    .execute();
  return rows.map((r) => r.persona);
}

/** Batch form for `admin.service.ts`'s `listUsers()` — one query instead of N. */
export async function getUserPersonasBatch(db: DbExecutor, userIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (userIds.length === 0) return result;
  const rows = await db
    .selectFrom('users_personas')
    .select(['user_id', 'persona'])
    .where('user_id', 'in', userIds)
    .orderBy('user_id')
    .orderBy('position')
    .execute();
  for (const row of rows) {
    result.set(row.user_id, [...(result.get(row.user_id) ?? []), row.persona]);
  }
  return result;
}

export async function setUserPersonas(db: DbExecutor, userId: string, personas: string[]): Promise<void> {
  await db.deleteFrom('users_personas').where('user_id', '=', userId).execute();
  if (personas.length > 0) {
    await db
      .insertInto('users_personas')
      .values(personas.map((persona, position) => ({ user_id: userId, persona, position })))
      .execute();
  }
}

// --- diagram_types_personas (diagram_types.personas) ------------------------------------------

export async function getDiagramTypePersonas(db: DbExecutor, diagramTypeId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('diagram_types_personas')
    .select('persona')
    .where('diagram_type_id', '=', diagramTypeId)
    .orderBy('position')
    .execute();
  return rows.map((r) => r.persona);
}

/** Batch form for `diagram-type.routes.ts`'s "list the whole catalog" — the catalog is small
 *  (~18 rows), but one query beats N regardless. */
export async function getDiagramTypePersonasBatch(
  db: DbExecutor,
  diagramTypeIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (diagramTypeIds.length === 0) return result;
  const rows = await db
    .selectFrom('diagram_types_personas')
    .select(['diagram_type_id', 'persona'])
    .where('diagram_type_id', 'in', diagramTypeIds)
    .orderBy('diagram_type_id')
    .orderBy('position')
    .execute();
  for (const row of rows) {
    result.set(row.diagram_type_id, [...(result.get(row.diagram_type_id) ?? []), row.persona]);
  }
  return result;
}

export async function setDiagramTypePersonas(db: DbExecutor, diagramTypeId: string, personas: string[]): Promise<void> {
  await db.deleteFrom('diagram_types_personas').where('diagram_type_id', '=', diagramTypeId).execute();
  if (personas.length > 0) {
    await db
      .insertInto('diagram_types_personas')
      .values(personas.map((persona, position) => ({ diagram_type_id: diagramTypeId, persona, position })))
      .execute();
  }
}

// --- diagram_type_palette_libraries (diagram_types.default_palette_library_ids) ---------------

export async function getDiagramTypePaletteLibraries(db: DbExecutor, diagramTypeId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('diagram_type_palette_libraries')
    .select('library_id')
    .where('diagram_type_id', '=', diagramTypeId)
    .orderBy('position')
    .execute();
  return rows.map((r) => r.library_id);
}

export async function getDiagramTypePaletteLibrariesBatch(
  db: DbExecutor,
  diagramTypeIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (diagramTypeIds.length === 0) return result;
  const rows = await db
    .selectFrom('diagram_type_palette_libraries')
    .select(['diagram_type_id', 'library_id'])
    .where('diagram_type_id', 'in', diagramTypeIds)
    .orderBy('diagram_type_id')
    .orderBy('position')
    .execute();
  for (const row of rows) {
    result.set(row.diagram_type_id, [...(result.get(row.diagram_type_id) ?? []), row.library_id]);
  }
  return result;
}

export async function setDiagramTypePaletteLibraries(
  db: DbExecutor,
  diagramTypeId: string,
  libraryIds: string[],
): Promise<void> {
  await db.deleteFrom('diagram_type_palette_libraries').where('diagram_type_id', '=', diagramTypeId).execute();
  if (libraryIds.length > 0) {
    await db
      .insertInto('diagram_type_palette_libraries')
      .values(libraryIds.map((library_id, position) => ({ diagram_type_id: diagramTypeId, library_id, position })))
      .execute();
  }
}

// --- icon_keywords (icons.keywords) ------------------------------------------------------------

/** Keyed by `${libraryId}@${libraryVersion}@${iconId}`, matching `library.service.ts`'s own
 *  existing `resolveIconAssets` key convention. */
export async function getIconKeywordsBatch(
  db: DbExecutor,
  refs: { libraryId: string; libraryVersion: string; iconId: string }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (refs.length === 0) return result;
  const libraryIds = [...new Set(refs.map((r) => r.libraryId))];
  const libraryVersions = [...new Set(refs.map((r) => r.libraryVersion))];
  // Over-fetches slightly when multiple (library, version) pairs don't share every combination —
  // acceptable since callers always scope `refs` to one library+version (searchIconsInLibrary) or
  // one diagram type's own small palette-library set (searchIconsForDiagramType), never an
  // unrelated cross-product.
  const rows = await db
    .selectFrom('icon_keywords')
    .select(['library_id', 'library_version', 'icon_id', 'keyword'])
    .where('library_id', 'in', libraryIds)
    .where('library_version', 'in', libraryVersions)
    .orderBy('library_id')
    .orderBy('library_version')
    .orderBy('icon_id')
    .orderBy('position')
    .execute();
  for (const row of rows) {
    const key = `${row.library_id}@${row.library_version}@${row.icon_id}`;
    result.set(key, [...(result.get(key) ?? []), row.keyword]);
  }
  return result;
}

/**
 * Replaces keywords for every icon in one library+version in a single delete + one bulk insert —
 * `ingestLibrary` ingests an entire manifest (Azure's real pack alone is 257 icons) in one call,
 * so a per-icon delete+insert pair (514 round trips) would be needlessly slow for what is already
 * a single logical "replace this library's contents" operation.
 */
export async function setLibraryIconKeywords(
  db: DbExecutor,
  libraryId: string,
  libraryVersion: string,
  icons: { iconId: string; keywords: string[] }[],
): Promise<void> {
  await db
    .deleteFrom('icon_keywords')
    .where('library_id', '=', libraryId)
    .where('library_version', '=', libraryVersion)
    .execute();
  const rows = icons.flatMap((icon) =>
    icon.keywords.map((keyword, position) => ({
      library_id: libraryId,
      library_version: libraryVersion,
      icon_id: icon.iconId,
      keyword,
      position,
    })),
  );
  if (rows.length > 0) {
    await db.insertInto('icon_keywords').values(rows).execute();
  }
}

// --- standard_allowed_shapes / standard_mandatory_shapes (standards.*_shape_ids) ---------------

export async function getStandardAllowedShapes(db: DbExecutor, standardId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('standard_allowed_shapes')
    .select('shape_id')
    .where('standard_id', '=', standardId)
    .orderBy('position')
    .execute();
  return rows.map((r) => r.shape_id);
}

export async function getStandardMandatoryShapes(db: DbExecutor, standardId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('standard_mandatory_shapes')
    .select('shape_id')
    .where('standard_id', '=', standardId)
    .orderBy('position')
    .execute();
  return rows.map((r) => r.shape_id);
}

/** Batch form for `listStandards()` (every version of one diagram type's standard). */
export async function getStandardShapesBatch(
  db: DbExecutor,
  standardIds: string[],
): Promise<{ allowed: Map<string, string[]>; mandatory: Map<string, string[]> }> {
  const allowed = new Map<string, string[]>();
  const mandatory = new Map<string, string[]>();
  if (standardIds.length === 0) return { allowed, mandatory };
  const [allowedRows, mandatoryRows] = await Promise.all([
    db
      .selectFrom('standard_allowed_shapes')
      .select(['standard_id', 'shape_id'])
      .where('standard_id', 'in', standardIds)
      .orderBy('standard_id')
      .orderBy('position')
      .execute(),
    db
      .selectFrom('standard_mandatory_shapes')
      .select(['standard_id', 'shape_id'])
      .where('standard_id', 'in', standardIds)
      .orderBy('standard_id')
      .orderBy('position')
      .execute(),
  ]);
  for (const row of allowedRows) allowed.set(row.standard_id, [...(allowed.get(row.standard_id) ?? []), row.shape_id]);
  for (const row of mandatoryRows)
    mandatory.set(row.standard_id, [...(mandatory.get(row.standard_id) ?? []), row.shape_id]);
  return { allowed, mandatory };
}

export async function setStandardAllowedShapes(db: DbExecutor, standardId: string, shapeIds: string[]): Promise<void> {
  await db.deleteFrom('standard_allowed_shapes').where('standard_id', '=', standardId).execute();
  if (shapeIds.length > 0) {
    await db
      .insertInto('standard_allowed_shapes')
      .values(shapeIds.map((shape_id, position) => ({ standard_id: standardId, shape_id, position })))
      .execute();
  }
}

export async function setStandardMandatoryShapes(
  db: DbExecutor,
  standardId: string,
  shapeIds: string[],
): Promise<void> {
  await db.deleteFrom('standard_mandatory_shapes').where('standard_id', '=', standardId).execute();
  if (shapeIds.length > 0) {
    await db
      .insertInto('standard_mandatory_shapes')
      .values(shapeIds.map((shape_id, position) => ({ standard_id: standardId, shape_id, position })))
      .execute();
  }
}

// --- ai_persona_reference_material_families (ai_persona_reference_material.diagram_families) --

export async function getReferenceMaterialFamilies(db: DbExecutor, entryId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('ai_persona_reference_material_families')
    .select('diagram_family')
    .where('reference_material_id', '=', entryId)
    .orderBy('position')
    .execute();
  return rows.map((r) => r.diagram_family);
}

/** Batch form for `listReferenceMaterial()` (every entry for one persona). */
export async function getReferenceMaterialFamiliesBatch(
  db: DbExecutor,
  entryIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (entryIds.length === 0) return result;
  const rows = await db
    .selectFrom('ai_persona_reference_material_families')
    .select(['reference_material_id', 'diagram_family'])
    .where('reference_material_id', 'in', entryIds)
    .orderBy('reference_material_id')
    .orderBy('position')
    .execute();
  for (const row of rows) {
    result.set(row.reference_material_id, [...(result.get(row.reference_material_id) ?? []), row.diagram_family]);
  }
  return result;
}

/** An empty `families` list deletes every row for this entry and inserts none back — "no row at
 *  all" is this join table's own representation of "unscoped" (db/schema.ts's own doc comment on
 *  this table), replacing the old column's NULL/'{}' collapsing. */
export async function setReferenceMaterialFamilies(db: DbExecutor, entryId: string, families: string[]): Promise<void> {
  await db.deleteFrom('ai_persona_reference_material_families').where('reference_material_id', '=', entryId).execute();
  if (families.length > 0) {
    await db
      .insertInto('ai_persona_reference_material_families')
      .values(families.map((diagram_family, position) => ({ reference_material_id: entryId, diagram_family, position })))
      .execute();
  }
}
