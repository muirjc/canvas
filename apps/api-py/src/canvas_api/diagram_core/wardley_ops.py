"""canvas-4h1j.2: edits to a Wardley map, ported from packages/diagram-core/src/model/wardley-ops.ts (identical:
tests/test_diagram_core_wardley_ops.py replays TypeScript's results). Coordinates are [visibility, evolution]; a
moved element gets 0-1 values to two decimals, kept inside the map. A pipeline component keeps its parent's
visibility; moving a pipeline's parent carries its pipeline along. Errors are ValueErrors with TypeScript's text.
"""

from __future__ import annotations

from typing import Any

from canvas_api.diagram_core import diagram_ops
from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.wardley import (
    _js_max,
    _js_min,
    _js_round,
    lay_out_pipelines,
    wardley_coordinates_at,
    wardley_frame,
    wardley_point,
)
from canvas_api.github.jstext import js_trim

__all__ = [
    "WARDLEY_ELEMENT_KINDS",
    "WARDLEY_FLOWS",
    "WARDLEY_STRATEGIES",
    "add_wardley_element",
    "add_wardley_pipeline_component",
    "move_wardley_element",
    "remove_wardley_element",
    "set_wardley_link_flow",
    "set_wardley_markings",
    "wardley_name_taken",
]

Obj = dict[str, Any]
_ABSENT = object()

WARDLEY_ELEMENT_KINDS = ("anchor", "component", "note", "annotation", "accelerator", "deaccelerator")
WARDLEY_STRATEGIES = ("build", "buy", "outsource", "market")
WARDLEY_FLOWS = ("+>", "+<", "+<>")

_DEFAULT_LABELS = {
    "anchor": "New Anchor",
    "component": "New Component",
    "note": "New note",
    "annotation": "New annotation",
    "accelerator": "Accelerator",
    "deaccelerator": "Deaccelerator",
}
_NAMED_ROLES = frozenset({"anchor", "component"})


def _fraction(value: float) -> float:
    """A coordinate as a move writes it: 0-1, two decimals."""
    return _js_min(1, _js_max(0, _js_round(value * 100) / 100))


def _is_pipeline_container(model: Obj, container_id: Any) -> bool:
    return container_id is not None and any(
        c.get("id") == container_id and c.get("role") == "pipeline" for c in model["containers"]
    )


def _map_names(model: Obj, except_id: str | None = None) -> set[str]:
    return {
        n["label"]
        for n in model["nodes"]
        if n.get("id") != except_id
        and (n.get("role") is None or n.get("role") in _NAMED_ROLES)
        and not _is_pipeline_container(model, n.get("containerId"))
    }


def _free_name(label: str, taken: set[str]) -> str:
    if label not in taken:
        return label
    n = 2
    while f"{label} {n}" in taken:
        n += 1
    return f"{label} {n}"


def wardley_name_taken(model: Obj, node_id: str, label: str) -> bool:
    """Whether `label` would give a node a name another anchor or component (or, for a pipeline component, another
    component of its pipeline) already has: Mermaid would read the two as one."""
    node = next((n for n in model["nodes"] if n.get("id") == node_id), None)
    if node is None:
        return False
    if _is_pipeline_container(model, node.get("containerId")):
        return any(
            n.get("id") != node_id and n.get("containerId") == node.get("containerId") and n.get("label") == label
            for n in model["nodes"]
        )
    if node.get("role") is not None and node.get("role") not in _NAMED_ROLES:
        return False
    return label in _map_names(model, node_id)


def _frame_of(model: Obj) -> dict[str, float]:
    return wardley_frame(model)


def add_wardley_element(model: Obj, element: Obj) -> Obj:
    """An anchor, component, note, annotation, accelerator or deaccelerator; without coordinates on a grid that
    steps with the number of elements. An anchor's or component's name is made distinct."""
    kind = element.get("kind")
    if kind not in WARDLEY_ELEMENT_KINDS:
        raise ValueError(f'addWardleyElement: unknown kind "{js_template(kind)}"')
    count = len(model["nodes"])
    visibility = element.get("visibility")
    evolution = element.get("evolution")
    point: Obj = {
        "visibility": _fraction(visibility) if visibility is not None else _fraction(0.85 - ((count // 7) % 8) * 0.1),
        "evolution": _fraction(evolution) if evolution is not None else _fraction(0.15 + (count % 7) * 0.1),
    }
    label = element.get("label")
    label = _DEFAULT_LABELS[kind] if label is None else label
    if js_trim(label) == "":
        raise ValueError("addWardleyElement: the name must not be empty")
    if kind in _NAMED_ROLES:
        label = _free_name(label, _map_names(model))
    data: Obj = dict(point)
    if kind == "annotation":
        number = element.get("number")
        if number is not None:
            data["number"] = _js_max(0, _js_round(number))
        else:
            highest: float = 0
            for n in model["nodes"]:
                if n.get("role") == "annotation":
                    value = (n.get("wardley") or {}).get("number")
                    highest = _js_max(highest, 0 if value is None else value)
            data["number"] = highest + 1
    node: Obj = {
        "id": diagram_ops.generate_id("w"),
        "label": label,
        "shape": "rectangle" if kind in ("note", "accelerator", "deaccelerator") else "circle",
        "role": kind,
        "position": wardley_point(_frame_of(model), point),
        "wardley": data,
    }
    return {**model, "nodes": [*model["nodes"], node]}


def move_wardley_element(model: Obj, node_id: str, point: Obj) -> Obj:
    """Moves an element to [visibility, evolution]; a pipeline component along the evolution axis only, a
    pipeline's parent with its pipeline."""
    node = next((n for n in model["nodes"] if n.get("id") == node_id), None)
    if node is None:
        raise ValueError(f'moveWardleyElement: there is no element "{node_id}"')
    frame = _frame_of(model)
    by_id = {n["id"]: n for n in model["nodes"]}
    pipeline_of = {c["id"]: c for c in model["containers"] if c.get("role") == "pipeline"}
    moved: dict[str, Obj] = {}
    container_id = node.get("containerId")
    own_pipeline = pipeline_of.get(container_id) if container_id is not None else None
    if own_pipeline is not None:
        attached = own_pipeline.get("attachedNodeIds") or []
        parent = by_id.get(attached[0] if attached else "")
        parent_data = (parent or {}).get("wardley")
        own = node.get("wardley")
        if parent_data is not None:
            visibility = parent_data["visibility"]
        elif own is not None:
            visibility = own["visibility"]
        else:
            visibility = 0
        moved[node["id"]] = {
            **(own if own is not None else {"visibility": visibility}),
            "visibility": visibility,
            "evolution": _fraction(point["evolution"]),
        }
    else:
        target = {"visibility": _fraction(point["visibility"]), "evolution": _fraction(point["evolution"])}
        own = node.get("wardley")
        moved[node["id"]] = {**(own if own is not None else target), **target}
        dx = wardley_point(frame, target)["x"] - node["position"]["x"]
        for pipeline in pipeline_of.values():
            attached = pipeline.get("attachedNodeIds") or []
            if (attached[0] if attached else None) != node["id"]:
                continue
            for child in model["nodes"]:
                if child.get("containerId") != pipeline["id"]:
                    continue
                evolution = wardley_coordinates_at(
                    frame, {"x": child["position"]["x"] + dx, "y": child["position"]["y"]}
                )["evolution"]
                child_data = child.get("wardley")
                moved[child["id"]] = {
                    **(child_data if child_data is not None else target),
                    "visibility": target["visibility"],
                    "evolution": evolution,
                }
    nodes = []
    for n in model["nodes"]:
        data = moved.get(n["id"])
        nodes.append({**n, "position": wardley_point(frame, data), "wardley": data} if data is not None else n)
    result = {**model, "nodes": nodes, "containers": [dict(c) for c in model["containers"]]}
    lay_out_pipelines(result, frame)
    return result


def set_wardley_markings(model: Obj, node_id: str, patch: Obj) -> Obj:
    """Sets or clears a component's strategy, inertia and evolve arrow; only the fields given change."""
    node = next((n for n in model["nodes"] if n.get("id") == node_id), None)
    if node is None:
        raise ValueError(f'setWardleyMarkings: there is no element "{node_id}"')
    if node.get("role") is not None and node.get("role") not in ("component", "pipeline-component"):
        raise ValueError("setWardleyMarkings: only a component has a strategy, inertia or an evolve arrow")
    strategy = patch.get("strategy", _ABSENT)
    # A pipeline's `component Name [evolution]` line has no room for them (an evolve line names any component).
    if node.get("role") == "pipeline-component" and (strategy is not _ABSENT or "inertia" in patch):
        raise ValueError("setWardleyMarkings: a pipeline component has no strategy or inertia, only an evolve arrow")
    if js_truthy(strategy) and strategy is not _ABSENT and strategy not in WARDLEY_STRATEGIES:
        raise ValueError(f'setWardleyMarkings: unknown strategy "{js_template(strategy)}"')
    evolve = patch.get("evolve", _ABSENT)
    if evolve is not _ABSENT and evolve is not None and not _finite(evolve):
        raise ValueError("setWardleyMarkings: evolve must be a number")
    own = node.get("wardley")
    data: Obj = dict(own if own is not None else wardley_coordinates_at(_frame_of(model), node["position"]))
    if strategy is not _ABSENT:
        if strategy is None:
            data.pop("strategy", None)
        else:
            data["strategy"] = strategy
    inertia = patch.get("inertia", _ABSENT)
    if inertia is not _ABSENT:
        if js_truthy(inertia):
            data["inertia"] = True
        else:
            data.pop("inertia", None)
    if evolve is not _ABSENT:
        if evolve is None:
            data.pop("evolve", None)
        else:
            data["evolve"] = _fraction(evolve)
    return {**model, "nodes": [{**n, "wardley": data} if n.get("id") == node_id else n for n in model["nodes"]]}


def _finite(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value == value
        and abs(value) != float("inf")
    )


def add_wardley_pipeline_component(model: Obj, parent_id: str, element: Obj | None = None) -> Obj:
    """Adds a component to a component's pipeline (making the pipeline when it has none), at the parent's
    visibility; without an evolution just right of the pipeline's last component."""
    element = element or {}
    parent = next((n for n in model["nodes"] if n.get("id") == parent_id), None)
    if parent is None:
        raise ValueError(f'addWardleyPipelineComponent: there is no component "{parent_id}"')
    if (parent.get("role") is not None and parent.get("role") != "component") or _is_pipeline_container(
        model, parent.get("containerId")
    ):
        raise ValueError(
            "addWardleyPipelineComponent: only a component (not an anchor, note or pipeline component) can have a"
            " pipeline"
        )
    frame = _frame_of(model)
    parent_data = parent.get("wardley")
    parent_point = parent_data if parent_data is not None else wardley_coordinates_at(frame, parent["position"])
    containers = [dict(c) for c in model["containers"]]
    pipeline = next(
        (
            c
            for c in containers
            if c.get("role") == "pipeline" and ((c.get("attachedNodeIds") or [None])[0]) == parent_id
        ),
        None,
    )
    if pipeline is None:
        taken = {n["id"] for n in model["nodes"]} | {c["id"] for c in model["containers"]}
        pipeline_id = f"~pipeline:{parent_id}"
        n = 2
        while pipeline_id in taken:
            pipeline_id = f"~pipeline:{parent_id}~{n}"
            n += 1
        pipeline = {"id": pipeline_id, "label": "", "role": "pipeline", "attachedNodeIds": [parent_id],
                    "position": {"x": 0, "y": 0}}  # fmt: skip
        containers = [*containers, pipeline]
    children = [n for n in model["nodes"] if n.get("containerId") == pipeline["id"]]
    last: float = -1
    for child in children:
        last = _js_max(last, wardley_coordinates_at(frame, child["position"])["evolution"])
    given = element.get("evolution")
    evolution = _fraction(given if given is not None else (parent_point["evolution"] if last < 0 else last + 0.1))
    label = element.get("label")
    if label is None:
        label = _free_name(_DEFAULT_LABELS["component"], {n["label"] for n in children})
    if js_trim(label) == "":
        raise ValueError("addWardleyPipelineComponent: the name must not be empty")
    if any(n.get("label") == label for n in children):
        raise ValueError(f'addWardleyPipelineComponent: the pipeline already has a component named "{label}"')
    data = {"visibility": parent_point["visibility"], "evolution": evolution}
    node: Obj = {
        "id": diagram_ops.generate_id("w"),
        "label": label,
        "shape": "circle",
        "role": "pipeline-component",
        "position": wardley_point(frame, data),
        "wardley": data,
        "containerId": pipeline["id"],
    }
    result = {**model, "nodes": [*model["nodes"], node], "containers": containers}
    lay_out_pipelines(result, frame)
    return result


def remove_wardley_element(model: Obj, node_id: str) -> Obj:
    """Removes an element and its links; with a pipeline's parent its pipeline and components, with a pipeline's
    last component the pipeline."""
    if not any(n.get("id") == node_id for n in model["nodes"]):
        return model
    pipelines = {
        c["id"]
        for c in model["containers"]
        if c.get("role") == "pipeline" and ((c.get("attachedNodeIds") or [None])[0]) == node_id
    }
    gone = {
        n["id"]
        for n in model["nodes"]
        if n.get("id") == node_id or (n.get("containerId") is not None and n.get("containerId") in pipelines)
    }
    nodes = [n for n in model["nodes"] if n["id"] not in gone]
    used = {n.get("containerId") for n in nodes}
    result = {
        **model,
        "nodes": nodes,
        "edges": [e for e in model["edges"] if e.get("sourceId") not in gone and e.get("targetId") not in gone],
        "containers": [
            dict(c)
            for c in model["containers"]
            if c["id"] not in pipelines and (c.get("role") != "pipeline" or c["id"] in used)
        ],
    }
    lay_out_pipelines(result)
    return result


def set_wardley_link_flow(model: Obj, edge_id: str, flow: str | None) -> Obj:
    """A link's flow arrowhead (`+>`, `+<`, `+<>`; None = a plain `->` link). A labelled flow arrow keeps its label."""
    edge = next((e for e in model["edges"] if e.get("id") == edge_id), None)
    if edge is None:
        raise ValueError(f'setWardleyLinkFlow: there is no link "{edge_id}"')
    if flow is not None and flow not in WARDLEY_FLOWS:
        raise ValueError(f'setWardleyLinkFlow: unknown flow "{js_template(flow)}"')
    own = edge.get("wardley")
    data: Obj = dict(own if own is not None else {"arrow": "->"})
    data.pop("fromPort", None)
    data.pop("toPort", None)
    if js_truthy(data.get("flowArrow")):
        if js_truthy(flow):
            data["flowArrow"] = {**data["flowArrow"], "flow": flow}
        else:
            data.pop("flowArrow", None)
            data["arrow"] = "->"
    elif js_truthy(flow):
        data.pop("arrow", None)
        data["fromPort"] = flow
    elif not js_truthy(data.get("arrow")):
        data["arrow"] = "->"
    return {**model, "edges": [{**e, "wardley": data} if e.get("id") == edge_id else e for e in model["edges"]]}
