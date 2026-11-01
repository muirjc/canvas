"""diagram-core for the Python service.

During the move to Python this calls the TypeScript diagram-core through the bridge
(packages/diagram-bridge, a sidecar on localhost). Families get ported to Python one at a time; a
ported family must pass the golden corpus (packages/diagram-core/corpus) before it replaces the bridge.
"""

from canvas_api.diagram_core.bridge import BridgeError, DiagramBridge, canonical_json

__all__ = ["BridgeError", "DiagramBridge", "canonical_json"]
