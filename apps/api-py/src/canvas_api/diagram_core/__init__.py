"""diagram-core for the Python service.

During the move to Python this calls the TypeScript diagram-core through the bridge
(packages/diagram-bridge, a sidecar on localhost). Families get ported to Python one at a time
(canvas-1bty.15); a ported family must pass the golden corpus (packages/diagram-core/corpus) before it
replaces the bridge. DiagramCore (core.py) answers natively what's ported, by DIAGRAM_CORE_MODE.
"""

from canvas_api.diagram_core.bridge import BridgeError, DiagramBridge, canonical_json
from canvas_api.diagram_core.core import DiagramCore

__all__ = ["BridgeError", "DiagramBridge", "DiagramCore", "canonical_json"]
