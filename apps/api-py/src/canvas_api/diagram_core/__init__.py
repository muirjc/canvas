"""diagram-core for the Python service, native (canvas-1bty.15): a port of packages/diagram-core's server side --
every family's parse/serialize, validation, rendering, templates, the icon-library clean-up, document embeds and the
AI chat's tools -- held to the TypeScript implementation by the golden corpus (packages/diagram-core/corpus), vectors
generated from TypeScript, and comparisons with the TypeScript bridge in the tests (tests/diagram_bridge.py).
`DiagramCore` (core.py) is what the routes call.
"""

from canvas_api.diagram_core.core import DiagramCore, DiagramCoreError, JsonObject, canonical_json

__all__ = ["DiagramCore", "DiagramCoreError", "JsonObject", "canonical_json"]
