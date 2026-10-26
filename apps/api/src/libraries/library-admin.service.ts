import { getDslFamily, prepareUploadedSvg, sanitizeIconMarkupStrict, SvgImportError, type IconRef, type IconShapeLibraryManifest } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { currentTimestamp, dbBoolean } from '../db/sql-helpers.js';
import { getIconKeywordsBatch, setLibraryIconKeywords } from '../db/array-columns.js';
import { ingestLibrary } from './library.service.js';

/**
 * canvas-3dq: admin management of icon/shape libraries. Built-in libraries (the catalog seed's)
 * can only be retired/restored; custom ones (imported here) are fully editable. Retiring hides a
 * library or icon from palettes and search while diagrams that use it keep rendering it; a real
 * delete is only allowed for a custom library/icon nothing uses.
 */
export class LibraryNotFoundError extends Error {}
export class LibraryInvalidError extends Error {}
export class LibraryConflictError extends Error {}
export class LibraryInUseError extends Error {
  constructor(
    message: string,
    readonly diagrams: DiagramUsage[],
  ) {
    super(message);
  }
}

export interface DiagramUsage {
  id: string;
  name: string;
  projectId: string;
}

export interface AdminLibrary {
  id: string;
  version: string;
  name: string;
  origin: 'builtin' | 'custom';
  license: string | null;
  iconCount: number;
  retiredIconCount: number;
  retiredAt: string | null;
  diagramTypes: { id: string; name: string }[];
  usedByDiagramCount: number;
}

export interface AdminIcon {
  id: string;
  displayName: string;
  category: string;
  keywords: string[];
  assetRef: string;
  retiredAt: string | null;
  usedByDiagramCount: number;
}

export interface UploadedIcon {
  fileName: string;
  svg: string;
  displayName?: string;
  category?: string;
  keywords?: string[];
}

export interface RejectedIcon {
  fileName: string;
  reason: string;
}

const MAX_ICONS_PER_IMPORT = 1000;
const ts = (v: unknown) => (v as string | null) ?? null;

export function slugify(text: string, fallback = 'icon'): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.svg$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** "cloud-storage_v2.svg" -> "Cloud storage v2". */
function nameFromFile(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.svg$/i, '').replace(/[-_]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Icon';
}

/** Which live diagrams use each library version and icon: keys "<lib>@<version>" and
 *  "<lib>@<version>@<icon>". One pass over the diagrams (optionally only those mentioning one library). */
async function iconUsage(libraryId?: string): Promise<Map<string, DiagramUsage[]>> {
  const rows = await getDb()
    .selectFrom('diagrams as d')
    .innerJoin('diagram_versions as v', 'v.id', 'd.current_version_id')
    .innerJoin('diagram_types as t', 't.id', 'd.diagram_type_id')
    .select(['d.id', 'd.name', 'd.project_id', 't.dsl_family', 'v.dsl_content'])
    .where('d.deleted_at', 'is', null)
    .execute();
  const usage = new Map<string, DiagramUsage[]>();
  for (const row of rows) {
    // Cheap filter first: icon refs are saved in front-matter under `libraryId`, except an
    // architecture diagram's built-in icons, which its own syntax names (`service db(database)`).
    const mentions = libraryId ? row.dsl_content.includes(libraryId) : row.dsl_content.includes('libraryId');
    if (!mentions && row.dsl_family !== 'architecture') continue;
    const parsed = getDslFamily(row.dsl_family)?.parse(row.dsl_content);
    if (!parsed || 'errors' in parsed) continue;
    const refs: IconRef[] = [...parsed.model.nodes, ...parsed.model.containers].flatMap((e) => (e.icon ? [e.icon] : []));
    const seen = new Set<string>();
    for (const ref of refs) {
      if (libraryId && ref.libraryId !== libraryId) continue;
      for (const key of [`${ref.libraryId}@${ref.libraryVersion}`, `${ref.libraryId}@${ref.libraryVersion}@${ref.iconId}`]) {
        if (seen.has(key)) continue;
        seen.add(key);
        usage.set(key, [...(usage.get(key) ?? []), { id: row.id, name: row.name, projectId: row.project_id }]);
      }
    }
  }
  return usage;
}

async function getLibraryRow(id: string, version: string) {
  const row = await getDb().selectFrom('icon_libraries').selectAll().where('id', '=', id).where('version', '=', version).executeTakeFirst();
  if (!row) throw new LibraryNotFoundError(`No library ${id} ${version}.`);
  return row;
}

async function requireCustom(id: string, version: string) {
  const row = await getLibraryRow(id, version);
  if (row.origin !== 'custom') throw new LibraryInvalidError('Built-in libraries can only be retired or restored, not edited.');
  return row;
}

export async function listAdminLibraries(): Promise<AdminLibrary[]> {
  const db = getDb();
  const libraries = await db.selectFrom('icon_libraries').selectAll().orderBy('origin').orderBy('id').orderBy('version').execute();
  const counts = await db
    .selectFrom('icons')
    .select(['library_id', 'library_version', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.count<number>('retired_at').as('retired')])
    .groupBy(['library_id', 'library_version'])
    .execute();
  const palette = await db
    .selectFrom('diagram_type_palette_libraries as p')
    .innerJoin('diagram_types as t', 't.id', 'p.diagram_type_id')
    .select(['p.library_id', 't.id', 't.name'])
    .orderBy('t.name')
    .execute();
  const usage = await iconUsage();
  const result: AdminLibrary[] = [];
  for (const lib of libraries) {
    const count = counts.find((c) => c.library_id === lib.id && c.library_version === lib.version);
    result.push({
      id: lib.id,
      version: lib.version,
      name: lib.display_name ?? lib.id,
      origin: lib.origin,
      license: lib.license,
      iconCount: Number(count?.n ?? 0),
      retiredIconCount: Number(count?.retired ?? 0),
      retiredAt: ts(lib.retired_at),
      diagramTypes: palette.filter((p) => p.library_id === lib.id).map((p) => ({ id: p.id, name: p.name })),
      usedByDiagramCount: usage.get(`${lib.id}@${lib.version}`)?.length ?? 0,
    });
  }
  return result;
}

export async function listAdminIcons(id: string, version: string): Promise<AdminIcon[]> {
  await getLibraryRow(id, version);
  const db = getDb();
  const rows = await db.selectFrom('icons').selectAll().where('library_id', '=', id).where('library_version', '=', version).orderBy('display_name').execute();
  const keywords = await getIconKeywordsBatch(db, rows.map((r) => ({ libraryId: id, libraryVersion: version, iconId: r.id })));
  const usage = await iconUsage(id);
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    category: r.category,
    keywords: keywords.get(`${id}@${version}@${r.id}`) ?? [],
    assetRef: r.asset_ref,
    retiredAt: ts(r.retired_at),
    usedByDiagramCount: usage.get(`${id}@${version}@${r.id}`)?.length ?? 0,
  }));
}

/** Uploaded files -> manifest entries; files that can't be used are reported, not fatal. */
function prepareIcons(libraryId: string, uploads: UploadedIcon[], takenIds: Set<string>) {
  const icons: IconShapeLibraryManifest['icons'] = [];
  const rejected: RejectedIcon[] = [];
  for (const upload of uploads) {
    let id = slugify(upload.fileName);
    for (let n = 2; takenIds.has(id); n++) id = `${slugify(upload.fileName)}-${n}`;
    try {
      const assetRef = prepareUploadedSvg(upload.svg, `${libraryId}-${id}`);
      takenIds.add(id);
      icons.push({
        id,
        displayName: (upload.displayName ?? '').trim() || nameFromFile(upload.fileName),
        category: (upload.category ?? '').trim() || 'General',
        keywords: (upload.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 20),
        assetRef,
      });
    } catch (error) {
      if (!(error instanceof SvgImportError)) throw error;
      rejected.push({ fileName: upload.fileName, reason: error.message });
    }
  }
  return { icons, rejected };
}

async function uniqueLibraryId(name: string): Promise<string> {
  const base = slugify(name, 'library');
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const taken = await getDb().selectFrom('icon_libraries').select('id').where('id', '=', id).executeTakeFirst();
    if (!taken) return id;
  }
}

/** A new custom library from uploaded SVG files. */
export async function importSvgLibrary(input: { name: string; license?: string | null; icons: UploadedIcon[] }): Promise<{ library: AdminLibrary; rejected: RejectedIcon[] }> {
  const name = input.name.trim();
  if (!name) throw new LibraryInvalidError('Give the library a name.');
  if (input.icons.length === 0) throw new LibraryInvalidError('Choose at least one SVG file.');
  if (input.icons.length > MAX_ICONS_PER_IMPORT) throw new LibraryInvalidError(`At most ${MAX_ICONS_PER_IMPORT} icons per import.`);
  const id = await uniqueLibraryId(name);
  const { icons, rejected } = prepareIcons(id, input.icons, new Set());
  if (icons.length === 0) throw new LibraryInvalidError(`None of the files could be used: ${rejected.map((r) => `${r.fileName} (${r.reason})`).join('; ')}`);
  await ingestLibrary({ id, version: '1', license: input.license?.trim() || undefined, icons }, { origin: 'custom', displayName: name });
  return { library: (await listAdminLibraries()).find((l) => l.id === id)!, rejected };
}

/** A custom library from a manifest (the bundled packs' format; artwork already in 48x48 space). */
export async function importManifestLibrary(manifest: IconShapeLibraryManifest, name?: string): Promise<AdminLibrary> {
  if (!manifest || typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || !Array.isArray(manifest.icons)) {
    throw new LibraryInvalidError('The manifest needs an id, a version and an icons list.');
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,59}$/.test(manifest.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(manifest.version)) {
    throw new LibraryInvalidError('The manifest id must be lower-case letters, numbers, "-", "_" or "."; the version letters, numbers, ".", "-" or "_".');
  }
  if (manifest.icons.length === 0 || manifest.icons.length > MAX_ICONS_PER_IMPORT) throw new LibraryInvalidError(`A manifest needs 1 to ${MAX_ICONS_PER_IMPORT} icons.`);
  const existing = await getDb().selectFrom('icon_libraries').select(['origin']).where('id', '=', manifest.id).executeTakeFirst();
  if (existing?.origin === 'builtin') throw new LibraryConflictError(`"${manifest.id}" is a built-in library; give yours a different id.`);
  const existingVersion = await getDb().selectFrom('icon_libraries').select('id').where('id', '=', manifest.id).where('version', '=', manifest.version).executeTakeFirst();
  if (existingVersion) throw new LibraryConflictError(`Library ${manifest.id} version ${manifest.version} already exists.`);
  let icons: IconShapeLibraryManifest['icons'];
  try {
    icons = manifest.icons.map((icon) => {
      if (typeof icon?.id !== 'string' || typeof icon.assetRef !== 'string') throw new LibraryInvalidError('Every icon needs an id and assetRef.');
      return {
        id: icon.id,
        displayName: String(icon.displayName ?? icon.id),
        category: String(icon.category ?? 'General'),
        keywords: Array.isArray(icon.keywords) ? icon.keywords.map(String).slice(0, 20) : [],
        assetRef: sanitizeIconMarkupStrict(icon.assetRef, `${manifest.id}-${icon.id}`),
      };
    });
  } catch (error) {
    if (error instanceof SvgImportError) throw new LibraryInvalidError(error.message);
    throw error;
  }
  try {
    await ingestLibrary({ id: manifest.id, version: manifest.version, license: manifest.license, icons }, { origin: 'custom', displayName: name?.trim() || null });
  } catch (error) {
    throw new LibraryInvalidError(error instanceof Error ? error.message : String(error));
  }
  return (await listAdminLibraries()).find((l) => l.id === manifest.id && l.version === manifest.version)!;
}

export async function addSvgIcons(id: string, version: string, uploads: UploadedIcon[]): Promise<{ added: string[]; rejected: RejectedIcon[] }> {
  await requireCustom(id, version);
  if (uploads.length === 0 || uploads.length > MAX_ICONS_PER_IMPORT) throw new LibraryInvalidError(`Add 1 to ${MAX_ICONS_PER_IMPORT} SVG files.`);
  const db = getDb();
  const existing = await db.selectFrom('icons').select('id').where('library_id', '=', id).where('library_version', '=', version).execute();
  const { icons, rejected } = prepareIcons(id, uploads, new Set(existing.map((e) => e.id)));
  if (icons.length === 0) throw new LibraryInvalidError(`None of the files could be used: ${rejected.map((r) => `${r.fileName} (${r.reason})`).join('; ')}`);
  await db.transaction().execute(async (trx) => {
    for (const icon of icons) {
      await trx
        .insertInto('icons')
        .values({ library_id: id, library_version: version, id: icon.id, display_name: icon.displayName, category: icon.category, asset_ref: icon.assetRef })
        .execute();
    }
  });
  for (const icon of icons) await setIconKeywords(id, version, icon.id, icon.keywords);
  return { added: icons.map((i) => i.id), rejected };
}

async function setIconKeywords(id: string, version: string, iconId: string, keywords: string[]): Promise<void> {
  const db = getDb();
  const all = await db.selectFrom('icons').select('id').where('library_id', '=', id).where('library_version', '=', version).execute();
  const current = await getIconKeywordsBatch(db, all.map((r) => ({ libraryId: id, libraryVersion: version, iconId: r.id })));
  await setLibraryIconKeywords(
    db,
    id,
    version,
    all.map((r) => ({ iconId: r.id, keywords: r.id === iconId ? keywords : (current.get(`${id}@${version}@${r.id}`) ?? []) })),
  );
}

export async function updateLibrary(id: string, version: string, patch: { name?: string; license?: string | null }): Promise<void> {
  await requireCustom(id, version);
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new LibraryInvalidError('The library needs a name.');
  await getDb()
    .updateTable('icon_libraries')
    .set({ display_name: name, license: patch.license === undefined ? undefined : patch.license?.trim() || null })
    .where('id', '=', id)
    .where('version', '=', version)
    .execute();
}

export async function updateIcon(
  id: string,
  version: string,
  iconId: string,
  patch: { displayName?: string; category?: string; keywords?: string[]; svg?: string },
): Promise<void> {
  await requireCustom(id, version);
  const db = getDb();
  const icon = await db.selectFrom('icons').select('id').where('library_id', '=', id).where('library_version', '=', version).where('id', '=', iconId).executeTakeFirst();
  if (!icon) throw new LibraryNotFoundError(`No icon ${iconId} in ${id} ${version}.`);
  let assetRef: string | undefined;
  if (patch.svg !== undefined) {
    try {
      assetRef = prepareUploadedSvg(patch.svg, `${id}-${iconId}`);
    } catch (error) {
      if (error instanceof SvgImportError) throw new LibraryInvalidError(error.message);
      throw error;
    }
  }
  const displayName = patch.displayName?.trim();
  if (patch.displayName !== undefined && !displayName) throw new LibraryInvalidError('The icon needs a name.');
  await db
    .updateTable('icons')
    .set({ display_name: displayName, category: patch.category === undefined ? undefined : patch.category.trim() || 'General', asset_ref: assetRef })
    .where('library_id', '=', id)
    .where('library_version', '=', version)
    .where('id', '=', iconId)
    .execute();
  if (patch.keywords) await setIconKeywords(id, version, iconId, patch.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 20));
}

export async function setLibraryRetired(id: string, version: string, retired: boolean): Promise<void> {
  await getLibraryRow(id, version);
  await getDb().updateTable('icon_libraries').set({ retired_at: retired ? currentTimestamp() : null }).where('id', '=', id).where('version', '=', version).execute();
}

export async function setIconRetired(id: string, version: string, iconId: string, retired: boolean): Promise<void> {
  await getLibraryRow(id, version);
  const result = await getDb()
    .updateTable('icons')
    .set({ retired_at: retired ? currentTimestamp() : null })
    .where('library_id', '=', id)
    .where('library_version', '=', version)
    .where('id', '=', iconId)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw new LibraryNotFoundError(`No icon ${iconId} in ${id} ${version}.`);
}

export async function deleteLibrary(id: string, version: string): Promise<void> {
  await requireCustom(id, version);
  const users = (await iconUsage(id)).get(`${id}@${version}`) ?? [];
  if (users.length > 0) throw new LibraryInUseError(`${users.length} diagram${users.length === 1 ? ' uses' : 's use'} this library; retire it instead.`, users);
  const db = getDb();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('icon_keywords').where('library_id', '=', id).where('library_version', '=', version).execute();
    await trx.deleteFrom('icons').where('library_id', '=', id).where('library_version', '=', version).execute();
    await trx.deleteFrom('icon_libraries').where('id', '=', id).where('version', '=', version).execute();
    const otherVersions = await trx.selectFrom('icon_libraries').select('id').where('id', '=', id).executeTakeFirst();
    if (!otherVersions) await trx.deleteFrom('diagram_type_palette_libraries').where('library_id', '=', id).execute();
  });
}

export async function deleteIcon(id: string, version: string, iconId: string): Promise<void> {
  await requireCustom(id, version);
  const users = (await iconUsage(id)).get(`${id}@${version}@${iconId}`) ?? [];
  if (users.length > 0) throw new LibraryInUseError(`${users.length} diagram${users.length === 1 ? ' uses' : 's use'} this icon; retire it instead.`, users);
  const db = getDb();
  const result = await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('icon_keywords').where('library_id', '=', id).where('library_version', '=', version).where('icon_id', '=', iconId).execute();
    return trx.deleteFrom('icons').where('library_id', '=', id).where('library_version', '=', version).where('id', '=', iconId).executeTakeFirst();
  });
  if (Number(result.numDeletedRows) === 0) throw new LibraryNotFoundError(`No icon ${iconId} in ${id} ${version}.`);
}

/** The diagram types whose palette offers a library. Changing a built-in type marks it edited, so
 *  the catalog seed stops resetting its palette. */
export async function setLibraryPalette(libraryId: string, diagramTypeIds: string[]): Promise<void> {
  const db = getDb();
  const exists = await db.selectFrom('icon_libraries').select('id').where('id', '=', libraryId).executeTakeFirst();
  if (!exists) throw new LibraryNotFoundError(`No library ${libraryId}.`);
  const wanted = new Set(diagramTypeIds);
  if (wanted.size > 0) {
    const known = await db.selectFrom('diagram_types').select('id').where('id', 'in', [...wanted]).execute();
    if (known.length !== wanted.size) throw new LibraryInvalidError('Unknown diagram type.');
  }
  await db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom('diagram_type_palette_libraries').select('diagram_type_id').where('library_id', '=', libraryId).execute();
    const had = new Set(current.map((c) => c.diagram_type_id));
    const changed = [...new Set([...had, ...wanted])].filter((t) => had.has(t) !== wanted.has(t));
    for (const typeId of changed) {
      if (had.has(typeId)) {
        await trx.deleteFrom('diagram_type_palette_libraries').where('diagram_type_id', '=', typeId).where('library_id', '=', libraryId).execute();
      } else {
        const last = await trx
          .selectFrom('diagram_type_palette_libraries')
          .select((eb) => eb.fn.max('position').as('max'))
          .where('diagram_type_id', '=', typeId)
          .executeTakeFirst();
        await trx.insertInto('diagram_type_palette_libraries').values({ diagram_type_id: typeId, library_id: libraryId, position: Number(last?.max ?? -1) + 1 }).execute();
      }
    }
    if (changed.length > 0) {
      await trx.updateTable('diagram_types').set({ admin_edited: dbBoolean(true) }).where('id', 'in', changed).where('origin', '=', 'builtin').execute();
    }
  });
}

/** Which diagrams use a library (or one icon), for the admin page. */
export async function libraryUsage(id: string, version: string, iconId?: string): Promise<DiagramUsage[]> {
  await getLibraryRow(id, version);
  return (await iconUsage(id)).get(iconId ? `${id}@${version}@${iconId}` : `${id}@${version}`) ?? [];
}
