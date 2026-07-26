import { loadLibrary, searchIcons, type Icon, type IconShapeLibraryManifest } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';

export interface LibrarySummary {
  id: string;
  version: string;
  license: string | null;
  iconCount: number;
}

export async function listLibraries(): Promise<LibrarySummary[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; version: string; license: string | null; icon_count: string }>(
    `SELECT l.id, l.version, l.license, COUNT(i.id)::text AS icon_count
     FROM icon_libraries l
     LEFT JOIN icons i ON i.library_id = l.id AND i.library_version = l.version
     GROUP BY l.id, l.version, l.license
     ORDER BY l.id, l.version`,
  );
  return rows.map((r) => ({ id: r.id, version: r.version, license: r.license, iconCount: Number(r.icon_count) }));
}

/** Ingests a new library or library version (FR-010, Constitution V) — one call, no other code changes. */
export async function ingestLibrary(manifest: IconShapeLibraryManifest): Promise<void> {
  const library = loadLibrary(manifest); // validates the manifest shape/uniqueness
  const pool = getPool();

  await pool.query(
    `INSERT INTO icon_libraries (id, version, license) VALUES ($1, $2, $3)
     ON CONFLICT (id, version) DO UPDATE SET license = EXCLUDED.license`,
    [library.id, library.version, library.license ?? null],
  );
  for (const icon of library.icons) {
    await pool.query(
      `INSERT INTO icons (library_id, library_version, id, display_name, keywords, category, asset_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (library_id, library_version, id) DO UPDATE SET
         display_name = EXCLUDED.display_name, keywords = EXCLUDED.keywords,
         category = EXCLUDED.category, asset_ref = EXCLUDED.asset_ref`,
      [icon.libraryId, icon.libraryVersion, icon.id, icon.displayName, icon.keywords, icon.category, icon.assetRef],
    );
  }
}

interface IconRow {
  library_id: string;
  library_version: string;
  id: string;
  display_name: string;
  keywords: string[];
  category: string;
  asset_ref: string;
}

function toIcon(row: IconRow): Icon {
  return {
    libraryId: row.library_id,
    libraryVersion: row.library_version,
    id: row.id,
    displayName: row.display_name,
    keywords: row.keywords,
    category: row.category,
    assetRef: row.asset_ref,
  };
}

export async function searchIconsInLibrary(libraryId: string, version: string, query: string): Promise<Icon[]> {
  const pool = getPool();
  const { rows } = await pool.query<IconRow>(
    'SELECT * FROM icons WHERE library_id = $1 AND library_version = $2',
    [libraryId, version],
  );
  const library = { id: libraryId, version, icons: rows.map(toIcon) };
  return searchIcons(library, query);
}

/** Cross-library search scoped to a diagram type's default palette libraries (FR-007 + FR-009). */
export async function searchIconsForDiagramType(diagramTypeId: string, query: string): Promise<Icon[]> {
  const pool = getPool();
  const { rows: typeRows } = await pool.query<{ default_palette_library_ids: string[] }>(
    'SELECT default_palette_library_ids FROM diagram_types WHERE id = $1',
    [diagramTypeId],
  );
  const libraryIds = typeRows[0]?.default_palette_library_ids ?? [];
  if (libraryIds.length === 0) return [];

  const { rows } = await pool.query<IconRow>('SELECT * FROM icons WHERE library_id = ANY($1)', [libraryIds]);
  const grouped = new Map<string, IconRow[]>();
  for (const row of rows) {
    const key = `${row.library_id}@${row.library_version}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const results: Icon[] = [];
  for (const [key, groupRows] of grouped) {
    const [id, version] = key.split('@');
    const library = { id, version, icons: groupRows.map(toIcon) };
    results.push(...searchIcons(library, query));
  }
  return results;
}
