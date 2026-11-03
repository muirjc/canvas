"""Admin -> Libraries, and loading a built-in library (phase 10, canvas-1bty.14; apps/api/src/libraries/
library-admin.routes.ts, library-admin.service.ts, library.routes.ts POST /libraries, library.service.ts
ingestLibrary).

Built-in libraries (the catalog seed's) can only be retired or restored; custom ones (imported here from SVG
files or a manifest) are fully editable. Retiring hides a library or icon from palettes and search while the
diagrams that use it keep rendering it; deleting is only for a custom library or icon nothing uses. Every
change is audited (icon_library_changed). The SVG clean-up, manifest validation and reading which diagrams
use an icon are diagram-core's.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Request, Response
from pydantic import BaseModel, Field, StrictStr
from sqlalchemy import Connection, Engine, bindparam, text

from canvas_api.audit import client_ip, record_audit
from canvas_api.auth.roles import AdminUser
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.jsvalues import js_template
from canvas_api.errors import ApiError
from canvas_api.github.jstext import JS_WHITESPACE, js_len, js_number, js_slice, js_trim
from canvas_api.library_store import LibraryManifestError, ingest_library, set_library_keywords
from canvas_api.timestamps import to_api

router = APIRouter(tags=["Libraries"])
Db = Annotated[Engine, Depends(get_engine)]

MAX_ICONS_PER_IMPORT = 1000
#: Icons are cleaned up in chunks of this size (from when an HTTP bridge with a 10 MB limit did it).
_CHUNK_CHARS = 4 * 1024 * 1024
_MANIFEST_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,59}")
_MANIFEST_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,29}")


class UploadedIcon(BaseModel):
    fileName: StrictStr = Field(min_length=1, max_length=255)
    svg: StrictStr = Field(min_length=1)
    displayName: StrictStr | None = Field(default=None, max_length=120)
    category: StrictStr | None = Field(default=None, max_length=60)
    keywords: list[Annotated[StrictStr, Field(max_length=60)]] | None = Field(default=None, max_length=20)


class ImportSvgBody(BaseModel):
    name: StrictStr = Field(max_length=120)
    license: StrictStr | None = Field(default=None, max_length=2000)
    icons: list[UploadedIcon]


class ImportManifestBody(BaseModel):
    name: StrictStr | None = Field(default=None, max_length=120)
    manifest: dict[str, Any]


class AddIconsBody(BaseModel):
    icons: list[UploadedIcon]


class UpdateLibraryBody(BaseModel):
    name: StrictStr | None = Field(default=None, max_length=120)
    license: Annotated[StrictStr, Field(max_length=2000)] | None = None


class UpdateIconBody(BaseModel):
    displayName: StrictStr | None = Field(default=None, max_length=120)
    category: StrictStr | None = Field(default=None, max_length=60)
    keywords: list[Annotated[StrictStr, Field(max_length=60)]] | None = Field(default=None, max_length=20)
    svg: StrictStr | None = Field(default=None, min_length=1)


class PaletteBody(BaseModel):
    diagramTypeIds: list[StrictStr] = Field(max_length=500)


def _diagram_core(request: Request) -> DiagramCore:
    diagram_core: DiagramCore = request.app.state.diagram_core
    return diagram_core


def _not_found(message: str) -> ApiError:
    return ApiError(404, message)


def _invalid(message: str) -> ApiError:
    return ApiError(400, message)


def _at_least_one_field(body: BaseModel) -> None:
    if not body.model_fields_set:
        raise ApiError(400, "body must NOT have fewer than 1 properties")


def _audit(conn: Connection, request: Request, admin: AdminUser, detail: dict[str, Any]) -> None:
    record_audit(conn, "icon_library_changed", actor_user_id=admin.id, ip=client_ip(request), detail=detail)


def _chunks(items: list[dict[str, Any]], size_of: Any) -> list[list[dict[str, Any]]]:
    out: list[list[dict[str, Any]]] = [[]]
    size = 0
    for item in items:
        n = size_of(item)
        if out[-1] and size + n > _CHUNK_CHARS:
            out.append([])
            size = 0
        out[-1].append(item)
        size += n
    return [c for c in out if c]


# --- names -----------------------------------------------------------------------------------------


def slugify(value: str, fallback: str = "icon") -> str:
    """apps/api's slugify: ASCII letters and digits joined by "-", at most 60 characters."""
    slug = unicodedata.normalize("NFKD", value)
    slug = re.sub("[̀-ͯ]", "", slug).lower()
    slug = re.sub(r"\.svg$", "", slug, flags=re.IGNORECASE)
    slug = re.sub(r"[^a-z0-9]+", "-", slug).strip("-")
    slug = slug[:60].rstrip("-")
    return slug or fallback


def _name_from_file(file_name: str) -> str:
    """ "cloud-storage_v2.svg" -> "Cloud storage v2"."""
    base = re.sub(r"^.*[\\/]", "", file_name, flags=re.DOTALL)
    base = re.sub(r"\.svg$", "", base, flags=re.IGNORECASE)
    base = js_trim(re.sub(r"[-_]+", " ", base))
    if not base:
        return "Icon"
    first = js_slice(base, 0, 1)
    return first.upper() + js_slice(base, js_len(first))


# --- which diagrams use what -----------------------------------------------------------------------

_LIVE_DIAGRAMS = text(
    "SELECT d.id, d.name, d.project_id, t.dsl_family, v.dsl_content FROM diagrams d"
    " JOIN diagram_versions v ON v.id = d.current_version_id JOIN diagram_types t ON t.id = d.diagram_type_id"
    " WHERE d.deleted_at IS NULL"
)


def _icon_usage(conn: Connection, core: DiagramCore, library_id: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Which live diagrams use each library version and icon: keys "<lib>@<version>" and
    "<lib>@<version>@<icon>"."""
    candidates = []
    for row in conn.execute(_LIVE_DIAGRAMS):
        # Cheap filter first: icon refs are saved in front-matter under `libraryId`, except an architecture
        # diagram's built-in icons, which its own syntax names (`service db(database)`).
        mentions = library_id in row.dsl_content if library_id else "libraryId" in row.dsl_content
        if mentions or row.dsl_family == "architecture":
            candidates.append({"row": row, "family": row.dsl_family, "dsl": row.dsl_content})
    usage: dict[str, list[dict[str, Any]]] = {}
    for chunk in _chunks(candidates, lambda c: len(c["dsl"])):
        refs = core.icon_refs([{"family": c["family"], "dsl": c["dsl"]} for c in chunk])
        for candidate, found in zip(chunk, refs, strict=True):
            if found is None:
                continue
            row = candidate["row"]
            seen: set[str] = set()
            for ref in found:
                if library_id and ref.get("libraryId") != library_id:
                    continue
                library_key = f"{ref.get('libraryId')}@{ref.get('libraryVersion')}"
                for key in (library_key, f"{library_key}@{ref.get('iconId')}"):
                    if key in seen:
                        continue
                    seen.add(key)
                    usage.setdefault(key, []).append(
                        {"id": str(row.id), "name": row.name, "projectId": str(row.project_id)}
                    )
    return usage


# --- reading ---------------------------------------------------------------------------------------


def _library_row(conn: Connection, library_id: str, version: str) -> Any:
    row = conn.execute(
        text("SELECT id, version, origin FROM icon_libraries WHERE id = :id AND version = :version"),
        {"id": library_id, "version": version},
    ).first()
    if row is None:
        raise _not_found(f"No library {library_id} {version}.")
    return row


def _require_custom(conn: Connection, library_id: str, version: str) -> None:
    if _library_row(conn, library_id, version).origin != "custom":
        raise _invalid("Built-in libraries can only be retired or restored, not edited.")


def _admin_libraries(conn: Connection, core: DiagramCore) -> list[dict[str, Any]]:
    libraries = conn.execute(
        text(
            "SELECT id, version, display_name, origin, license, retired_at FROM icon_libraries"
            " ORDER BY origin, id, version"
        )
    ).all()
    counts = {
        (r.library_id, r.library_version): (int(r.n), int(r.retired))
        for r in conn.execute(
            text(
                "SELECT library_id, library_version, COUNT(*) AS n, COUNT(retired_at) AS retired FROM icons"
                " GROUP BY library_id, library_version"
            )
        )
    }
    palette = conn.execute(
        text(
            "SELECT p.library_id, t.id, t.name FROM diagram_type_palette_libraries p"
            " JOIN diagram_types t ON t.id = p.diagram_type_id ORDER BY t.name"
        )
    ).all()
    usage = _icon_usage(conn, core)
    result = []
    for lib in libraries:
        n, retired = counts.get((lib.id, lib.version), (0, 0))
        result.append(
            {
                "id": lib.id,
                "version": lib.version,
                "name": lib.display_name if lib.display_name is not None else lib.id,
                "origin": lib.origin,
                "license": lib.license,
                "iconCount": n,
                "retiredIconCount": retired,
                "retiredAt": to_api(lib.retired_at),
                "diagramTypes": [{"id": p.id, "name": p.name} for p in palette if p.library_id == lib.id],
                "usedByDiagramCount": len(usage.get(f"{lib.id}@{lib.version}", [])),
            }
        )
    return result


def _find_library(conn: Connection, core: DiagramCore, library_id: str, version: str) -> dict[str, Any]:
    return next(lib for lib in _admin_libraries(conn, core) if lib["id"] == library_id and lib["version"] == version)


_KEYWORDS = text(
    "SELECT icon_id, keyword FROM icon_keywords WHERE library_id = :id AND library_version = :version"
    " ORDER BY icon_id, position"
)


def _keywords(conn: Connection, library_id: str, version: str) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    for r in conn.execute(_KEYWORDS, {"id": library_id, "version": version}):
        found.setdefault(r.icon_id, []).append(r.keyword)
    return found


def _set_keywords(conn: Connection, library_id: str, version: str, keywords: dict[str, list[str]]) -> None:
    """Replaces a library version's keywords (array-columns.ts setLibraryIconKeywords)."""
    set_library_keywords(conn, library_id, version, keywords)


@router.get("/admin/libraries")
def list_libraries(request: Request, _admin: AdminUser, db: Db) -> dict[str, Any]:
    core = _diagram_core(request)
    with db.connect() as conn:
        return {"libraries": _admin_libraries(conn, core)}


@router.get("/admin/libraries/{id}/{version}/icons")
def list_icons(id: str, version: str, request: Request, _admin: AdminUser, db: Db) -> dict[str, Any]:
    core = _diagram_core(request)
    with db.connect() as conn:
        _library_row(conn, id, version)
        rows = conn.execute(
            text(
                "SELECT id, display_name, category, asset_ref, retired_at FROM icons"
                " WHERE library_id = :id AND library_version = :version ORDER BY display_name"
            ),
            {"id": id, "version": version},
        ).all()
        keywords = _keywords(conn, id, version)
        usage = _icon_usage(conn, core, id)
    return {
        "icons": [
            {
                "id": r.id,
                "displayName": r.display_name,
                "category": r.category,
                "keywords": keywords.get(r.id, []),
                "assetRef": r.asset_ref,
                "retiredAt": to_api(r.retired_at),
                "usedByDiagramCount": len(usage.get(f"{id}@{version}@{r.id}", [])),
            }
            for r in rows
        ]
    }


@router.get("/admin/libraries/{id}/{version}/usage")
def usage(
    id: str, version: str, request: Request, _admin: AdminUser, db: Db, iconId: str | None = None
) -> dict[str, Any]:
    """Which diagrams use a library (or one icon), for the admin page."""
    core = _diagram_core(request)
    with db.connect() as conn:
        _library_row(conn, id, version)
        found = _icon_usage(conn, core, id)
    return {"diagrams": found.get(f"{id}@{version}@{iconId}" if iconId else f"{id}@{version}", [])}


# --- loading a library -----------------------------------------------------------------------------


def _ingest(
    conn: Connection,
    core: DiagramCore,
    manifest: Any,
    origin: str,
    display_name: str | None,
) -> dict[str, Any]:
    """library.service.ts ingestLibrary (canvas_api/library_store.py), with diagram-core's refusal as a 400.
    Re-loading a version updates its icons but never its origin, name or retirement."""
    try:
        return ingest_library(conn, core, manifest, origin, display_name)
    except LibraryManifestError as exc:
        raise _invalid(str(exc)) from exc


@router.post("/libraries", status_code=201)
def load_builtin(request: Request, _admin: AdminUser, db: Db, body: Annotated[Any, Body()] = None) -> dict[str, Any]:
    """Loads a library as BUILT-IN (the catalog seed's path; tests use it for the bundled packs). Admins import
    custom libraries through /admin/libraries/import-* instead, which checks the artwork strictly."""
    core = _diagram_core(request)
    if not isinstance(body, dict):
        raise _invalid("Library manifest requires both id and version")
    body = _strict_artwork(core, body)
    with db.begin() as conn:
        library = _ingest(conn, core, body, "builtin", None)
    return {"status": "ingested", "id": library["id"], "version": library["version"]}


_LEADING_SPACE = re.compile(f"^[{JS_WHITESPACE}]+")


def _template_of(record: dict[str, Any], key: str) -> str:
    """`${record[key]}` in TypeScript: "undefined" for an absent key."""
    return js_template(record[key]) if key in record else "undefined"


def _strict_artwork(core: DiagramCore, manifest: dict[str, Any]) -> dict[str, Any]:
    """canvas-1bty.19: markup artwork through the strict allowlist (a path or URL reference is left alone), as
    TypeScript's POST /libraries. The seed loads the bundled packs directly and keeps them as shipped."""
    icons = manifest.get("icons")
    if not isinstance(icons, list):
        return manifest
    picked = [
        (i, icon)
        for i, icon in enumerate(icons)
        if isinstance(icon, dict)
        and isinstance(icon.get("assetRef"), str)
        and _LEADING_SPACE.sub("", icon["assetRef"], count=1).startswith("<")
    ]
    items = [
        {"svg": icon["assetRef"], "idPrefix": f"{_template_of(manifest, 'id')}-{_template_of(icon, 'id')}"}
        for _, icon in picked
    ]
    results: list[dict[str, Any]] = []
    for chunk in _chunks(items, lambda item: len(item["svg"])):
        results.extend(core.svg_sanitize_strict(chunk))
    cleaned = list(icons)
    for (i, icon), result in zip(picked, results, strict=True):
        if not result.get("ok"):
            raise _invalid(str(result.get("error")))
        cleaned[i] = {**icon, "assetRef": result["assetRef"]}
    return {**manifest, "icons": cleaned}


def _prepare_icons(
    core: DiagramCore, library_id: str, uploads: list[UploadedIcon], taken: set[str]
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Uploaded files -> manifest icons; files that can't be used are reported, not fatal.

    As the TypeScript loop: each file gets the first free id from its name, and a file that can't be used
    doesn't take one. Whether a file is usable doesn't depend on its id, so the files are cleaned up in
    batches, ids are then given to the usable ones in order, and only a file whose id came out different
    (an earlier file of the same name was refused) is cleaned up again under its real id.
    """

    def assign(usable: list[bool]) -> list[str | None]:
        ids: list[str | None] = []
        claimed = set(taken)
        for upload, ok in zip(uploads, usable, strict=True):
            if not ok:
                ids.append(None)
                continue
            icon_id = slugify(upload.fileName)
            n = 2
            while icon_id in claimed:
                icon_id = f"{slugify(upload.fileName)}-{n}"
                n += 1
            claimed.add(icon_id)
            ids.append(icon_id)
        return ids

    def prepare(pairs: list[tuple[str, str]]) -> list[dict[str, Any]]:
        items = [{"svg": svg, "idPrefix": prefix} for svg, prefix in pairs]
        results: list[dict[str, Any]] = []
        for chunk in _chunks(items, lambda item: len(item["svg"])):
            results.extend(core.svg_prepare(chunk))
        return results

    first_ids = assign([True] * len(uploads))
    results = prepare([(u.svg, f"{library_id}-{i}") for u, i in zip(uploads, first_ids, strict=True)])
    ids = assign([bool(r.get("ok")) for r in results])
    redo = [k for k, (old, new) in enumerate(zip(first_ids, ids, strict=True)) if new is not None and new != old]
    for k, result in zip(redo, prepare([(uploads[k].svg, f"{library_id}-{ids[k]}") for k in redo]), strict=True):
        results[k] = result
    icons, rejected = [], []
    for upload, icon_id, result in zip(uploads, ids, results, strict=True):
        if icon_id is None or not result.get("ok"):
            rejected.append({"fileName": upload.fileName, "reason": str(result.get("error"))})
            continue
        taken.add(icon_id)
        icons.append(
            {
                "id": icon_id,
                "displayName": js_trim(upload.displayName or "") or _name_from_file(upload.fileName),
                "category": js_trim(upload.category or "") or "General",
                "keywords": [k for k in (js_trim(k) for k in (upload.keywords or [])) if k][:20],
                "assetRef": result["assetRef"],
            }
        )
    return icons, rejected


def _none_usable(rejected: list[dict[str, str]]) -> ApiError:
    return _invalid(
        "None of the files could be used: " + "; ".join(f"{r['fileName']} ({r['reason']})" for r in rejected)
    )


def _unique_library_id(conn: Connection, name: str) -> str:
    base = slugify(name, "library")
    n = 1
    while True:
        library_id = base if n == 1 else f"{base}-{n}"
        if conn.execute(text("SELECT id FROM icon_libraries WHERE id = :id"), {"id": library_id}).first() is None:
            return library_id
        n += 1


@router.post("/admin/libraries/import-svg", status_code=201)
def import_svg(request: Request, admin: AdminUser, db: Db, body: ImportSvgBody) -> dict[str, Any]:
    """A new custom library from uploaded SVG files."""
    core = _diagram_core(request)
    name = js_trim(body.name)
    if not name:
        raise _invalid("Give the library a name.")
    if not body.icons:
        raise _invalid("Choose at least one SVG file.")
    if len(body.icons) > MAX_ICONS_PER_IMPORT:
        raise _invalid(f"At most {MAX_ICONS_PER_IMPORT} icons per import.")
    with db.begin() as conn:
        library_id = _unique_library_id(conn, name)
        icons, rejected = _prepare_icons(core, library_id, body.icons, set())
        if not icons:
            raise _none_usable(rejected)
        license_text = js_trim(body.license or "") or None
        manifest = {
            "id": library_id,
            "version": "1",
            "icons": icons,
            **({"license": license_text} if license_text else {}),
        }
        _ingest(conn, core, manifest, "custom", name)
        library = _find_library(conn, core, library_id, "1")
        _audit(
            conn,
            request,
            admin,
            {
                "action": "imported",
                "libraryId": library_id,
                "version": "1",
                "icons": library["iconCount"],
                "from": "svg",
            },
        )
    return {"library": library, "rejected": rejected}


@router.post("/admin/libraries/import-manifest", status_code=201)
def import_manifest(request: Request, admin: AdminUser, db: Db, body: ImportManifestBody) -> dict[str, Any]:
    """A custom library from a manifest (the bundled packs' format; artwork already in 48x48 space)."""
    core = _diagram_core(request)
    manifest = body.manifest
    library_id, version, raw_icons = manifest.get("id"), manifest.get("version"), manifest.get("icons")
    if not isinstance(library_id, str) or not isinstance(version, str) or not isinstance(raw_icons, list):
        raise _invalid("The manifest needs an id, a version and an icons list.")
    if not _MANIFEST_ID.fullmatch(library_id) or not _MANIFEST_VERSION.fullmatch(version):
        raise _invalid(
            'The manifest id must be lower-case letters, numbers, "-", "_" or "."; the version letters, numbers, ".",'
            ' "-" or "_".'
        )
    if not raw_icons or len(raw_icons) > MAX_ICONS_PER_IMPORT:
        raise _invalid(f"A manifest needs 1 to {MAX_ICONS_PER_IMPORT} icons.")
    with db.begin() as conn:
        existing = conn.execute(text("SELECT origin FROM icon_libraries WHERE id = :id"), {"id": library_id}).first()
        if existing is not None and existing.origin == "builtin":
            raise ApiError(409, f'"{library_id}" is a built-in library; give yours a different id.')
        same_version = conn.execute(
            text("SELECT id FROM icon_libraries WHERE id = :id AND version = :version"),
            {"id": library_id, "version": version},
        ).first()
        if same_version is not None:
            raise ApiError(409, f"Library {library_id} version {version} already exists.")
        for icon in raw_icons:
            if (
                not isinstance(icon, dict)
                or not isinstance(icon.get("id"), str)
                or not isinstance(icon.get("assetRef"), str)
            ):
                raise _invalid("Every icon needs an id and assetRef.")
        items = [{"svg": icon["assetRef"], "idPrefix": f"{library_id}-{icon['id']}"} for icon in raw_icons]
        results: list[dict[str, Any]] = []
        for chunk in _chunks(items, lambda item: len(item["svg"])):
            results.extend(core.svg_sanitize_strict(chunk))
        icons = []
        for icon, result in zip(raw_icons, results, strict=True):
            if not result.get("ok"):
                raise _invalid(str(result.get("error")))
            keywords = icon.get("keywords")
            icons.append(
                {
                    "id": icon["id"],
                    "displayName": _js_string(icon.get("displayName"), icon["id"]),
                    "category": _js_string(icon.get("category"), "General"),
                    "keywords": [_js_string(k, "") for k in keywords][:20] if isinstance(keywords, list) else [],
                    "assetRef": result["assetRef"],
                }
            )
        clean = {"id": library_id, "version": version, "icons": icons}
        if manifest.get("license") is not None:
            clean["license"] = manifest["license"]
        _ingest(conn, core, clean, "custom", js_trim(body.name or "") or None)
        library = _find_library(conn, core, library_id, version)
        _audit(
            conn,
            request,
            admin,
            {
                "action": "imported",
                "libraryId": library_id,
                "version": version,
                "icons": library["iconCount"],
                "from": "manifest",
            },
        )
    return {"library": library}


def _js_string(value: Any, fallback: str) -> str:
    """String(value ?? fallback) for the JSON values a manifest can hold."""
    if value is None:
        return fallback
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int | float):
        return js_number(float(value)) if isinstance(value, float) else str(value)
    if isinstance(value, list):
        return ",".join("" if v is None else _js_string(v, "") for v in value)
    return "[object Object]"


# --- editing ---------------------------------------------------------------------------------------


@router.patch("/admin/libraries/{id}/{version}", status_code=204)
def update_library(
    id: str, version: str, request: Request, admin: AdminUser, db: Db, body: UpdateLibraryBody
) -> Response:
    _at_least_one_field(body)
    given = body.model_fields_set
    with db.begin() as conn:
        _require_custom(conn, id, version)
        name = js_trim(body.name) if body.name is not None else None
        if "name" in given and body.name is not None and not name:
            raise _invalid("The library needs a name.")
        if name is not None:
            conn.execute(
                text("UPDATE icon_libraries SET display_name = :name WHERE id = :id AND version = :version"),
                {"name": name, "id": id, "version": version},
            )
        if "license" in given:
            conn.execute(
                text("UPDATE icon_libraries SET license = :license WHERE id = :id AND version = :version"),
                {"license": js_trim(body.license or "") or None, "id": id, "version": version},
            )
        _audit(conn, request, admin, {"action": "updated", "libraryId": id, "version": version})
    return Response(status_code=204)


@router.post("/admin/libraries/{id}/{version}/icons", status_code=201)
def add_icons(id: str, version: str, request: Request, admin: AdminUser, db: Db, body: AddIconsBody) -> dict[str, Any]:
    core = _diagram_core(request)
    with db.begin() as conn:
        _require_custom(conn, id, version)
        if not body.icons or len(body.icons) > MAX_ICONS_PER_IMPORT:
            raise _invalid(f"Add 1 to {MAX_ICONS_PER_IMPORT} SVG files.")
        existing = {
            r.id
            for r in conn.execute(
                text("SELECT id FROM icons WHERE library_id = :id AND library_version = :version"),
                {"id": id, "version": version},
            )
        }
        icons, rejected = _prepare_icons(core, id, body.icons, existing)
        if not icons:
            raise _none_usable(rejected)
        conn.execute(
            text(
                "INSERT INTO icons (library_id, library_version, id, display_name, category, asset_ref)"
                " VALUES (:library, :version, :id, :name, :category, :asset)"
            ),
            [
                {
                    "library": id,
                    "version": version,
                    "id": icon["id"],
                    "name": icon["displayName"],
                    "category": icon["category"],
                    "asset": icon["assetRef"],
                }
                for icon in icons
            ],
        )
        keywords = _keywords(conn, id, version)
        for icon in icons:
            keywords[icon["id"]] = icon["keywords"]
        _set_keywords(conn, id, version, _in_icon_order(conn, id, version, keywords))
        added = [icon["id"] for icon in icons]
        _audit(conn, request, admin, {"action": "icons_added", "libraryId": id, "version": version, "icons": added})
    return {"added": added, "rejected": rejected}


def _in_icon_order(
    conn: Connection, library_id: str, version: str, keywords: dict[str, list[str]]
) -> dict[str, list[str]]:
    """Every icon of the version, with its keywords (none when it has none)."""
    ids = [
        r.id
        for r in conn.execute(
            text("SELECT id FROM icons WHERE library_id = :id AND library_version = :version"),
            {"id": library_id, "version": version},
        )
    ]
    return {icon_id: keywords.get(icon_id, []) for icon_id in ids}


@router.patch("/admin/libraries/{id}/{version}/icons/{iconId}", status_code=204)
def update_icon(
    id: str, version: str, iconId: str, request: Request, admin: AdminUser, db: Db, body: UpdateIconBody
) -> Response:
    _at_least_one_field(body)
    core = _diagram_core(request)
    with db.begin() as conn:
        _require_custom(conn, id, version)
        exists = conn.execute(
            text("SELECT id FROM icons WHERE library_id = :id AND library_version = :version AND id = :icon"),
            {"id": id, "version": version, "icon": iconId},
        ).first()
        if exists is None:
            raise _not_found(f"No icon {iconId} in {id} {version}.")
        asset_ref = None
        if body.svg is not None:
            result = core.svg_prepare([{"svg": body.svg, "idPrefix": f"{id}-{iconId}"}])[0]
            if not result.get("ok"):
                raise _invalid(str(result.get("error")))
            asset_ref = result["assetRef"]
        display_name = js_trim(body.displayName) if body.displayName is not None else None
        if body.displayName is not None and not display_name:
            raise _invalid("The icon needs a name.")
        where = {"id": id, "version": version, "icon": iconId}
        if display_name is not None:
            conn.execute(
                text(
                    "UPDATE icons SET display_name = :v"
                    " WHERE library_id = :id AND library_version = :version AND id = :icon"
                ),
                {**where, "v": display_name},
            )
        if body.category is not None:
            conn.execute(
                text(
                    "UPDATE icons SET category = :v"
                    " WHERE library_id = :id AND library_version = :version AND id = :icon"
                ),
                {**where, "v": js_trim(body.category) or "General"},
            )
        if asset_ref is not None:
            conn.execute(
                text(
                    "UPDATE icons SET asset_ref = :v"
                    " WHERE library_id = :id AND library_version = :version AND id = :icon"
                ),
                {**where, "v": asset_ref},
            )
        if body.keywords is not None:
            keywords = _keywords(conn, id, version)
            keywords[iconId] = [k for k in (js_trim(k) for k in body.keywords) if k][:20]
            _set_keywords(conn, id, version, _in_icon_order(conn, id, version, keywords))
        _audit(
            conn,
            request,
            admin,
            {
                "action": "icon_updated",
                "libraryId": id,
                "version": version,
                "iconId": iconId,
                "replacedArtwork": body.svg is not None,
            },
        )
    return Response(status_code=204)


def _set_library_retired(
    id: str, version: str, retired: bool, request: Request, admin: AdminUser, db: Engine
) -> Response:
    with db.begin() as conn:
        _library_row(conn, id, version)
        statement = (
            "UPDATE icon_libraries SET retired_at = CURRENT_TIMESTAMP WHERE id = :id AND version = :version"
            if retired
            else "UPDATE icon_libraries SET retired_at = NULL WHERE id = :id AND version = :version"
        )
        conn.execute(text(statement), {"id": id, "version": version})
        _audit(
            conn, request, admin, {"action": "retired" if retired else "restored", "libraryId": id, "version": version}
        )
    return Response(status_code=204)


def _set_icon_retired(
    id: str, version: str, icon_id: str, retired: bool, request: Request, admin: AdminUser, db: Engine
) -> Response:
    with db.begin() as conn:
        _library_row(conn, id, version)
        statement = (
            "UPDATE icons SET retired_at = CURRENT_TIMESTAMP"
            " WHERE library_id = :id AND library_version = :version AND id = :icon"
            if retired
            else "UPDATE icons SET retired_at = NULL"
            " WHERE library_id = :id AND library_version = :version AND id = :icon"
        )
        if not conn.execute(text(statement), {"id": id, "version": version, "icon": icon_id}).rowcount:
            raise _not_found(f"No icon {icon_id} in {id} {version}.")
        _audit(
            conn,
            request,
            admin,
            {
                "action": "icon_retired" if retired else "icon_restored",
                "libraryId": id,
                "version": version,
                "iconId": icon_id,
            },
        )
    return Response(status_code=204)


@router.post("/admin/libraries/{id}/{version}/retire", status_code=204)
def retire_library(id: str, version: str, request: Request, admin: AdminUser, db: Db) -> Response:
    return _set_library_retired(id, version, True, request, admin, db)


@router.post("/admin/libraries/{id}/{version}/restore", status_code=204)
def restore_library(id: str, version: str, request: Request, admin: AdminUser, db: Db) -> Response:
    return _set_library_retired(id, version, False, request, admin, db)


@router.post("/admin/libraries/{id}/{version}/icons/{iconId}/retire", status_code=204)
def retire_icon(id: str, version: str, iconId: str, request: Request, admin: AdminUser, db: Db) -> Response:
    return _set_icon_retired(id, version, iconId, True, request, admin, db)


@router.post("/admin/libraries/{id}/{version}/icons/{iconId}/restore", status_code=204)
def restore_icon(id: str, version: str, iconId: str, request: Request, admin: AdminUser, db: Db) -> Response:
    return _set_icon_retired(id, version, iconId, False, request, admin, db)


def _in_use(users: list[dict[str, Any]], what: str) -> ApiError:
    count = len(users)
    uses = "diagram uses" if count == 1 else "diagrams use"
    return ApiError(409, f"{count} {uses} this {what}; retire it instead.", code="in_use", diagrams=users)


@router.delete("/admin/libraries/{id}/{version}", status_code=204)
def delete_library(id: str, version: str, request: Request, admin: AdminUser, db: Db) -> Response:
    core = _diagram_core(request)
    with db.begin() as conn:
        _require_custom(conn, id, version)
        users = _icon_usage(conn, core, id).get(f"{id}@{version}", [])
        if users:
            raise _in_use(users, "library")
        where = {"id": id, "version": version}
        conn.execute(text("DELETE FROM icon_keywords WHERE library_id = :id AND library_version = :version"), where)
        conn.execute(text("DELETE FROM icons WHERE library_id = :id AND library_version = :version"), where)
        conn.execute(text("DELETE FROM icon_libraries WHERE id = :id AND version = :version"), where)
        if conn.execute(text("SELECT id FROM icon_libraries WHERE id = :id"), {"id": id}).first() is None:
            conn.execute(text("DELETE FROM diagram_type_palette_libraries WHERE library_id = :id"), {"id": id})
        _audit(conn, request, admin, {"action": "deleted", "libraryId": id, "version": version})
    return Response(status_code=204)


@router.delete("/admin/libraries/{id}/{version}/icons/{iconId}", status_code=204)
def delete_icon(id: str, version: str, iconId: str, request: Request, admin: AdminUser, db: Db) -> Response:
    core = _diagram_core(request)
    with db.begin() as conn:
        _require_custom(conn, id, version)
        users = _icon_usage(conn, core, id).get(f"{id}@{version}@{iconId}", [])
        if users:
            raise _in_use(users, "icon")
        where = {"id": id, "version": version, "icon": iconId}
        conn.execute(
            text("DELETE FROM icon_keywords WHERE library_id = :id AND library_version = :version AND icon_id = :icon"),
            where,
        )
        deleted = conn.execute(
            text("DELETE FROM icons WHERE library_id = :id AND library_version = :version AND id = :icon"), where
        )
        if not deleted.rowcount:
            raise _not_found(f"No icon {iconId} in {id} {version}.")
        _audit(conn, request, admin, {"action": "icon_deleted", "libraryId": id, "version": version, "iconId": iconId})
    return Response(status_code=204)


_KNOWN_TYPES = text("SELECT id FROM diagram_types WHERE id IN :ids").bindparams(bindparam("ids", expanding=True))


@router.put("/admin/libraries/{id}/diagram-types", status_code=204)
def set_palette(id: str, request: Request, admin: AdminUser, db: Db, body: PaletteBody) -> Response:
    """The diagram types whose palette offers a library. Changing a built-in type marks it edited, so the
    catalog seed stops resetting its palette."""
    wanted = list(dict.fromkeys(body.diagramTypeIds))
    with db.begin() as conn:
        if conn.execute(text("SELECT id FROM icon_libraries WHERE id = :id"), {"id": id}).first() is None:
            raise _not_found(f"No library {id}.")
        if wanted and len(conn.execute(_KNOWN_TYPES, {"ids": wanted}).all()) != len(wanted):
            raise _invalid("Unknown diagram type.")
        had = [
            r.diagram_type_id
            for r in conn.execute(
                text("SELECT diagram_type_id FROM diagram_type_palette_libraries WHERE library_id = :id"), {"id": id}
            )
        ]
        changed = [t for t in dict.fromkeys([*had, *wanted]) if (t in had) != (t in wanted)]
        for type_id in changed:
            if type_id in had:
                conn.execute(
                    text(
                        "DELETE FROM diagram_type_palette_libraries WHERE diagram_type_id = :type AND library_id = :id"
                    ),
                    {"type": type_id, "id": id},
                )
            else:
                last = conn.execute(
                    text("SELECT MAX(position) FROM diagram_type_palette_libraries WHERE diagram_type_id = :type"),
                    {"type": type_id},
                ).scalar()
                conn.execute(
                    text(
                        "INSERT INTO diagram_type_palette_libraries (diagram_type_id, library_id, position)"
                        " VALUES (:type, :id, :position)"
                    ),
                    {"type": type_id, "id": id, "position": (-1 if last is None else int(last)) + 1},
                )
        if changed:
            conn.execute(
                text("UPDATE diagram_types SET admin_edited = :yes WHERE id IN :ids AND origin = 'builtin'").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"yes": True, "ids": changed},
            )
        _audit(conn, request, admin, {"action": "palette_set", "libraryId": id, "diagramTypeIds": body.diagramTypeIds})
    return Response(status_code=204)
