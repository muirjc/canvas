"""The AI chat's diagram knowledge, native (canvas-1bty.15.7, phase 11g-2): the tools the model may call, one tool
call's result, and the diagram-specific sections of the system prompt. Ports packages/diagram-bridge/src/ai.ts and
what it serves from apps/api/src/ai (diagram-tools.ts, diagram-type-primers.ts, standard-prompt.ts,
describe-model.ts); the answers have the bridge's shapes."""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core.ai.primers import primer_for
from canvas_api.diagram_core.ai.prompt import build_standard_prompt, describe_model, link_targets_section
from canvas_api.diagram_core.ai.schema import check_input, tool_json_schema
from canvas_api.diagram_core.ai.tools import State, create_tools, link_target_types

__all__ = ["list_tools", "prompt_sections", "run_tool"]

JsonObj = dict[str, Any]


def list_tools(family: str, rules: JsonObj | None, link_targets: list[JsonObj] | None = None) -> list[JsonObj]:
    """The tools offered for a family under a standard, with the JSON Schema the AI SDK sends providers.
    `link_targets` (canvas-8uh1.5): the diagrams an element may link to; given, linkToDiagram is offered."""
    return [
        {"name": name, "description": tool.description, "inputSchema": tool_json_schema(tool.schema)}
        for name, tool in create_tools(family, rules, link_targets).items()
    ]


def run_tool(
    family: str,
    rules: JsonObj | None,
    model: JsonObj,
    name: str,
    tool_input: Any,
    link_targets: list[JsonObj] | None = None,
) -> JsonObj:
    """One tool call against `model`: {ok: True, model, output, outcomes}, or {ok: False, error} for an unknown
    tool, input that doesn't fit its schema, or an edit that throws (the text the model gets back)."""
    tools = create_tools(family, rules, link_targets)
    tool = tools.get(name)
    if tool is None:
        return {
            "ok": False,
            "error": f"Model tried to call unavailable tool '{name}'. Available tools: {', '.join(tools)}.",
        }
    args, error = check_input(name, tool.schema, tool_input)
    if error is not None:
        return {"ok": False, "error": error}
    state = State(model)
    try:
        output = tool.execute(state, args)
    except ValueError as failure:  # what diagram_ops raises where TypeScript throws (an empty label, a bad link)
        return {"ok": False, "error": str(failure)}
    return {"ok": True, "model": state.model, "output": output, "outcomes": state.outcomes}


def prompt_sections(
    family: str, rules: JsonObj | None, model: JsonObj, link_targets: list[JsonObj] | None = None
) -> JsonObj:
    """{primer, standard, currentDiagram}: the diagram-specific system prompt sections (None where empty); with
    `link_targets` (canvas-8uh1.5) also `linkTargets`, the diagrams an element may link to."""
    sections: JsonObj = {
        "primer": primer_for(family),
        "standard": build_standard_prompt(rules, family) if rules else None,
        "currentDiagram": describe_model(model, rules, family, link_target_types(link_targets)),
    }
    if link_targets is not None:
        sections["linkTargets"] = link_targets_section(link_targets)
    return sections
