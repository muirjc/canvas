"""Port of apps/api/src/ai/diagram-tools.ts: the tools the AI chat model may call to edit a diagram.

`create_tools(family, rules)` returns them in TypeScript's order, offered by family and by the active standard
(e.g. the element-kind tools replace addNode under a strict standard). Each one checks that what it refers to
exists and answers {applied: false, reason} if not, then makes its edit through diagram_ops/standard_ops and
records an outcome. Under a standard every applied result also lists the violations the edit introduced
(newViolations), so the model can fix them in the same turn.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from canvas_api.diagram_core import diagram_ops as ops
from canvas_api.diagram_core import layout_ops
from canvas_api.diagram_core.ai.schema import Arr, Bool, Enum, Num, Obj, Schema, Str
from canvas_api.diagram_core.auto_layout import auto_layout, auto_layout_uses_direction, supports_auto_layout
from canvas_api.diagram_core.c4 import C4_BOUNDARY_ROLES, C4_ELEMENT_ROLES
from canvas_api.diagram_core.erd import ER_SOURCE_CARDINALITY_TOKENS, ER_TARGET_CARDINALITY_TOKENS
from canvas_api.diagram_core.family_capabilities import FAMILY_NODE_SHAPES, FAMILY_SUPPORTS_ELEMENT_KINDS
from canvas_api.diagram_core.jsvalues import js_template, js_truthy
from canvas_api.diagram_core.standard_ops import add_element_of_kind, apply_connector_rule, apply_element_kind
from canvas_api.diagram_core.standards import validate
from canvas_api.diagram_core.standards.authoring import offered_shapes
from canvas_api.diagram_core.standards.kinds import (
    classify_node,
    is_approved_color,
    kind_add_blocked_reason,
    resolve_connector_rule,
)
from canvas_api.diagram_core.uml import UML_RELATION_KINDS

__all__ = ["State", "Tool", "create_tools"]

JsonObj = dict[str, Any]

NODE_ROLE_OPTIONS: dict[str, tuple[str, ...]] = {
    "c4": C4_ELEMENT_ROLES,
    "sequence": ("participant", "actor"),
    "architecture": ("junction",),
}
ENTITY_KEY_OPTIONS = ("PK", "FK", "UK")
CLASS_MEMBER_VISIBILITY = ("+", "-", "#", "~")
CONNECTOR_ARROW_OPTIONS: dict[str, tuple[str, ...]] = {
    "flowchart": ("none", "both"),
    "sequence": ("none", "both", "cross", "open"),
}
CONNECTOR_LINE_STYLE_OPTIONS: dict[str, tuple[str, ...]] = {
    "flowchart": ("solid", "dotted", "thick", "invisible"),
    "sequence": ("solid", "dotted"),
}
GROUPABLE_FAMILIES = frozenset({"architecture", "c4", "uml", "sequence", "state"})
SIDES = ("above", "below", "left", "right")
ALIGNMENTS = ("left", "center", "right", "top", "middle", "bottom")
#: The directions the editor's Auto Layout button offers (TB is the same as TD).
LAYOUT_DIRECTIONS = ("TD", "LR", "BT", "RL")
CONTAINER_ROLE_OPTIONS: dict[str, tuple[str, ...]] = {
    "c4": C4_BOUNDARY_ROLES,
    "uml": ("namespace", "note"),
    "sequence": ("box",),
    # canvas-bnnh: grouping states makes a composite state.
    "state": ("composite",),
}
#: canvas-bnnh: what addState adds to a state diagram.
STATE_KINDS = ("state", "start", "end", "choice", "fork", "join")


@dataclass
class State:
    """One tool run's diagram and the outcomes recorded so far."""

    model: JsonObj
    outcomes: list[JsonObj] = field(default_factory=list)


@dataclass(frozen=True)
class Tool:
    description: str
    schema: Obj
    execute: Callable[[State, JsonObj], JsonObj]


def _style_patch_schema(swatches: list[str]) -> dict[str, Schema]:
    def color(desc: str) -> Schema:
        if swatches:
            return Enum(values=tuple(swatches)).opt().describe(f"{desc} Must be one of the standard's approved colors.")
        return Str().opt().describe(desc)

    return {
        "fillColor": color('Fill color as a hex code, e.g. "#1168bd".'),
        "strokeColor": color('Border/line color as a hex code, e.g. "#0b4884".'),
        "strokeWidth": Num().opt().describe("Border/line thickness in pixels."),
        "strokeDasharray": Str().opt().describe('SVG stroke-dasharray, e.g. "5 5", for a dashed/dotted line.'),
        "fontFamily": Str().opt().describe('Font family for the label text, e.g. "Arial".'),
        "fontSize": Num().opt().describe("Font size for the label text, in pixels."),
    }


def _has(items: list[JsonObj], item_id: Any) -> bool:
    return any(item.get("id") == item_id for item in items)


def _without(values: JsonObj, key: str) -> JsonObj:
    return {k: v for k, v in values.items() if k != key}


def _q(value: Any) -> str:
    """`${value}` for a validated input value."""
    return js_template(value)


def create_tools(family: str, rules: JsonObj | None = None) -> dict[str, Tool]:
    node_shapes = offered_shapes(FAMILY_NODE_SHAPES.get(family, FAMILY_NODE_SHAPES["flowchart"]), rules)
    kinds: list[JsonObj] = []
    if rules and family in FAMILY_SUPPORTS_ELEMENT_KINDS:
        kinds = rules.get("elementKinds") or []
    kind_ids: list[str] = [k.get("id") for k in kinds]  # type: ignore[misc]
    strict_kinds = len(kinds) > 0 and js_truthy((rules or {}).get("requireKnownKinds"))
    swatches: list[str] = []
    for kind in kinds:
        for color in [*(kind.get("approvedFills") or []), *(kind.get("approvedStrokes") or [])]:
            if color not in swatches:
                swatches.append(color)
    style_patch = _style_patch_schema(swatches if strict_kinds else [])

    def kind_of_node(model: JsonObj, node_id: str) -> JsonObj | None:
        node = next((n for n in model["nodes"] if n.get("id") == node_id), None)
        return classify_node(node, rules) if node is not None and rules else None

    def record(state: State, name: str, applied: bool, reason: str | None = None) -> JsonObj:
        outcome: JsonObj = {"applied": applied} if reason is None else {"applied": applied, "reason": reason}
        state.outcomes.append({"tool": name, **outcome})
        return outcome

    def not_found(state: State, name: str, what: str, item_id: Any) -> JsonObj:
        return record(state, name, False, f"No {what} with id '{_q(item_id)}' was found.")

    positioned = family in layout_ops.POSITIONED_FAMILIES

    def near_schema() -> dict[str, Schema]:
        """canvas-p2g8.2: where to put a new shape, instead of the next free grid slot."""
        if not positioned:
            return {}
        return {
            "near": Obj.of(
                anchorId=Str().describe("The id of an existing shape or group to place the new shape next to."),
                side=Enum(values=SIDES).describe("Which side of it."),
            )
            .opt()
            .describe("Place the new shape next to an existing one. Omit to put it in the next free grid slot."),
        }

    def check_near(state: State, name: str, args: JsonObj) -> JsonObj | None:
        near = args.get("near")
        if near is not None and layout_ops.find_element(state.model, near["anchorId"]) is None:
            return not_found(state, name, "shape or group", near["anchorId"])
        return None

    def apply_near(state: State, args: JsonObj, new_id: str) -> None:
        near = args.get("near")
        if near is not None:
            state.model = layout_ops.place_relative(state.model, new_id, near["side"], near["anchorId"])

    tools: dict[str, Tool] = {}

    # --- the base tools ------------------------------------------------------------------------------------------

    def remove_node(state: State, args: JsonObj) -> JsonObj:
        if not _has(state.model["nodes"], args["nodeId"]):
            return not_found(state, "removeNode", "shape", args["nodeId"])
        state.model = ops.remove_node(state.model, args["nodeId"])
        return record(state, "removeNode", True)

    tools["removeNode"] = Tool(
        "Remove a shape (and any connectors attached to it) from the flowchart.",
        Obj.of(nodeId=Str().describe("The id of the shape to remove.")),
        remove_node,
    )

    def add_edge(state: State, args: JsonObj) -> JsonObj:
        model = state.model
        source, target = args["sourceId"], args["targetId"]
        # canvas-bnnh: in a state diagram a connector may also end on a composite state (a group).
        missing = [
            i
            for i in (source, target)
            if not _has(model["nodes"], i) and not (family == "state" and _has(model["containers"], i))
        ]
        if missing:
            return not_found(state, "addEdge", "shape", missing[0])
        rule = None
        if rules:
            source_kind, target_kind = kind_of_node(model, source), kind_of_node(model, target)
            rule = resolve_connector_rule(
                rules,
                source_kind.get("id") if source_kind else None,
                target_kind.get("id") if target_kind else None,
            )
            if rule is None and rules.get("connectorPolicy") == "listed-only":
                label_from = (source_kind or {}).get("label")
                label_to = (target_kind or {}).get("label")
                allowed = ", ".join(
                    f"{_q(r.get('from'))} -> {_q(r.get('to'))}" for r in rules.get("connectorRules") or []
                )
                reason = (
                    f"The standard doesn't allow connecting {'that element' if label_from is None else _q(label_from)}"
                    f" to {'that element' if label_to is None else _q(label_to)}. Allowed: {allowed or 'none'}."
                )
                return record(state, "addEdge", False, reason)
        next_model = ops.add_edge(model, {"sourceId": source, "targetId": target, "label": args.get("label")})
        if rule is not None:
            next_model = apply_connector_rule(next_model, next_model["edges"][-1]["id"], rule)
        state.model = next_model
        return record(state, "addEdge", True)

    tools["addEdge"] = Tool(
        "Add a connector between two existing shapes.",
        Obj.of(
            sourceId=Str().describe("The id of the shape the connector starts from."),
            targetId=Str().describe("The id of the shape the connector points to."),
            label=Str().opt().describe("Optional text shown on the connector."),
        ),
        add_edge,
    )

    def remove_edge(state: State, args: JsonObj) -> JsonObj:
        if not _has(state.model["edges"], args["edgeId"]):
            return not_found(state, "removeEdge", "connector", args["edgeId"])
        state.model = ops.remove_edge(state.model, args["edgeId"])
        return record(state, "removeEdge", True)

    tools["removeEdge"] = Tool(
        "Remove a connector from the flowchart.",
        Obj.of(edgeId=Str().describe("The id of the connector to remove.")),
        remove_edge,
    )

    def update_node_label(state: State, args: JsonObj) -> JsonObj:
        if not _has(state.model["nodes"], args["nodeId"]):
            return not_found(state, "updateNodeLabel", "shape", args["nodeId"])
        state.model = ops.update_node_label(state.model, args["nodeId"], args["label"])
        return record(state, "updateNodeLabel", True)

    tools["updateNodeLabel"] = Tool(
        "Rename a shape's label.",
        Obj.of(
            nodeId=Str().describe("The id of the shape to rename."),
            label=Str().describe("The new label text."),
        ),
        update_node_label,
    )

    def update_edge_label(state: State, args: JsonObj) -> JsonObj:
        if not _has(state.model["edges"], args["edgeId"]):
            return not_found(state, "updateEdgeLabel", "connector", args["edgeId"])
        state.model = ops.update_edge_label(state.model, args["edgeId"], args["label"])
        return record(state, "updateEdgeLabel", True)

    tools["updateEdgeLabel"] = Tool(
        "Change or clear a connector's label.",
        Obj.of(
            edgeId=Str().describe("The id of the connector to relabel."),
            label=Str().describe("The new label text (empty string clears it)."),
        ),
        update_edge_label,
    )

    def update_node_style(state: State, args: JsonObj) -> JsonObj:
        node_id = args["nodeId"]
        patch = _without(args, "nodeId")
        model = state.model
        if not _has(model["nodes"], node_id):
            return not_found(state, "updateNodeStyle", "shape", node_id)
        kind = kind_of_node(model, node_id)
        if kind is not None:
            fills = kind.get("approvedFills") or []
            fill: Any = patch.get("fillColor")
            if js_truthy(fill) and len(fills) > 0 and not is_approved_color(fill, fills):
                reason = f"{_q(kind.get('label'))} fill must be one of: {', '.join(fills)}."
                return record(state, "updateNodeStyle", False, reason)
            strokes = kind.get("approvedStrokes") or []
            stroke: Any = patch.get("strokeColor")
            if js_truthy(stroke) and len(strokes) > 0 and not is_approved_color(stroke, strokes):
                reason = f"{_q(kind.get('label'))} border must be one of: {', '.join(strokes)}."
                return record(state, "updateNodeStyle", False, reason)
        state.model = ops.update_node_style(model, node_id, patch)
        return record(state, "updateNodeStyle", True)

    tools["updateNodeStyle"] = Tool(
        "Set a shape's fill/border color, border thickness/dash pattern, or label font. Only the "
        "fields you provide are changed — omit any you want left as they are.",
        Obj.of(nodeId=Str().describe("The id of the shape to restyle."), **style_patch),
        update_node_style,
    )

    def update_edge_style(state: State, args: JsonObj) -> JsonObj:
        if not _has(state.model["edges"], args["edgeId"]):
            return not_found(state, "updateEdgeStyle", "connector", args["edgeId"])
        state.model = ops.update_edge_style(state.model, args["edgeId"], _without(args, "edgeId"))
        return record(state, "updateEdgeStyle", True)

    tools["updateEdgeStyle"] = Tool(
        "Set a connector's line color, thickness/dash pattern, or label font. Only the fields you "
        "provide are changed — omit any you want left as they are.",
        Obj.of(edgeId=Str().describe("The id of the connector to restyle."), **style_patch),
        update_edge_style,
    )

    # Under a strict standard, free-form shapes would only produce unknown-kind violations.
    if family == "state":

        def add_state(state: State, args: JsonObj) -> JsonObj:
            if refused := check_near(state, "addState", args):
                return refused
            group = args.get("groupId")
            if group is not None and not _has(state.model["containers"], group):
                return not_found(state, "addState", "group", group)
            before = state.model
            state.model = ops.add_state_node(
                state.model, {"kind": args["kind"], "label": args.get("label"), "containerId": group}
            )
            if args["kind"] in ("start", "end"):
                node_id = ops.state_pseudo_id(args["kind"], group)
            else:
                node_id = state.model["nodes"][-1]["id"]
            if state.model is not before:
                apply_near(state, args, node_id)
            return {**record(state, "addState", True), "nodeId": node_id}

        tools["addState"] = Tool(
            "Add a state, or a start, end, choice, fork or join point, to the state diagram. Returns its id -- use it "
            "as sourceId/targetId in addEdge. A diagram (and each composite state) has one start and one end: adding "
            "one that exists returns the existing one's id.",
            Obj.of(
                kind=Enum(values=STATE_KINDS).describe(
                    "state (a named state), start or end (the black dot / ringed dot), choice (a decision diamond),"
                    " fork or join (a bar that splits into, or joins, parallel paths)."
                ),
                label=Str().opt().describe('The state\'s name (states only). Defaults to "New State".'),
                groupId=Str().opt().describe("The id of the composite state to put it in, if any."),
                **near_schema(),
            ),
            add_state,
        )

    if not strict_kinds and node_shapes and family != "state":

        def add_node(state: State, args: JsonObj) -> JsonObj:
            if refused := check_near(state, "addNode", args):
                return refused
            state.model = ops.add_node(state.model, {"shape": args["shape"], "label": args.get("label")})
            node_id = state.model["nodes"][-1]["id"]
            apply_near(state, args, node_id)
            return {**record(state, "addNode", True), "nodeId": node_id}

        tools["addNode"] = Tool(
            "Add a new shape to the flowchart. Returns the new shape's id — use it (not the label) "
            "as sourceId/targetId in a later addEdge call to connect it.",
            Obj.of(
                shape=Enum(values=tuple(node_shapes)).describe("The shape to draw."),
                label=Str().opt().describe('Text shown on the shape. Defaults to "New Node" if omitted.'),
                **near_schema(),
            ),
            add_node,
        )

    # --- the standard's element kinds ----------------------------------------------------------------------------

    if kind_ids:
        kind_enum = Enum(values=tuple(kind_ids)).describe("The element kind id.")

        def kind_def(kind_id: str) -> JsonObj:
            return next(k for k in kinds if k.get("id") == kind_id)

        def add_element(state: State, args: JsonObj) -> JsonObj:
            definition = kind_def(args["kind"])
            blocked = kind_add_blocked_reason(state.model, rules, definition) if rules else None
            if blocked:
                return record(state, "addElement", False, blocked)
            if refused := check_near(state, "addElement", args):
                return refused
            opts: JsonObj = {"label": args.get("label")}
            if family == "architecture":
                opts["fallbackShape"] = "icon"
            if rules:
                opts["rules"] = rules
            added = add_element_of_kind(state.model, definition, opts)
            state.model = added["model"]
            apply_near(state, args, added["nodeId"])
            return {**record(state, "addElement", True), "nodeId": added["nodeId"]}

        tools["addElement"] = Tool(
            "Add a new element of one of the standard's element kinds (it gets the kind's shape and "
            "color automatically). Returns the new element's id — use it as sourceId/targetId in addEdge.",
            Obj.of(
                kind=kind_enum,
                label=Str().opt().describe("Text shown on the element. Defaults to the kind name."),
                **near_schema(),
            ),
            add_element,
        )

        def set_element_kind(state: State, args: JsonObj) -> JsonObj:
            node_id = args["nodeId"]
            target = next((n for n in state.model["nodes"] if n.get("id") == node_id), None)
            if target is None:
                return not_found(state, "setElementKind", "shape", node_id)
            if family == "architecture" and target.get("role") == "junction":
                reason = f"'{_q(node_id)}' is a junction; junctions can't have an element kind."
                return record(state, "setElementKind", False, reason)
            definition = kind_def(args["kind"])
            blocked = kind_add_blocked_reason(state.model, rules, definition, node_id) if rules else None
            if blocked:
                return record(state, "setElementKind", False, blocked)
            state.model = apply_element_kind(state.model, node_id, definition, rules)
            return record(state, "setElementKind", True)

        tools["setElementKind"] = Tool(
            "Change an existing element to a different element kind of the standard.",
            Obj.of(nodeId=Str().describe("The id of the element."), kind=kind_enum),
            set_element_kind,
        )

    # --- diagram-type-specific tools -----------------------------------------------------------------------------

    role_options = NODE_ROLE_OPTIONS.get(family)
    if role_options and not (kind_ids and family == "c4"):

        def set_node_role(state: State, args: JsonObj) -> JsonObj:
            if not _has(state.model["nodes"], args["nodeId"]):
                return not_found(state, "setNodeRole", "shape", args["nodeId"])
            state.model = ops.update_node_role(state.model, args["nodeId"], args["role"])
            return record(state, "setNodeRole", True)

        tools["setNodeRole"] = Tool(
            f"Set a shape's semantic role (one of: {', '.join(role_options)}).",
            Obj.of(
                nodeId=Str().describe("The id of the shape to set the role of."),
                role=Enum(values=role_options).describe("The semantic role to assign."),
            ),
            set_node_role,
        )

    if family == "erd":

        def set_entity_attributes(state: State, args: JsonObj) -> JsonObj:
            if not _has(state.model["nodes"], args["nodeId"]):
                return not_found(state, "setEntityAttributes", "entity", args["nodeId"])
            state.model = ops.update_entity_attributes(state.model, args["nodeId"], args["attributes"])
            return record(state, "setEntityAttributes", True)

        tools["setEntityAttributes"] = Tool(
            "Replace an ER entity's full attribute list. Provide every attribute the entity should "
            "have — this replaces the list wholesale, it does not merge with the existing one.",
            Obj.of(
                nodeId=Str().describe("The id of the entity to set attributes on."),
                attributes=Arr(
                    item=Obj.of(
                        type=Str().describe('The attribute\'s data type, e.g. "string", "int".'),
                        name=Str().describe("The attribute's name."),
                        keys=Arr(item=Enum(values=ENTITY_KEY_OPTIONS)).describe(
                            "Zero or more of PK (primary key), FK (foreign key), UK (unique key)."
                        ),
                        comment=Str().opt().describe("Optional descriptive comment, purely informational."),
                    )
                ),
            ),
            set_entity_attributes,
        )

    if family == "uml":

        def set_class_members(state: State, args: JsonObj) -> JsonObj:
            node_id = args["nodeId"]
            if not _has(state.model["nodes"], node_id):
                return not_found(state, "setClassMembers", "class", node_id)
            model = ops.update_class_members(state.model, node_id, args["members"])
            if "stereotype" in args:
                model = ops.update_node_stereotype(model, node_id, args["stereotype"])
            state.model = model
            return record(state, "setClassMembers", True)

        tools["setClassMembers"] = Tool(
            "Replace a UML class's full member list (attributes and methods). Provide every member "
            "the class should have — this replaces the list wholesale, it does not merge with the "
            "existing one. Optionally also sets the class's <<Stereotype>> annotation.",
            Obj.of(
                nodeId=Str().describe("The id of the class to set members on."),
                members=Arr(
                    item=Obj.of(
                        kind=Enum(values=("attribute", "method")).describe(
                            "Whether this member is a typed attribute or a method."
                        ),
                        visibility=Enum(values=CLASS_MEMBER_VISIBILITY)
                        .opt()
                        .describe("+ public, - private, # protected, ~ package/internal. Omit if unmarked."),
                        name=Str().describe("The member's name."),
                        type=Str().opt().describe("Attributes only: the declared type."),
                        params=Str().opt().describe("Methods only: the raw parameter-list text (may be empty)."),
                        returnType=Str().opt().describe("Methods only: the return type, if any."),
                        isStatic=Bool().opt().describe("True for a static member ($ suffix)."),
                        isAbstract=Bool().opt().describe("True for an abstract member (* suffix)."),
                    )
                ),
                stereotype=Str()
                .opt()
                .describe(
                    'The class\'s <<Stereotype>> annotation, e.g. "interface", "abstract". Omit to leave unchanged; '
                    'pass "" to clear it.'
                ),
            ),
            set_class_members,
        )

        def set_relationship_kind(state: State, args: JsonObj) -> JsonObj:
            if not _has(state.model["edges"], args["edgeId"]):
                return not_found(state, "setRelationshipKind", "connector", args["edgeId"])
            state.model = ops.update_edge_relation_kind(state.model, args["edgeId"], _without(args, "edgeId"))
            return record(state, "setRelationshipKind", True)

        tools["setRelationshipKind"] = Tool(
            "Set a UML relationship's kind (inheritance, composition, aggregation, association, "
            "link-solid, dependency, realization, link-dashed, or a lollipop interface) and/or its "
            "cardinality labels. Only the fields you provide are changed.",
            Obj.of(
                edgeId=Str().describe("The id of the relationship to update."),
                umlRelationKind=Enum(values=tuple(UML_RELATION_KINDS)).opt().describe("The relationship kind."),
                sourceCardinality=Str().opt().describe('Cardinality label at the source end, e.g. "1", "0..1", "*".'),
                targetCardinality=Str().opt().describe("Cardinality label at the target end."),
            ),
            set_relationship_kind,
        )

    if family == "erd":

        def set_er_cardinality(state: State, args: JsonObj) -> JsonObj:
            edge_id = args["edgeId"]
            if not _has(state.model["edges"], edge_id):
                return not_found(state, "setErCardinality", "connector", edge_id)
            patch: JsonObj = {}
            if "sourceCardinality" in args:
                patch["erSourceCardinality"] = args["sourceCardinality"]
            if "targetCardinality" in args:
                patch["erTargetCardinality"] = args["targetCardinality"]
            model = ops.update_edge_er_cardinality(state.model, edge_id, patch)
            if "identifying" in args:
                model = ops.update_edge_arrow_style(
                    model, edge_id, {"lineStyle": None if args["identifying"] else "dotted"}
                )
            state.model = model
            return record(state, "setErCardinality", True)

        tools["setErCardinality"] = Tool(
            "Set an ER relationship's crow's-foot cardinality on either or both ends, and/or "
            "whether it is identifying (solid line) or non-identifying (dotted line). Only the "
            "fields you provide are changed.",
            Obj.of(
                edgeId=Str().describe("The id of the relationship to update."),
                sourceCardinality=Enum(values=ER_SOURCE_CARDINALITY_TOKENS)
                .opt()
                .describe("Cardinality token at the source end."),
                targetCardinality=Enum(values=ER_TARGET_CARDINALITY_TOKENS)
                .opt()
                .describe("Cardinality token at the target end."),
                identifying=Bool()
                .opt()
                .describe("True for a solid (identifying) line, false for a dotted (non-identifying) line."),
            ),
            set_er_cardinality,
        )

    arrows, line_styles = CONNECTOR_ARROW_OPTIONS.get(family), CONNECTOR_LINE_STYLE_OPTIONS.get(family)
    if arrows and line_styles:

        def set_connector_style(state: State, args: JsonObj) -> JsonObj:
            if not _has(state.model["edges"], args["edgeId"]):
                return not_found(state, "setConnectorStyle", "connector", args["edgeId"])
            state.model = ops.update_edge_arrow_style(state.model, args["edgeId"], _without(args, "edgeId"))
            return record(state, "setConnectorStyle", True)

        tools["setConnectorStyle"] = Tool(
            "Set a connector's arrowhead and/or line style. Only the fields you provide are changed.",
            Obj.of(
                edgeId=Str().describe("The id of the connector to update."),
                arrow=Enum(values=arrows).opt().describe("Which endpoint(s) carry an arrowhead."),
                lineStyle=Enum(values=line_styles).opt().describe("The connector's line rendering."),
            ),
            set_connector_style,
        )

    if family in GROUPABLE_FAMILIES:
        container_roles = CONTAINER_ROLE_OPTIONS.get(family)

        def group_into_container(state: State, args: JsonObj) -> JsonObj:
            node_ids = args["nodeIds"]
            model = state.model
            existing = [i for i in node_ids if _has(model["nodes"], i)]
            if not existing:
                return not_found(state, "groupIntoContainer", "shape", node_ids[0])
            role = args.get("kind")
            if role is None and container_roles:
                role = container_roles[0]
            model = ops.add_container(model, {"label": args.get("label"), "role": role})
            container_id = model["containers"][-1]["id"]
            for node_id in existing:
                model = ops.assign_node_to_container(model, node_id, container_id)
            state.model = model
            return {**record(state, "groupIntoContainer", True), "containerId": container_id}

        group_shape: dict[str, Schema] = {
            "nodeIds": Arr(item=Str(), min_items=1).describe("Ids of the shapes to group together."),
            "label": Str().opt().describe('Label for the new container. Defaults to "Container" if omitted.'),
        }
        if container_roles:
            group_shape["kind"] = (
                Enum(values=container_roles)
                .opt()
                .describe(
                    f"The kind of container to create (one of: {', '.join(container_roles)}). "
                    f'Defaults to "{container_roles[0]}" if omitted.'
                )
            )
        tools["groupIntoContainer"] = Tool(
            "Group one or more existing shapes into a new labeled container (a boundary/namespace/box, "
            "depending on the diagram type). Returns the new container's id.",
            Obj.of(**group_shape),
            group_into_container,
        )

    # --- canvas-p2g8.2: layout -----------------------------------------------------------------------------------

    if positioned:

        def missing(state: State, name: str, ids: list[str]) -> JsonObj | None:
            """All-or-nothing: an unknown id refuses the whole call before anything moves."""
            for element_id in ids:
                if layout_ops.find_element(state.model, element_id) is None:
                    return not_found(state, name, "shape or group", element_id)
            return None

        def move_elements(state: State, args: JsonObj) -> JsonObj:
            moves = args["moves"]
            if refused := missing(state, "moveElements", [m["id"] for m in moves]):
                return refused
            for move in moves:
                state.model = layout_ops.move_element(state.model, move["id"], move["x"], move["y"])
            return record(state, "moveElements", True)

        tools["moveElements"] = Tool(
            "Move shapes or groups to exact positions (the top-left corner, in the same units as the positions in "
            "the diagram summary). A group's contents move with it.",
            Obj.of(
                moves=Arr(
                    item=Obj.of(
                        id=Str().describe("The id of a shape or group."),
                        x=Num().describe("The new left edge."),
                        y=Num().describe("The new top edge."),
                    ),
                    min_items=1,
                ).describe("The moves to make."),
            ),
            move_elements,
        )

        def align(state: State, args: JsonObj) -> JsonObj:
            if refused := missing(state, "alignElements", args["ids"]):
                return refused
            state.model = layout_ops.align_elements(state.model, args["ids"], args["alignment"])
            return record(state, "alignElements", True)

        tools["alignElements"] = Tool(
            "Line up shapes or groups: left/right/top/bottom move each one's edge to the outermost one's; "
            "center/middle put their centres on the middle of the selection across or down.",
            Obj.of(
                ids=Arr(item=Str(), min_items=2).describe("The ids of the shapes or groups to line up."),
                alignment=Enum(values=ALIGNMENTS).describe("Which edge or centre line to line them up on."),
            ),
            align,
        )

        def distribute(state: State, args: JsonObj) -> JsonObj:
            if refused := missing(state, "distributeElements", args["ids"]):
                return refused
            state.model = layout_ops.distribute_elements(state.model, args["ids"], args["axis"])
            return record(state, "distributeElements", True)

        tools["distributeElements"] = Tool(
            "Space three or more shapes or groups evenly across (horizontal) or down (vertical), keeping the "
            "first and last where they are.",
            Obj.of(
                ids=Arr(item=Str(), min_items=3).describe("The ids of the shapes or groups to space out."),
                axis=Enum(values=("horizontal", "vertical")).describe("Across or down."),
            ),
            distribute,
        )

        def place(state: State, args: JsonObj) -> JsonObj:
            element_id, anchor_id = args["elementId"], args["anchorId"]
            if refused := missing(state, "placeRelative", [element_id, anchor_id]):
                return refused
            if element_id == anchor_id:
                return record(state, "placeRelative", False, "A shape can't be placed next to itself.")
            gap = args.get("gap")
            state.model = layout_ops.place_relative(
                state.model, element_id, args["side"], anchor_id, layout_ops.DEFAULT_GAP if gap is None else gap
            )
            return record(state, "placeRelative", True)

        tools["placeRelative"] = Tool(
            "Move a shape or group next to another one (above, below, left or right of it), centred on it.",
            Obj.of(
                elementId=Str().describe("The id of the shape or group to move."),
                side=Enum(values=SIDES).describe("Which side of the anchor to put it on."),
                anchorId=Str().describe("The id of the shape or group to put it next to."),
                gap=Num().opt().describe(f"The space between them. Defaults to {layout_ops.DEFAULT_GAP}."),
            ),
            place,
        )

    if supports_auto_layout(family):
        uses_direction = auto_layout_uses_direction(family)

        def arrange(state: State, args: JsonObj) -> JsonObj:
            state.model = auto_layout(state.model, args.get("direction") if uses_direction else None, family)
            return record(state, "arrange", True)

        arrange_shape: dict[str, Schema] = {}
        if uses_direction:
            arrange_shape["direction"] = (
                Enum(values=LAYOUT_DIRECTIONS)
                .opt()
                .describe(
                    "Which way the arrows flow: TD top to bottom, LR left to right, BT bottom to top, RL right to "
                    "left. Defaults to the diagram's current direction."
                )
            )
        tools["arrange"] = Tool(
            "Lay the whole diagram out automatically, as the editor's Auto Layout button does: connected shapes "
            "in ranks along the flow, few crossings, every group sized around its contents. Use it after adding "
            "several shapes, or when asked to tidy up; then fine-tune with the other layout tools if needed. "
            "Shapes and groups marked pinned stay where they are; everything else is arranged around them.",
            Obj.of(**arrange_shape),
            arrange,
        )

    if family == "sequence":
        for role, name, description in (
            (
                "activate",
                "activateParticipant",
                "Mark a participant as actively processing, starting at this point in the sequence.",
            ),
            (
                "deactivate",
                "deactivateParticipant",
                "Mark a participant as no longer actively processing, at this point in the sequence.",
            ),
        ):

            def mark(state: State, args: JsonObj, role: str = role, name: str = name) -> JsonObj:
                participant = args["participantId"]
                if not _has(state.model["nodes"], participant):
                    return not_found(state, name, "participant", participant)
                state.model = ops.add_point_marker_container(state.model, {"role": role, "attachedNodeId": participant})
                return record(state, name, True)

            tools[name] = Tool(
                description,
                Obj.of(participantId=Str().describe("The id of the participant/actor.")),
                mark,
            )

    if rules:
        return {name: _with_new_violations(tool, rules) for name, tool in tools.items()}
    return tools


def _violation_key(violation: JsonObj) -> tuple[str, str]:
    def text(key: str) -> str:
        return js_template(violation[key]) if key in violation else "undefined"

    return text("elementId"), text("rule")


def _with_new_violations(tool: Tool, rules: JsonObj) -> Tool:
    """An applied result also lists the violations the edit introduced (at most five)."""

    def execute(state: State, args: JsonObj) -> JsonObj:
        before = {_violation_key(v) for v in validate(state.model, rules)}
        result = tool.execute(state, args)
        if not js_truthy(result.get("applied")):
            return result
        introduced = [v for v in validate(state.model, rules) if _violation_key(v) not in before][:5]
        if not introduced:
            return result
        fields = ("rule", "elementId", "message", "severity")
        return {**result, "newViolations": [{k: v[k] for k in fields if k in v} for v in introduced]}

    return Tool(tool.description, tool.schema, execute)
