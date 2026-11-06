"""Rewrites the tool lists, primers and "Current diagram" sections in ai_tools_vectors.json from the Python tools.

The vectors were generated from the TypeScript tools when they were ported (canvas-1bty.15.7); the TypeScript copy
is gone (canvas-1bty.16), so they are now golden output of these tools, changed on purpose. This only rewrites
what an intended change touches -- the tool list per family and standard, each family's primer, each model's
description, and the
"unavailable tool" error (it lists the tools offered). It never rewrites anything else in the recorded tool-call
runs: those keep checking that the existing tools behave exactly as they did.

    uv run python -m tests.data.update_ai_vectors     (from apps/api-py)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from canvas_api.diagram_core.ai import list_tools, prompt_sections, run_tool
from canvas_api.diagram_core.jsvalues import to_js_json

PATH = Path(__file__).parent / "ai_tools_vectors.json"


def _text(value: Any) -> str:
    return json.dumps(to_js_json(value), separators=(",", ":"), ensure_ascii=False)


def main() -> None:
    data: dict[str, Any] = json.loads(PATH.read_text("utf-8"))
    rules = data["rules"]
    empty = {"nodes": [], "edges": [], "containers": []}
    tool_defs: list[Any] = []
    index_of: dict[str, int] = {}
    for entry in data["tools"]:
        indices = []
        for tool in list_tools(entry["family"], rules[entry["rules"]]):
            key = _text(tool)
            if key not in index_of:
                index_of[key] = len(tool_defs)
                tool_defs.append(json.loads(key))
            indices.append(index_of[key])
        entry["tools"] = indices
    data["toolDefs"] = tool_defs
    for entry in data["standards"]:
        entry["primer"] = prompt_sections(entry["family"], rules[entry["rules"]], empty)["primer"]
    for entry in data["prompts"]:
        model = data["models"][entry["case"]]
        entry["currentDiagram"] = prompt_sections(entry["family"], rules[entry["rules"]], model)["currentDiagram"]
    unavailable = "Model tried to call unavailable tool "
    for run in data["runs"]:
        for step in run["steps"]:
            if step.get("error", "").startswith(unavailable):
                step["error"] = run_tool(run["family"], rules[run["rules"]], empty, step["name"], step["input"])[
                    "error"
                ]
    # JSON.stringify of the whole file: nulls stay (a tool list is compared through to_js_json in the test).
    PATH.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n", "utf-8")
    print(f"{len(tool_defs)} tool definitions, {len(data['prompts'])} descriptions")


if __name__ == "__main__":
    main()
