"""Client for the diagram-core bridge (packages/diagram-bridge, canvas-1bty.4): the TypeScript diagram-core over
HTTP. Test-only since canvas-1bty.15.8: the tests compare the native Python diagram-core with it, because the browser
still runs the TypeScript one and the two must keep matching.

One keep-alive HTTP connection pool; every call is JSON in, JSON out. Models are plain dicts in the
TypeScript model's shape (packages/diagram-core/src/model/diagram-model.ts) -- the golden corpus pins
that shape down.
"""

from __future__ import annotations

from typing import Any, cast

import httpx

from canvas_api.diagram_core import JsonObject, canonical_json

__all__ = ["BridgeError", "DiagramBridge", "canonical_json"]


class BridgeError(RuntimeError):
    """The bridge refused a request (400) or failed (5xx), or couldn't be reached."""


class DiagramBridge:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self._client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> DiagramBridge:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _post(self, op: str, body: JsonObject) -> JsonObject:
        try:
            res = self._client.post(f"/{op}", json=body)
        except httpx.HTTPError as exc:
            raise BridgeError(f"diagram bridge unreachable: {exc}") from exc
        if res.status_code != 200:
            try:
                message = res.json().get("error", res.text)
            except ValueError:
                message = res.text
            raise BridgeError(f"diagram bridge {op}: {res.status_code} {message}")
        return cast(JsonObject, res.json())

    def health(self) -> bool:
        try:
            return self._client.get("/health").status_code == 200
        except httpx.HTTPError:
            return False

    def detect(self, dsl: str) -> str | None:
        return cast(str | None, self._post("detect", {"dsl": dsl})["family"])

    def parse(self, family: str, dsl: str) -> JsonObject:
        """{"model": ...} or {"errors": [...]} -- a parse error is data, not an exception."""
        return self._post("parse", {"family": family, "dsl": dsl})

    def detect_and_parse(self, dsl: str, family: str | None = None) -> JsonObject:
        body: JsonObject = {"dsl": dsl}
        if family:
            body["family"] = family
        return self._post("detect-and-parse", body)

    def serialize(self, family: str, model: JsonObject) -> str:
        return cast(str, self._post("serialize", {"family": family, "model": model})["dsl"])

    def empty_dsl(self, family: str, diagram_type_id: str) -> str:
        """A new diagram's starting DSL: the family's serialization of an empty model."""
        return cast(str, self._post("empty-dsl", {"family": family, "diagramTypeId": diagram_type_id})["dsl"])

    def compile_template(self, diagram_type_id: str, template: str) -> JsonObject:
        """{"dsl"}, {"errors"} or {"unsupported": True} for a filled-in intake template."""
        return self._post("compile-template", {"diagramTypeId": diagram_type_id, "template": template})

    def validate(
        self, model: JsonObject, rules: JsonObject, link_target_types: dict[str, str] | None = None
    ) -> list[JsonObject]:
        body: JsonObject = {"model": model, "rules": rules}
        if link_target_types is not None:
            body["linkTargetTypes"] = link_target_types
        return cast(list[JsonObject], self._post("validate", body)["violations"])

    def check_standard(self, rules: JsonObject, family: str) -> list[JsonObject]:
        return cast(list[JsonObject], self._post("check-standard", {"rules": rules, "family": family})["issues"])

    def render_svg(
        self,
        model: JsonObject,
        *,
        icons: dict[str, str] | None = None,
        standard_rules: JsonObject | None = None,
        background: str | None = None,
        diagram_link_base: str | None = None,
    ) -> str:
        body: JsonObject = {"model": model}
        if icons:
            body["icons"] = icons
        if standard_rules is not None:
            body["standardRules"] = standard_rules
        if background is not None:
            body["background"] = background
        if diagram_link_base is not None:
            body["diagramLinkBase"] = diagram_link_base
        return cast(str, self._post("render-svg", body)["svg"])

    def portable(self, dsl: str, *, strip_front_matter: bool = False, diagram_link_base: str | None = None) -> str:
        body: JsonObject = {"dsl": dsl, "stripFrontMatter": strip_front_matter}
        if diagram_link_base is not None:
            body["diagramLinkBase"] = diagram_link_base
        return cast(str, self._post("portable", body)["dsl"])

    def embeds(
        self, markdown: str, doc_path: str, sources: dict[str, JsonObject], only: list[str] | None = None
    ) -> JsonObject:
        body: JsonObject = {"markdown": markdown, "docPath": doc_path, "sources": sources}
        if only is not None:
            body["only"] = only
        return self._post("embeds", body)

    # canvas-1bty.14: the library admin (packages/diagram-bridge/src/handlers.ts).

    def svg_prepare(self, items: list[JsonObject]) -> list[JsonObject]:
        """Uploaded SVG files -> icon artwork: [{ok: true, assetRef} | {ok: false, error}], one per item."""
        return cast(list[JsonObject], self._post("svg-prepare", {"items": items})["results"])

    def svg_sanitize_strict(self, items: list[JsonObject]) -> list[JsonObject]:
        """A custom manifest's artwork, checked strictly: same shape as svg_prepare."""
        return cast(list[JsonObject], self._post("svg-sanitize-strict", {"items": items})["results"])

    def load_library(self, manifest: Any) -> JsonObject:
        """{ok: true, library} (validated, artwork sanitized) or {ok: false, error}."""
        return self._post("load-library", {"manifest": manifest})

    def icon_refs(self, diagrams: list[JsonObject]) -> list[list[JsonObject] | None]:
        """Each diagram's icon references (None when it doesn't parse)."""
        return cast(list[list[JsonObject] | None], self._post("icon-refs", {"diagrams": diagrams})["refs"])

    # canvas-p2g8.2: Auto Layout (the AI chat's arrange tool must match the editor's button).

    def auto_layout(self, model: JsonObject, direction: str | None, family: str) -> JsonObject:
        """The model as the editor's Auto Layout leaves it."""
        body: JsonObject = {"model": model, "family": family}
        if direction is not None:
            body["direction"] = direction
        return cast(JsonObject, self._post("auto-layout", body)["model"])
