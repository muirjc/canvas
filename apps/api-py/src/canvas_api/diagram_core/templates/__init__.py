"""Template compilers (canvas-1bty.15.5): a filled-in Markdown intake form (docs/*-template.md) to Mermaid DSL
text for a diagram type. Port of diagram-core's src/template/. The DSL is then parsed like any other, so a
compiled template can't produce a model the parser wouldn't accept from a person."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from canvas_api.diagram_core.templates.architecture import compile_architecture
from canvas_api.diagram_core.templates.c4_context import compile_c4_context
from canvas_api.diagram_core.templates.c4_levels import (
    compile_c4_component,
    compile_c4_container,
    compile_c4_deployment,
)
from canvas_api.diagram_core.templates.erd import compile_erd
from canvas_api.diagram_core.templates.sequence import compile_sequence
from canvas_api.diagram_core.templates.uml_class import compile_uml_class

__all__ = ["TEMPLATE_COMPILERS", "compile_template"]

TEMPLATE_COMPILERS: dict[str, Callable[[str], dict[str, Any]]] = {
    "c4-context": compile_c4_context,
    "c4-container": compile_c4_container,
    "c4-component": compile_c4_component,
    "c4-deployment": compile_c4_deployment,
    "sequence": compile_sequence,
    "erd": compile_erd,
    "uml": compile_uml_class,
    "network": compile_architecture,
    "deployment": compile_architecture,
    "cloud-infrastructure": compile_architecture,
}
"""By diagram type id, as template-registry.ts."""


def compile_template(diagram_type_id: str, template: str) -> dict[str, Any]:
    """The bridge's compile-template answer: {"dsl"}, {"errors"}, or {"unsupported": True} for a type with no
    template compiler."""
    compiler = TEMPLATE_COMPILERS.get(diagram_type_id)
    if compiler is None:
        return {"unsupported": True}
    return compiler(template)
