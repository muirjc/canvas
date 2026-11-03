"""Storing an icon/shape library (apps/api/src/libraries/library.service.ts ingestLibrary, array-columns.ts
setLibraryIconKeywords). Used by the catalog seed (canvas_api/seed/) for the bundled packs and by the admin
routes (routes/library_admin.py) for loaded and imported ones.

Like TypeScript, the manifest goes through diagram-core's loadLibrary only (validation, plus its light
sanitizeSvgFragment pass); the strict artwork clean-up is the admin routes' job, never the seed's.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Connection, text

from canvas_api.diagram_core import DiagramCore


class LibraryManifestError(ValueError):
    """diagram-core refused the manifest (loadLibrary's LibraryValidationError); the message is its own."""


_DELETE_KEYWORDS = text("DELETE FROM icon_keywords WHERE library_id = :id AND library_version = :version")
_INSERT_KEYWORD = text(
    "INSERT INTO icon_keywords (library_id, library_version, icon_id, keyword, position)"
    " VALUES (:id, :version, :icon, :keyword, :position)"
)
_UPSERT_LIBRARY = text(
    "INSERT INTO icon_libraries (id, version, license, origin, display_name)"
    " VALUES (:id, :version, :license, :origin, :name)"
    " ON CONFLICT (id, version) DO UPDATE SET license = excluded.license"
)
_UPSERT_ICON = text(
    "INSERT INTO icons (library_id, library_version, id, display_name, category, asset_ref)"
    " VALUES (:library, :version, :id, :name, :category, :asset)"
    " ON CONFLICT (library_id, library_version, id) DO UPDATE SET display_name = excluded.display_name,"
    " category = excluded.category, asset_ref = excluded.asset_ref"
)


def set_library_keywords(conn: Connection, library_id: str, version: str, keywords: dict[str, list[str]]) -> None:
    """Replaces a library version's keywords: one delete, then every icon's words with their positions."""
    conn.execute(_DELETE_KEYWORDS, {"id": library_id, "version": version})
    rows = [
        {"id": library_id, "version": version, "icon": icon_id, "keyword": keyword, "position": position}
        for icon_id, words in keywords.items()
        for position, keyword in enumerate(words)
    ]
    if rows:
        conn.execute(_INSERT_KEYWORD, rows)


def ingest_library(
    conn: Connection, core: DiagramCore, manifest: Any, origin: str = "builtin", display_name: str | None = None
) -> dict[str, Any]:
    """Validates the manifest with diagram-core (LibraryManifestError with its message) and stores it, in the
    caller's transaction. Origin and display name are set when a version is first stored: re-loading it (each
    deploy's catalog seed) updates its license and icons but never its origin, name or retirement."""
    loaded = core.load_library(manifest)
    if not loaded.get("ok"):
        raise LibraryManifestError(str(loaded.get("error")))
    library: dict[str, Any] = loaded["library"]
    conn.execute(
        _UPSERT_LIBRARY,
        {
            "id": library["id"],
            "version": library["version"],
            "license": library.get("license"),
            "origin": origin,
            "name": display_name,
        },
    )
    icons = library.get("icons") or []
    if icons:
        conn.execute(
            _UPSERT_ICON,
            [
                {
                    "library": library["id"],
                    "version": library["version"],
                    "id": icon["id"],
                    "name": icon["displayName"],
                    "category": icon["category"],
                    "asset": icon["assetRef"],
                }
                for icon in icons
            ],
        )
    set_library_keywords(
        conn, library["id"], library["version"], {icon["id"]: list(icon.get("keywords") or []) for icon in icons}
    )
    return library
