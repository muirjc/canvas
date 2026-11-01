"""Icon libraries: the list and icon search (phase 2, canvas-1bty.6).

Ported from apps/api/src/libraries/library.routes.ts and library.service.ts. Loading a library
(POST /libraries) stays in TypeScript with library admin, since it validates through diagram-core.
Retired icons and libraries are never offered (they still render).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Connection, Engine, bindparam, text

from canvas_api.auth.roles import CurrentUser
from canvas_api.db import get_engine

router = APIRouter(tags=["Libraries"])
Db = Annotated[Engine, Depends(get_engine)]

#: Live icons (retired icons and libraries aren't offered), of one library version or of several libraries.
_ICONS_IN_VERSION = text(
    "SELECT icons.library_id, icons.library_version, icons.id, icons.display_name, icons.category, icons.asset_ref"
    " FROM icons JOIN icon_libraries l ON l.id = icons.library_id AND l.version = icons.library_version"
    " WHERE icons.library_id = :id AND icons.library_version = :version"
    " AND icons.retired_at IS NULL AND l.retired_at IS NULL"
)
_ICONS_IN_LIBRARIES = text(
    "SELECT icons.library_id, icons.library_version, icons.id, icons.display_name, icons.category, icons.asset_ref"
    " FROM icons JOIN icon_libraries l ON l.id = icons.library_id AND l.version = icons.library_version"
    " WHERE icons.library_id IN :ids AND icons.retired_at IS NULL AND l.retired_at IS NULL"
).bindparams(bindparam("ids", expanding=True))


def search_icons(icons: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    """diagram-core's searchIcons: a case-insensitive "contains" on name, id or any keyword; everything
    for an empty query."""
    normalized = query.strip().lower()
    if not normalized:
        return icons
    return [
        icon
        for icon in icons
        if normalized in icon["displayName"].lower()
        or normalized in icon["id"].lower()
        or any(normalized in keyword.lower() for keyword in icon["keywords"])
    ]


def _to_icons(conn: Connection, rows: list[Any]) -> list[dict[str, Any]]:
    keywords: dict[tuple[str, str, str], list[str]] = {}
    if rows:
        keyword_rows = conn.execute(
            text(
                "SELECT library_id, library_version, icon_id, keyword FROM icon_keywords"
                " WHERE library_id IN :libraries AND library_version IN :versions"
                " ORDER BY library_id, library_version, icon_id, position"
            ).bindparams(bindparam("libraries", expanding=True), bindparam("versions", expanding=True)),
            {
                "libraries": sorted({r.library_id for r in rows}),
                "versions": sorted({r.library_version for r in rows}),
            },
        ).all()
        for k in keyword_rows:
            keywords.setdefault((k.library_id, k.library_version, k.icon_id), []).append(k.keyword)
    return [
        {
            "libraryId": r.library_id,
            "libraryVersion": r.library_version,
            "id": r.id,
            "displayName": r.display_name,
            "keywords": keywords.get((r.library_id, r.library_version, r.id), []),
            "category": r.category,
            "assetRef": r.asset_ref,
        }
        for r in rows
    ]


@router.get("/libraries")
def list_libraries(_user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT l.id, l.version, l.license, COUNT(i.id) AS icon_count FROM icon_libraries l"
                " LEFT JOIN icons i ON i.library_id = l.id AND i.library_version = l.version"
                " GROUP BY l.id, l.version, l.license ORDER BY l.id, l.version"
            )
        ).all()
    return {
        "libraries": [
            {"id": r.id, "version": r.version, "license": r.license, "iconCount": int(r.icon_count)} for r in rows
        ]
    }


@router.get("/libraries/{id}/versions/{version}/icons")
def search_library(id: str, version: str, _user: CurrentUser, db: Db, query: str = "") -> dict[str, Any]:
    with db.connect() as conn:
        rows = conn.execute(_ICONS_IN_VERSION, {"id": id, "version": version}).all()
        icons = _to_icons(conn, list(rows))
    return {"icons": search_icons(icons, query)}


@router.get("/icons/search")
def search_for_diagram_type(
    _user: CurrentUser,
    db: Db,
    diagramTypeId: Annotated[str, Query(min_length=1)],
    query: str = "",
) -> dict[str, Any]:
    """Search across the diagram type's default palette libraries, library by library."""
    with db.connect() as conn:
        library_ids = [
            r.library_id
            for r in conn.execute(
                text(
                    "SELECT library_id FROM diagram_type_palette_libraries"
                    " WHERE diagram_type_id = :id ORDER BY position"
                ),
                {"id": diagramTypeId},
            )
        ]
        if not library_ids:
            return {"icons": []}
        rows = conn.execute(_ICONS_IN_LIBRARIES, {"ids": library_ids}).all()
        icons = _to_icons(conn, list(rows))
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for icon in icons:
        grouped.setdefault((icon["libraryId"], icon["libraryVersion"]), []).append(icon)
    return {"icons": [icon for group in grouped.values() for icon in search_icons(group, query)]}
