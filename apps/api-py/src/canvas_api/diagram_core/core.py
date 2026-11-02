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

from canvas_api.diagram_core.architecture import parse_architecture, serialize_architecture
from canvas_api.diagram_core.bridge import BridgeError, DiagramBridge, JsonObject, canonical_json
from canvas_api.diagram_core.c4 import parse_c4, serialize_c4
from canvas_api.diagram_core.detect import detect_dsl_family
from canvas_api.diagram_core.erd import parse_erd, serialize_erd
from canvas_api.diagram_core.flowchart import parse_flowchart, serialize_flowchart
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.jsyaml import YamlError
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.diagram_core.portable import to_portable_mermaid
from canvas_api.diagram_core.sequence import parse_sequence, serialize_sequence
from canvas_api.diagram_core.standards import check_standard_definition, validate
from canvas_api.diagram_core.uml import parse_uml, serialize_uml

__all__ = ["KNOWN_FAMILIES", "NATIVE_FAMILIES", "PARSERS", "SERIALIZERS", "DiagramCore", "Mode"]

Mode = Literal["native", "shadow", "bridge"]
T = TypeVar("T")
#: Standard logging, not structlog: Azure Monitor exports these (with `extra` as customDimensions) to Application
#: Insights, so mismatches can be counted there; structlog only prints to the console.
log = logging.getLogger("canvas_api.diagram_core")

#: Every family diagram-core has (dsl/registry.ts), and those ported to Python so far.
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
NATIVE_FAMILIES = frozenset(PARSERS)


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
        except Exception as error:  # the shadow must never fail a request the bridge answered
            log.warning(
                "diagram-core shadow mismatch",
                # An unexpected error's message could quote the diagram: only its type is logged.
                extra={
                    "op": op,
                    "family": family,
                    "native": "error",
                    "detail": _first_line(error) if isinstance(error, BridgeError) else type(error).__name__,
                },
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
            lambda: to_js_json(PARSERS[family](dsl)),
            lambda: self._require_bridge("parse").parse(family, dsl),
        )

    def serialize(self, family: str, model: JsonObject) -> str:
        if family not in NATIVE_FAMILIES:
            return self._require_bridge("serialize").serialize(family, model)
        return self._answer(
            "serialize",
            family,
            lambda: SERIALIZERS[family](model),
            lambda: self._require_bridge("serialize").serialize(family, model),
        )

    def detect_and_parse(self, dsl: str, family: str | None = None) -> JsonObject:
        def native() -> JsonObject:
            found = family if family else detect_dsl_family(dsl)
            if not found or found not in KNOWN_FAMILIES:
                return {"family": found, "errors": [{"message": "Unrecognized diagram header"}]}
            result = to_js_json(PARSERS[found](dsl))
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
            lambda: SERIALIZERS[family](create_empty_diagram_model(diagram_type_id)),
            lambda: self._require_bridge("empty-dsl").empty_dsl(family, diagram_type_id),
        )

    def portable(self, dsl: str, *, strip_front_matter: bool = False) -> str:
        family = _quiet_detect(dsl)

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

    def validate(self, model: JsonObject, rules: JsonObject) -> list[JsonObject]:
        """The standard's violations for the model (canvas-1bty.15.3). The model's family doesn't matter."""
        return self._answer(
            "validate",
            _family_of(model),
            lambda: to_js_json(validate(model, rules)),
            lambda: self._require_bridge("validate").validate(model, rules),
        )

    def check_standard(self, rules: JsonObject, family: str) -> list[JsonObject]:
        """Problems with a standard's own definition for a family ([] = it can be saved)."""
        return self._answer(
            "check-standard",
            family,
            lambda: to_js_json(check_standard_definition(rules, family)),
            lambda: self._require_bridge("check-standard").check_standard(rules, family),
        )


def _native(op: str, compute: Callable[[], Any]) -> Any:
    """A native answer; the TypeScript code throws where these raise (bad YAML front matter, a standard or model
    missing a field the code reads), which the bridge reported as an error, so they become BridgeError for the
    routes."""
    try:
        return compute()
    except YamlError as error:
        raise BridgeError(f"diagram-core {op}: {error}") from error
    except (KeyError, TypeError, AttributeError) as error:
        raise BridgeError(f"diagram-core {op}: {type(error).__name__}") from error


def _family_of(model: JsonObject) -> str | None:
    """For the shadow log only: the diagram type id (a family is not part of the model)."""
    value = model.get("diagramTypeId") if isinstance(model, dict) else None
    return value if isinstance(value, str) else None


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
