"""DiagramCore: diagram-core for the routes, native Python (canvas-1bty.15).

One object the routes hold (`app.state.diagram_core`), one method per operation, with the answer shapes the
TypeScript bridge used to give (canvas-1bty.4), so routes didn't change when the parts were ported. The bridge
itself was retired in canvas-1bty.15.8; it lives on only as the tests' reference (tests/diagram_bridge.py).

Where the TypeScript code throws (bad YAML front matter, a standard or model missing a field the code reads), the
native code raises; `DiagramCoreError` carries that to the routes (a 500, as it was).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, cast

from canvas_api.diagram_core.ai import list_tools, prompt_sections, run_tool
from canvas_api.diagram_core.architecture import parse_architecture, serialize_architecture
from canvas_api.diagram_core.auto_layout import auto_layout
from canvas_api.diagram_core.c4 import parse_c4, serialize_c4
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.embeds import update_embeds
from canvas_api.diagram_core.erd import parse_erd, serialize_erd
from canvas_api.diagram_core.flowchart import parse_flowchart, serialize_flowchart
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from canvas_api.diagram_core.libraries import icon_refs, load_library
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.diagram_core.portable import to_portable_mermaid
from canvas_api.diagram_core.sequence import parse_sequence, serialize_sequence
from canvas_api.diagram_core.standards import check_standard_definition, validate
from canvas_api.diagram_core.svg_import import SvgImportError, prepare_uploaded_svg, sanitize_icon_markup_strict
from canvas_api.diagram_core.svg_render import render_to_svg
from canvas_api.diagram_core.templates import compile_template
from canvas_api.diagram_core.uml import parse_uml, serialize_uml

__all__ = [
    "KNOWN_FAMILIES",
    "PARSERS",
    "SERIALIZERS",
    "DiagramCore",
    "DiagramCoreError",
    "JsonObject",
    "canonical_json",
]

JsonObject = dict[str, Any]

#: Every family diagram-core has (dsl/registry.ts).
KNOWN_FAMILIES = ("flowchart", "c4", "architecture", "sequence", "erd", "uml")
PARSERS: dict[str, Callable[[str], dict[str, Any]]] = {
    "flowchart": parse_flowchart,
    "c4": parse_c4,
    "architecture": parse_architecture,
    "sequence": parse_sequence,
    "erd": parse_erd,
    "uml": parse_uml,
}
SERIALIZERS: dict[str, Callable[[dict[str, Any]], str]] = {
    "flowchart": serialize_flowchart,
    "c4": serialize_c4,
    "architecture": serialize_architecture,
    "sequence": serialize_sequence,
    "erd": serialize_erd,
    "uml": serialize_uml,
}


class DiagramCoreError(RuntimeError):
    """An operation failed where the TypeScript diagram-core throws (or was asked for an unknown family)."""


def canonical_json(value: Any) -> str:
    """The corpus's canonical JSON: keys sorted, two-space indent, trailing newline (as the TypeScript corpus test
    writes it)."""
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


class DiagramCore:
    def detect(self, dsl: str) -> str | None:
        return _native("detect", lambda: detect_dsl_family(dsl))

    def parse(self, family: str, dsl: str) -> JsonObject:
        """{model} or {errors}."""
        parser = _family_table(PARSERS, "parse", family)
        return cast(JsonObject, _native("parse", lambda: to_js_json(parser(dsl))))

    def serialize(self, family: str, model: JsonObject) -> str:
        serializer = _family_table(SERIALIZERS, "serialize", family)
        return _native("serialize", lambda: serializer(model))

    def detect_and_parse(self, dsl: str, family: str | None = None) -> JsonObject:
        """{family, model} or {family, errors}; `family` skips detection."""

        def answer() -> JsonObject:
            found = family if family else detect_dsl_family(dsl)
            if not found or found not in KNOWN_FAMILIES:
                return {"family": found, "errors": [{"message": "Unrecognized diagram header"}]}
            return {"family": found, **to_js_json(PARSERS[found](dsl))}

        return _native("detect-and-parse", answer)

    def empty_dsl(self, family: str, diagram_type_id: str) -> str:
        """A new diagram's starting DSL."""
        serializer = _family_table(SERIALIZERS, "empty-dsl", family)
        return _native("empty-dsl", lambda: serializer(create_empty_diagram_model(diagram_type_id)))

    def portable(self, dsl: str, *, strip_front_matter: bool = False) -> str:
        """The diagram as portable Mermaid (renders in any Mermaid viewer)."""

        def answer() -> str:
            out = to_portable_mermaid(dsl, strip_front_matter)
            if out is None:
                raise DiagramCoreError("diagram-core portable: not a diagram")
            return out

        return _native("portable", answer)

    def validate(self, model: JsonObject, rules: JsonObject) -> list[JsonObject]:
        """The standard's violations for the model. The model's family doesn't matter."""
        return cast(list[JsonObject], _native("validate", lambda: to_js_json(validate(model, rules))))

    def check_standard(self, rules: JsonObject, family: str) -> list[JsonObject]:
        """Problems with a standard's own definition for a family ([] = it can be saved)."""
        return cast(
            list[JsonObject], _native("check-standard", lambda: to_js_json(check_standard_definition(rules, family)))
        )

    def render_svg(
        self,
        model: JsonObject,
        *,
        icons: dict[str, str] | None = None,
        standard_rules: JsonObject | None = None,
        background: str | None = None,
    ) -> str:
        """The diagram as SVG. `icons` maps "<libraryId>@<libraryVersion>@<iconId>" to the artwork; `standard_rules`
        feeds a visible legend; `background` a solid hex colour behind it all."""
        return _native(
            "render-svg", lambda: render_to_svg(model, icons, standard_rules=standard_rules, background=background)
        )

    def compile_template(self, diagram_type_id: str, template: str) -> JsonObject:
        """A filled-in Markdown intake template as DSL: {"dsl"}, {"errors"}, or {"unsupported": True} for a diagram
        type with no template compiler."""
        return _native("compile-template", lambda: compile_template(diagram_type_id, template))

    def embeds(
        self, markdown: str, doc_path: str, sources: dict[str, JsonObject], only: list[str] | None = None
    ) -> JsonObject:
        """A Markdown document's diagram embeds brought up to date: {markdown, changed, results}."""
        only_set = None if only is None else set(only)
        return _native("embeds", lambda: update_embeds(markdown, doc_path, sources, only_set))

    def auto_layout(self, model: JsonObject, direction: str | None, family: str) -> JsonObject:
        """The model as the editor's Auto Layout leaves it (canvas-p2g8.2): new node positions, group positions and
        sizes, and for flowchart/ERD/UML the direction (`direction`, else the model's, else TD). A family Auto Layout
        doesn't arrange (sequence, or one it doesn't know) comes back unchanged, as in TypeScript."""
        return cast(JsonObject, _native("auto-layout", lambda: to_js_json(auto_layout(model, direction, family))))

    # --- the library admin ---------------------------------------------------------------------------------------

    def svg_prepare(self, items: list[JsonObject]) -> list[JsonObject]:
        """Uploaded SVG files -> icon artwork: [{ok: true, assetRef} | {ok: false, error}], one per item."""
        return _native("svg-prepare", lambda: _svg_batch(items, prepare_uploaded_svg))

    def svg_sanitize_strict(self, items: list[JsonObject]) -> list[JsonObject]:
        """A custom manifest's artwork, checked strictly: same shape as svg_prepare."""
        return _native("svg-sanitize-strict", lambda: _svg_batch(items, sanitize_icon_markup_strict))

    def load_library(self, manifest: Any) -> JsonObject:
        """{ok: true, library} (validated, artwork sanitized) or {ok: false, error}."""
        if not isinstance(manifest, dict):
            raise DiagramCoreError('diagram-core load-library: "manifest" must be an object')
        return _native("load-library", lambda: load_library(manifest))

    def icon_refs(self, diagrams: list[JsonObject]) -> list[list[JsonObject] | None]:
        """Each diagram's icon references, nodes then containers (None when it doesn't parse)."""

        def parse(family: str, dsl: str) -> Any:
            return to_js_json(PARSERS[family](dsl)) if family in PARSERS else None

        return _native("icon-refs", lambda: icon_refs(parse, diagrams))

    # --- the AI chat's diagram tools -----------------------------------------------------------------------------

    def ai_tools(self, family: str, rules: JsonObject | None) -> list[JsonObject]:
        """The tools offered for a family under a standard: [{name, description, inputSchema}]."""
        return _native("ai-tools", lambda: list_tools(family, rules))

    def ai_tool(self, family: str, rules: JsonObject | None, model: JsonObject, name: str, input: Any) -> JsonObject:
        """Runs one tool call: {ok: true, model, output, outcomes} or {ok: false, error}."""
        return cast(JsonObject, _native("ai-tool", lambda: to_js_json(run_tool(family, rules, model, name, input))))

    def ai_prompt(self, family: str, rules: JsonObject | None, model: JsonObject) -> JsonObject:
        """{primer, standard, currentDiagram}: the diagram-specific system prompt sections."""
        return _native("ai-prompt", lambda: prompt_sections(family, rules, model))


def _family_table[T](table: dict[str, T], op: str, family: str) -> T:
    if family not in table:
        raise DiagramCoreError(f"diagram-core {op}: unknown family {family!r}")
    return table[family]


def _native[T](op: str, compute: Callable[[], T]) -> T:
    """The answer; where TypeScript throws, the native code raises, and that becomes a DiagramCoreError. Only the
    error's type is kept for a programming error: its message could quote the diagram."""
    try:
        return compute()
    except YamlError as error:
        raise DiagramCoreError(f"diagram-core {op}: {error}") from error
    except (KeyError, TypeError, AttributeError) as error:
        raise DiagramCoreError(f"diagram-core {op}: {type(error).__name__}") from error


def _svg_batch(items: list[JsonObject], clean: Callable[[str, str], str]) -> list[JsonObject]:
    """One clean-up per item: an SvgImportError is that item's answer (anything else is a bug)."""
    results: list[JsonObject] = []
    for item in items:
        svg, id_prefix = item.get("svg"), item.get("idPrefix")
        if not isinstance(svg, str) or not isinstance(id_prefix, str):
            raise DiagramCoreError('diagram-core svg: each item needs "svg" and "idPrefix" strings')
        try:
            results.append({"ok": True, "assetRef": clean(svg, id_prefix)})
        except SvgImportError as error:
            results.append({"ok": False, "error": str(error)})
    return results
