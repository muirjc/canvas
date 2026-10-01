import { sql } from 'kysely';
import { loadLibrary, searchIcons, type Icon, type IconShapeLibraryManifest } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';
import { getDb } from '../db/client.js';
import { getDiagramTypePaletteLibraries, getIconKeywordsBatch, setLibraryIconKeywords } from '../db/array-columns.js';

export interface LibrarySummary {
  id: string;
  version: string;
  license: string | null;
  iconCount: number;
}

export async function listLibraries(): Promise<LibrarySummary[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('icon_libraries as l')
    .leftJoin('icons as i', (join) => join.onRef('i.library_id', '=', 'l.id').onRef('i.library_version', '=', 'l.version'))
    .select(['l.id', 'l.version', 'l.license', sql<string>`COUNT(i.id)::text`.as('icon_count')])
    .groupBy(['l.id', 'l.version', 'l.license'])
    .orderBy('l.id')
    .orderBy('l.version')
    .execute();
  return rows.map((r) => ({ id: r.id, version: r.version, license: r.license, iconCount: Number(r.icon_count) }));
}

/** Ingests a new library or library version (FR-010, Constitution V) — one call, no other code changes. */
export async function ingestLibrary(manifest: IconShapeLibraryManifest): Promise<void> {
  const library = loadLibrary(manifest); // validates the manifest shape/uniqueness
  const db = getDb();

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('icon_libraries')
      .values({ id: library.id, version: library.version, license: library.license ?? null })
      .onConflict((oc) => oc.columns(['id', 'version']).doUpdateSet((eb) => ({ license: eb.ref('excluded.license') })))
      .execute();
    for (const icon of library.icons) {
      await trx
        .insertInto('icons')
        .values({
          library_id: icon.libraryId,
          library_version: icon.libraryVersion,
          id: icon.id,
          display_name: icon.displayName,
          category: icon.category,
          asset_ref: icon.assetRef,
        })
        .onConflict((oc) =>
          oc.columns(['library_id', 'library_version', 'id']).doUpdateSet((eb) => ({
            display_name: eb.ref('excluded.display_name'),
            category: eb.ref('excluded.category'),
            asset_ref: eb.ref('excluded.asset_ref'),
          })),
        )
        .execute();
    }
    // One delete + one bulk insert for the whole library's keywords, not per-icon (setLibraryIconKeywords's
    // own doc comment) — Azure's real pack alone is 257 icons.
    await setLibraryIconKeywords(
      trx,
      library.id,
      library.version,
      library.icons.map((icon) => ({ iconId: icon.id, keywords: icon.keywords })),
    );
  });
}

interface IconRow {
  library_id: string;
  library_version: string;
  id: string;
  display_name: string;
  category: string;
  asset_ref: string;
}

function toIcon(row: IconRow, keywords: string[]): Icon {
  return {
    libraryId: row.library_id,
    libraryVersion: row.library_version,
    id: row.id,
    displayName: row.display_name,
    keywords,
    category: row.category,
    assetRef: row.asset_ref,
  };
}

async function toIcons(db: ReturnType<typeof getDb>, rows: IconRow[]): Promise<Icon[]> {
  const keywordsByIcon = await getIconKeywordsBatch(
    db,
    rows.map((r) => ({ libraryId: r.library_id, libraryVersion: r.library_version, iconId: r.id })),
  );
  return rows.map((row) => toIcon(row, keywordsByIcon.get(`${row.library_id}@${row.library_version}@${row.id}`) ?? []));
}

export async function searchIconsInLibrary(libraryId: string, version: string, query: string): Promise<Icon[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('icons')
    .select(['library_id', 'library_version', 'id', 'display_name', 'category', 'asset_ref'])
    .where('library_id', '=', libraryId)
    .where('library_version', '=', version)
    .execute();
  const library = { id: libraryId, version, icons: await toIcons(db, rows) };
  return searchIcons(library, query);
}

/**
 * canvas-8n7: resolves a batch of icon refs to their SVG markup (`assetRef`) in one query, for
 * export's `resolveIcon` — a diagram's distinct icon refs are typically few, so one `IN`-style
 * query beats N round-trips or fetching an entire library just to pick out a handful of icons.
 * Refs naming a library/version/id with no matching row are simply absent from the result map,
 * left for the caller to treat as "no artwork available" rather than an error (FR-005-style
 * leniency — a stale or since-deleted icon shouldn't fail the whole export).
 *
 * Deliberately NOT yet converted to Kysely (canvas-jtm.3 scope: array-column redesign only — this
 * function has no array-column dependency, just a Postgres-specific `UNNEST`-for-multi-column-IN
 * technique, which is canvas-jtm.4's construct-cleanup territory).
 */
export async function resolveIconAssets(
  refs: { libraryId: string; libraryVersion: string; iconId: string }[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (refs.length === 0) return result;

  const libraryIds = refs.map((r) => r.libraryId);
  const libraryVersions = refs.map((r) => r.libraryVersion);
  const iconIds = refs.map((r) => r.iconId);
  const pool = getPool();
  const { rows } = await pool.query<{ library_id: string; library_version: string; id: string; asset_ref: string }>(
    `SELECT library_id, library_version, id, asset_ref FROM icons
     WHERE (library_id, library_version, id) IN (
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
     )`,
    [libraryIds, libraryVersions, iconIds],
  );
  for (const row of rows) {
    result.set(`${row.library_id}@${row.library_version}@${row.id}`, row.asset_ref);
  }
  return result;
}

/** Cross-library search scoped to a diagram type's default palette libraries (FR-007 + FR-009). */
export async function searchIconsForDiagramType(diagramTypeId: string, query: string): Promise<Icon[]> {
  const db = getDb();
  const libraryIds = await getDiagramTypePaletteLibraries(db, diagramTypeId);
  if (libraryIds.length === 0) return [];

  const rows = await db
    .selectFrom('icons')
    .select(['library_id', 'library_version', 'id', 'display_name', 'category', 'asset_ref'])
    .where('library_id', 'in', libraryIds)
    .execute();
  const icons = await toIcons(db, rows);
  const grouped = new Map<string, Icon[]>();
  for (const icon of icons) {
    const key = `${icon.libraryId}@${icon.libraryVersion}`;
    grouped.set(key, [...(grouped.get(key) ?? []), icon]);
  }

  const results: Icon[] = [];
  for (const [key, groupIcons] of grouped) {
    const [id, version] = key.split('@');
    const library = { id, version, icons: groupIcons };
    results.push(...searchIcons(library, query));
  }
  return results;
}
