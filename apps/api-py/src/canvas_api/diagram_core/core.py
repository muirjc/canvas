"""DiagramCore: diagram-core for the routes, answering natively where a part has been ported to Python and
through the bridge otherwise (canvas-1bty.15). Same methods as DiagramBridge, so the routes don't change.

DIAGRAM_CORE_MODE picks who answers what's been ported:
- "native": Python answers it.
- "shadow" (the default while the bridge still runs): the bridge answers and Python's answer is computed too;
  any difference is logged (`diagram-core shadow mismatch`, op and family, never the diagram's text). Proves the
  port on real diagrams without users depending on it.
- "bridge": the bridge answers everything (the switch back).
What isn't ported yet always goes to the bridge.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any, Literal, TypeVar

from canvas_api.diagram_core.bridge import BridgeError, DiagramBridge, JsonObject, canonical_json
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.flowchart import parse_flowchart, serialize_flowchart
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.diagram_core.portable import to_portable_mermaid

__all__ = ["KNOWN_FAMILIES", "NATIVE_FAMILIES", "DiagramCore", "Mode"]

Mode = Literal["native", "shadow", "bridge"]
T = TypeVar("T")
#: Standard logging, not structlog: Azure Monitor exports these (with `extra` as customDimensions) to Application
#: Insights, so mismatches can be counted there; structlog only prints to the console.
log = logging.getLogger("canvas_api.diagram_core")

#: Every family diagram-core has (dsl/registry.ts), and those ported to Python so far.
KNOWN_FAMILIES = ("flowchart", "c4", "architecture", "sequence", "erd", "uml")
_PARSERS: dict[str, Callable[[str], dict[str, Any]]] = {"flowchart": parse_flowchart}
_SERIALIZERS: dict[str, Callable[[dict[str, Any]], str]] = {"flowchart": serialize_flowchart}
NATIVE_FAMILIES = frozenset(_PARSERS)


class DiagramCore:
    def __init__(self, bridge: DiagramBridge | None, mode: Mode = "shadow") -> None:
        self.bridge = bridge
        # Without a bridge there's nothing to shadow or fall back to: what's ported answers natively.
        self.mode: Mode = mode if bridge is not None else "native"

    # --- plumbing ----------------------------------------------------------------------------------

    def __getattr__(self, name: str) -> Any:
        """Anything not ported is the bridge's."""
        bridge = self.__dict__.get("bridge")
        if bridge is None:
            raise BridgeError(f"diagram-core {name}: not ported to Python yet and no bridge is configured")
        return getattr(bridge, name)

    def close(self) -> None:
        if self.bridge is not None:
            self.bridge.close()

    def health(self) -> bool:
        return self.bridge.health() if self.bridge is not None else True

    def _require_bridge(self, op: str) -> DiagramBridge:
        if self.bridge is None:
            raise BridgeError(f"diagram-core {op}: not ported to Python yet and no bridge is configured")
        return self.bridge

    def _answer(self, op: str, family: str | None, native: Callable[[], Any], bridged: Callable[[], T]) -> T:
        """The answer for a ported operation, by mode."""
        if self.mode == "bridge":
            return bridged()
        if self.mode == "native":
            answer: T = _native(op, native)
            return answer
        answer = bridged()
        started = time.perf_counter()
        try:
            mine = _native(op, native)
        except BridgeError as error:
            log.warning(
                "diagram-core shadow mismatch",
                extra={"op": op, "family": family, "native": "error", "detail": _first_line(error)},
            )
            return answer
        if _comparable(mine) != _comparable(answer):
            log.warning("diagram-core shadow mismatch", extra={"op": op, "family": family, "native": "different"})
        else:
            log.debug(
                "diagram-core shadow match",
                extra={"op": op, "family": family, "ms": round((time.perf_counter() - started) * 1000)},
            )
        return answer

    # --- ported operations ----------------------------------------------------------------------

    def detect(self, dsl: str) -> str | None:
        return self._answer(
            "detect", None, lambda: detect_dsl_family(dsl), lambda: self._require_bridge("detect").detect(dsl)
        )

    def parse(self, family: str, dsl: str) -> JsonObject:
        if family not in NATIVE_FAMILIES:
            return self._require_bridge("parse").parse(family, dsl)
        return self._answer(
            "parse",
            family,
            lambda: to_js_json(_PARSERS[family](dsl)),
            lambda: self._require_bridge("parse").parse(family, dsl),
        )

    def serialize(self, family: str, model: JsonObject) -> str:
        if family not in NATIVE_FAMILIES:
            return self._require_bridge("serialize").serialize(family, model)
        return self._answer(
            "serialize",
            family,
            lambda: _SERIALIZERS[family](model),
            lambda: self._require_bridge("serialize").serialize(family, model),
        )

    def detect_and_parse(self, dsl: str, family: str | None = None) -> JsonObject:
        def native() -> JsonObject:
            found = family if family else detect_dsl_family(dsl)
            if not found or found not in KNOWN_FAMILIES:
                return {"family": found, "errors": [{"message": "Unrecognized diagram header"}]}
            result = to_js_json(_PARSERS[found](dsl))
            return {"family": found, **result}

        target = family if family else _quiet_detect(dsl)
        if target in KNOWN_FAMILIES and target not in NATIVE_FAMILIES:
            return self._require_bridge("detect-and-parse").detect_and_parse(dsl, family)
        return self._answer(
            "detect-and-parse",
            target,
            native,
            lambda: self._require_bridge("detect-and-parse").detect_and_parse(dsl, family),
        )

    def empty_dsl(self, family: str, diagram_type_id: str) -> str:
        if family not in NATIVE_FAMILIES:
            return self._require_bridge("empty-dsl").empty_dsl(family, diagram_type_id)
        return self._answer(
            "empty-dsl",
            family,
            lambda: _SERIALIZERS[family](create_empty_diagram_model(diagram_type_id)),
            lambda: self._require_bridge("empty-dsl").empty_dsl(family, diagram_type_id),
        )

    def portable(self, dsl: str, *, strip_front_matter: bool = False) -> str:
        family = _quiet_detect(dsl)
        if family not in (None, *NATIVE_FAMILIES, "sequence", "architecture"):
            return self._require_bridge("portable").portable(dsl, strip_front_matter=strip_front_matter)

        def native() -> str:
            out = to_portable_mermaid(dsl, strip_front_matter)
            if out is None:  # pragma: no cover - guarded above
                raise BridgeError("portable: family not ported")
            return out

        return self._answer(
            "portable",
            family,
            native,
            lambda: self._require_bridge("portable").portable(dsl, strip_front_matter=strip_front_matter),
        )


def _native(op: str, compute: Callable[[], Any]) -> Any:
    """A native answer; the TypeScript code throws where these raise (bad YAML front matter), which the bridge
    reported as an error, so they become BridgeError for the routes."""
    try:
        return compute()
    except YamlError as error:
        raise BridgeError(f"diagram-core {op}: {error}") from error


def _first_line(error: Exception) -> str:
    """Just the first line of an error: a YAML error goes on to quote the diagram's own text, which isn't logged."""
    return str(error).split("\n", 1)[0][:120]


def _quiet_detect(dsl: str) -> str | None:
    try:
        return detect_dsl_family(dsl)
    except YamlError:
        return None


def _comparable(value: Any) -> str:
    return canonical_json(to_js_json(value)) if isinstance(value, dict | list) else repr(value)
