"""Export a diagram as Mermaid, SVG or PNG (phase 6, canvas-1bty.10; apps/api/src/export/*.ts).

- Mermaid: the saved DSL made portable (plain style/linkStyle lines), by diagram-core.
- SVG: rendered by diagram-core, with the icon artwork the diagram uses (looked up here) and, when the
  diagram shows a legend, its type's active standard for the legend's automatic entries.
- PNG: that SVG rasterised by resvg-py. System fonts stay off, so a PNG doesn't depend on the host;
  the text is drawn in the bundled Liberation Sans (canvas_api/fonts, SIL OFL 1.1), which the SVG's
  font stack reaches through its final `sans-serif` (canvas-dyvn: with no font at all, resvg drew the
  shapes and silently dropped every label).

Every response is a download (fixed file name) with a locked-down Content-Security-Policy, so an
exported file opened straight from this URL can't run anything, whatever ends up inside the SVG.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any, Literal

import resvg_py
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import Connection, Engine, bindparam, text

from canvas_api.access import require_diagram_access
from canvas_api.auth.roles import CurrentUser
from canvas_api.catalog import DSL_FAMILIES
from canvas_api.config import Settings
from canvas_api.db import get_engine
from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_links import diagram_link_base
from canvas_api.errors import ApiError
from canvas_api.routes.diagrams import get_diagram
from canvas_api.standards import get_active_standard
from canvas_api.telemetry import work_span

router = APIRouter(tags=["Export"])

#: The fonts a PNG's text is drawn in: regular and bold (the renderer uses both, nothing italic).
FONTS_DIR = Path(__file__).resolve().parents[1] / "fonts"
FONT_FILES = [str(FONTS_DIR / "LiberationSans-Regular.ttf"), str(FONTS_DIR / "LiberationSans-Bold.ttf")]
FONT_FAMILY = "Liberation Sans"
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


def _diagram_core(request: Request) -> DiagramCore:
    diagram_core: DiagramCore = request.app.state.diagram_core
    return diagram_core


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


def render_svg(
    conn: Connection,
    core: DiagramCore,
    family: str,
    dsl: str,
    diagram_type_id: str,
    background: str | None = None,
    diagram_link_base: str | None = None,
) -> str:
    """The diagram as SVG. `background` (canvas-n85n): a solid hex colour behind the drawing (GitHub
    submissions); downloads stay transparent. `diagram_link_base` (canvas-8uh1.4): linked elements open the diagram
    they link to in Canvas."""
    if family not in DSL_FAMILIES:
        raise ApiError(422, f"No DSL family registered for: {family}")
    parsed = core.parse(family, dsl)
    if "model" not in parsed:
        errors = json.dumps(parsed.get("errors", []), separators=(",", ":"), ensure_ascii=False)
        raise ApiError(422, f"Diagram could not be rendered — DSL has parse errors: {errors}")
    model: dict[str, Any] = parsed["model"]
    legend = model.get("legend") or {}
    standard = get_active_standard(conn, diagram_type_id) if legend.get("visible") else None
    icons = _icon_artwork(conn, model)
    with work_span("render svg", {"canvas.diagram.family": family}):
        return core.render_svg(
            model,
            icons=icons,
            standard_rules=standard.rules if standard else None,
            background=background,
            diagram_link_base=diagram_link_base,
        )


@router.get("/diagrams/{id}/export")
def export(
    id: str,
    request: Request,
    user: CurrentUser,
    db: Db,
    format: Literal["mermaid", "svg", "png"] = "mermaid",
) -> Response:
    core = _diagram_core(request)
    settings: Settings = request.app.state.settings
    link_base = diagram_link_base(settings.canvas_public_url)
    with db.connect() as conn:
        require_diagram_access(conn, user.id, id, "view")
        diagram = get_diagram(conn, id)
        if format == "mermaid":
            body: bytes | str = core.portable(diagram["dslContent"], diagram_link_base=link_base)
        else:
            svg = render_svg(
                conn,
                core,
                diagram["dslFamily"],
                diagram["dslContent"],
                diagram["diagramTypeId"],
                diagram_link_base=link_base,
            )
            if format == "svg":
                body = svg
            else:
                with work_span("rasterize png", {"canvas.diagram.family": diagram["dslFamily"]}):
                    body = _png(svg)
    return Response(
        content=body,
        headers={
            "Content-Type": CONTENT_TYPES[format],
            "Content-Disposition": CONTENT_DISPOSITIONS[format],
            "Content-Security-Policy": EXPORT_CSP,
        },
    )


def _png(svg: str) -> bytes:
    """The SVG rasterised with the bundled fonts only; every generic family (and system-ui, which resvg
    doesn't know) falls back to Liberation Sans."""
    return bytes(
        resvg_py.svg_to_bytes(
            svg_string=svg,
            skip_system_fonts=True,
            font_files=FONT_FILES,
            font_family=FONT_FAMILY,
            sans_serif_family=FONT_FAMILY,
            serif_family=FONT_FAMILY,
            monospace_family=FONT_FAMILY,
        )
    )
