"""Port of diagram-core's libraries/library-loader.ts (loadLibrary) and the bridge's icon-refs operation.

`load_library` validates and normalizes an icon library manifest: id and version required, icon ids unique, every
icon's artwork through `sanitize_svg_fragment`. It answers as the bridge's load-library op does:
{"ok": True, "library": ...} or {"ok": False, "error": message}.

The manifest's documented shape (id, version, optional license, icons: [{id, displayName, keywords, category,
assetRef}]) is answered exactly as TypeScript does. A manifest that isn't that shape (icons not a list, an icon
that isn't an object, artwork that isn't text) makes TypeScript throw a raw TypeError, whose wording depends on
V8; Python answers {"ok": False} with its own message instead. Only the admin-only legacy POST /libraries can
send one; the import routes check the shape first.
"""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.svg_import import sanitize_svg_fragment

__all__ = ["icon_refs", "load_library"]

_ABSENT = object()


def _key(value: Any) -> Any:
    """A Set key with JavaScript's SameValueZero for JSON values: 1 and "1" differ, 1 and 1.0 don't, objects are
    never equal to each other."""
    if value is _ABSENT or value is None:
        return ("nil", value is None)
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, int | float):
        return ("num", float(value)) if value == value else ("nan",)
    if isinstance(value, str):
        return ("str", value)
    return ("obj", id(value))


def load_library(manifest: dict[str, Any]) -> dict[str, Any]:
    if not js_truthy(manifest.get("id")) or not js_truthy(manifest.get("version")):
        return {"ok": False, "error": "Library manifest requires both id and version"}
    icons = manifest.get("icons")
    if not isinstance(icons, list) or not all(isinstance(icon, dict) for icon in icons):
        return {"ok": False, "error": "Library manifest needs an icons list of objects"}
    seen: set[Any] = set()
    for icon in icons:
        icon_id = icon.get("id", _ABSENT)
        if _key(icon_id) in seen:
            shown = "undefined" if icon_id is _ABSENT else js_template(icon_id)
            return {
                "ok": False,
                "error": f'Duplicate icon id "{shown}" in library '
                f"{js_template(manifest['id'])}@{js_template(manifest['version'])}",
            }
        seen.add(_key(icon_id))
    if not all(isinstance(icon.get("assetRef"), str) for icon in icons):
        return {"ok": False, "error": "Every icon in a library manifest needs an assetRef string"}
    library: dict[str, Any] = {"id": manifest["id"], "version": manifest["version"]}
    if "license" in manifest:
        library["license"] = manifest["license"]
    library["icons"] = [
        {
            **icon,
            "assetRef": sanitize_svg_fragment(icon["assetRef"]),
            "libraryId": manifest["id"],
            "libraryVersion": manifest["version"],
        }
        for icon in icons
    ]
    return {"ok": True, "library": library}


def icon_refs(parse: Any, diagrams: list[dict[str, Any]]) -> list[list[dict[str, Any]] | None]:
    """Each diagram's icon references, nodes then containers; None when it doesn't parse or its family is
    unknown. `parse(family, dsl)` is DiagramCore's parse; a diagram is {"family", "dsl"}."""
    refs: list[list[dict[str, Any]] | None] = []
    for diagram in diagrams:
        parsed = parse(diagram["family"], diagram["dsl"])
        model = parsed.get("model") if isinstance(parsed, dict) else None
        if model is None:
            refs.append(None)
            continue
        refs.append(
            [element["icon"] for element in [*model["nodes"], *model["containers"]] if js_truthy(element.get("icon"))]
        )
    return refs
