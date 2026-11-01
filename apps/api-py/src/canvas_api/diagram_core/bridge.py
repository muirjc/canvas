"""Client for the diagram-core bridge (packages/diagram-bridge, canvas-1bty.4).

One keep-alive HTTP connection pool; every call is JSON in, JSON out. Models are plain dicts in the
TypeScript model's shape (packages/diagram-core/src/model/diagram-model.ts) -- the golden corpus pins
that shape down.
"""

from __future__ import annotations

import json
from typing import Any, cast

import httpx

JsonObject = dict[str, Any]


class BridgeError(RuntimeError):
    """The bridge refused a request (400) or failed (5xx), or couldn't be reached."""


def canonical_json(value: Any) -> str:
    """The corpus's canonical JSON: keys sorted, two-space indent, trailing newline (as the TypeScript
    corpus test writes it)."""
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


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

    def validate(self, model: JsonObject, rules: JsonObject) -> list[JsonObject]:
        return cast(list[JsonObject], self._post("validate", {"model": model, "rules": rules})["violations"])

    def check_standard(self, rules: JsonObject, family: str) -> list[JsonObject]:
        return cast(list[JsonObject], self._post("check-standard", {"rules": rules, "family": family})["issues"])

    def render_svg(
        self,
        model: JsonObject,
        *,
        icons: dict[str, str] | None = None,
        standard_rules: JsonObject | None = None,
        background: str | None = None,
    ) -> str:
        body: JsonObject = {"model": model}
        if icons:
            body["icons"] = icons
        if standard_rules is not None:
            body["standardRules"] = standard_rules
        if background is not None:
            body["background"] = background
        return cast(str, self._post("render-svg", body)["svg"])

    def portable(self, dsl: str, *, strip_front_matter: bool = False) -> str:
        return cast(str, self._post("portable", {"dsl": dsl, "stripFrontMatter": strip_front_matter})["dsl"])

    def embeds(
        self, markdown: str, doc_path: str, sources: dict[str, JsonObject], only: list[str] | None = None
    ) -> JsonObject:
        body: JsonObject = {"markdown": markdown, "docPath": doc_path, "sources": sources}
        if only is not None:
            body["only"] = only
        return self._post("embeds", body)
