"""Export a diagram as Mermaid, SVG or PNG (phase 6, canvas-1bty.10; apps/api/src/export/*.ts).

- Mermaid: the saved DSL made portable (plain style/linkStyle lines), through the diagram-core bridge.
- SVG: rendered by the bridge, with the icon artwork the diagram uses (looked up here) and, when the
  diagram shows a legend, its type's active standard for the legend's automatic entries.
- PNG: that SVG rasterised by resvg-py, the same Rust renderer as the TypeScript service's
  @resvg/resvg-js, with system fonts off as there, so a PNG doesn't depend on the host's fonts.

Every response is a download (fixed file name) with a locked-down Content-Security-Policy, so an
exported file opened straight from this URL can't run anything, whatever ends up inside the SVG.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

import resvg_py
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import Connection, Engine, bindparam, text

from canvas_api.access import require_diagram_access
from canvas_api.auth.roles import CurrentUser
from canvas_api.catalog import DSL_FAMILIES
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramBridge
from canvas_api.errors import ApiError
from canvas_api.routes.diagrams import get_diagram
from canvas_api.standards import get_active_standard

router = APIRouter(tags=["Export"])
Db = Annotated[Engine, Depends(get_engine)]

#: Inline styles only; everything else blocked, and the response gets an opaque, sandboxed origin.
EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"
CONTENT_TYPES = {"mermaid": "text/plain; charset=utf-8", "svg": "image/svg+xml", "png": "image/png"}
#: A fixed file name, never the diagram's own, so this header can't carry anything a user typed.
CONTENT_DISPOSITIONS = {
    "mermaid": 'attachment; filename="diagram.mmd"',
    "svg": 'attachment; filename="diagram.svg"',
    "png": 'attachment; filename="diagram.png"',
}

_ICON_CANDIDATES = text(
    "SELECT library_id, library_version, id, asset_ref FROM icons WHERE library_id IN :libraries AND id IN :ids"
).bindparams(bindparam("libraries", expanding=True), bindparam("ids", expanding=True))


def _bridge(request: Request) -> DiagramBridge:
    bridge: DiagramBridge | None = request.app.state.diagram_bridge
    if bridge is None:
        raise ApiError(503, "The diagram-core bridge is not configured (DIAGRAM_BRIDGE_URL).")
    return bridge


def _icon_artwork(conn: Connection, model: dict[str, Any]) -> dict[str, str]:
    """ "<libraryId>@<libraryVersion>@<iconId>" -> markup for the icons the model's nodes and groups use.
    A ref with no matching row is simply left out (drawn without artwork, never an error)."""
    refs = {
        f"{icon['libraryId']}@{icon['libraryVersion']}@{icon['iconId']}"
        for element in [*model.get("nodes", []), *model.get("containers", [])]
        if (icon := element.get("icon"))
    }
    if not refs:
        return {}
    libraries = sorted({ref.split("@")[0] for ref in refs})
    ids = sorted({ref.split("@")[2] for ref in refs})
    rows = conn.execute(_ICON_CANDIDATES, {"libraries": libraries, "ids": ids}).all()
    artwork = {f"{r.library_id}@{r.library_version}@{r.id}": r.asset_ref for r in rows}
    return {ref: markup for ref, markup in artwork.items() if ref in refs}


def render_svg(conn: Connection, bridge: DiagramBridge, family: str, dsl: str, diagram_type_id: str) -> str:
    if family not in DSL_FAMILIES:
        raise ApiError(422, f"No DSL family registered for: {family}")
    parsed = bridge.parse(family, dsl)
    if "model" not in parsed:
        errors = json.dumps(parsed.get("errors", []), separators=(",", ":"), ensure_ascii=False)
        raise ApiError(422, f"Diagram could not be rendered — DSL has parse errors: {errors}")
    model: dict[str, Any] = parsed["model"]
    legend = model.get("legend") or {}
    standard = get_active_standard(conn, diagram_type_id) if legend.get("visible") else None
    return bridge.render_svg(
        model, icons=_icon_artwork(conn, model), standard_rules=standard.rules if standard else None
    )


@router.get("/diagrams/{id}/export")
def export(
    id: str,
    request: Request,
    user: CurrentUser,
    db: Db,
    format: Literal["mermaid", "svg", "png"] = "mermaid",
) -> Response:
    bridge = _bridge(request)
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        diagram = get_diagram(conn, id)
        if format == "mermaid":
            body: bytes | str = bridge.portable(diagram["dslContent"])
        else:
            svg = render_svg(conn, bridge, diagram["dslFamily"], diagram["dslContent"], diagram["diagramTypeId"])
            body = svg if format == "svg" else bytes(resvg_py.svg_to_bytes(svg_string=svg, skip_system_fonts=True))
    return Response(
        content=body,
        headers={
            "Content-Type": CONTENT_TYPES[format],
            "Content-Disposition": CONTENT_DISPOSITIONS[format],
            "Content-Security-Policy": EXPORT_CSP,
        },
    )
