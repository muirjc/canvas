"""Mermaid state diagrams (packages/diagram-core/src/dsl/state.ts, canvas-bnnh).

A line-by-line port: the same regular expressions (JavaScript's `\\s`, `\\w` and `.` spelled out, `\\Z` for `$`,
/i folding ASCII only), tried in the same order, the same scopes, pseudo-state ids, region containers, style
passes and front matter. Parse returns {"model": ...} or {"errors": [...]}, never raises (bad YAML front matter
excepted, as in TypeScript). See state.ts for how the syntax maps onto the model.
"""

from __future__ import annotations

import re
import sys
from typing import Any

from canvas_api.diagram_core.containment_layout import compute_containment_layout
from canvas_api.diagram_core.flowchart import parse_style_props
from canvas_api.diagram_core.front_matter import (
    apply_frames,
    apply_links,
    canvas_section,
    join_front_matter,
    read_legend,
    read_pinned,
    section,
    split_front_matter,
    strip_trailing_comment,
    with_frames,
    with_legend,
    with_links,
    with_pinned,
)
from canvas_api.diagram_core.jsvalues import js_truthy
from canvas_api.diagram_core.model import create_empty_diagram_model, is_allowed_link_href
from canvas_api.diagram_core.read_order import in_read_order
from canvas_api.github.jstext import JS_WHITESPACE, js_trim

__all__ = ["parse_state", "serialize_state"]

S = f"[{JS_WHITESPACE}]"  # JavaScript's \s
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
W = "[A-Za-z0-9_]"  # JavaScript's \w
_ASCII_I = re.IGNORECASE | re.ASCII
ID = f'[^{JS_WHITESPACE}:{{}}"%;,\\[\\]<>\\-]+'
ENDPOINT = f"(\\[\\*\\]|{ID})(?::::({W}+))?"

HEADER = re.compile("^stateDiagram(?:-v2)?\\Z", _ASCII_I)
MERMAID_CONFIG_DIRECTIVE = re.compile(f"^%%\\{{{DOT}*\\}}%%\\Z")
DIRECTION = re.compile(f"^direction{S}+(TB|BT|LR|RL)\\Z", _ASCII_I)
TITLE = re.compile(f"^title{S}+({DOT}+)\\Z")
ACC_TITLE = re.compile(f"^accTitle{S}*:{S}*({DOT}+)\\Z")
ACC_DESCR = re.compile(f"^accDescr{S}*:{S}*({DOT}+)\\Z")
ACC_DESCR_BLOCK = re.compile(f"^accDescr{S}*\\{{{S}*\\Z")
IGNORED = [
    re.compile(f"^hide{S}+empty{S}+description\\Z", _ASCII_I),
    re.compile(f"^scale{S}+[0-9]+{S}+width\\Z", _ASCII_I),
]
CLASS_DEF = re.compile(f"^classDef{S}+({W}+){S}+({DOT}+)\\Z")
CLASS_ASSIGN = re.compile(f"^class{S}+({W}+(?:{S}*,{S}*{W}+)*){S}+({W}+)\\Z")
STYLE = re.compile(f"^style{S}+([A-Za-z0-9_,]+){S}+({DOT}+)\\Z")
CLICK_HREF = re.compile(f'^click{S}+({ID}){S}+href{S}+"([^"]*)"(?:{S}+"([^"]*)")?\\Z')
CLICK_URL = re.compile(f'^click{S}+({ID}){S}+"([^"]*)"(?:{S}+"([^"]*)")?\\Z')
CLICK_CALL = re.compile(f"^click{S}+({ID}){S}+call(?!{W})")
NOTE_LINE = re.compile(f"^note{S}+(left|right){S}+of{S}+({ID}){S}*:{S}*({DOT}+)\\Z", _ASCII_I)
NOTE_START = re.compile(f"^note{S}+(left|right){S}+of{S}+({ID})\\Z", _ASCII_I)
NOTE_END = re.compile(f"^end{S}+note\\Z", _ASCII_I)
COMPOSITE_ALIAS_START = re.compile(f'^state{S}+"([^"]*)"{S}+as{S}+({ID}){S}*\\{{\\Z')
COMPOSITE_START = re.compile(f"^state{S}+({ID}){S}*\\{{\\Z")
BLOCK_END = re.compile("^\\}\\Z")
STEREOTYPE = re.compile(
    f"^state{S}+({ID}){S}*(?:<<(choice|fork|join)>>|\\[\\[(choice|fork|join)\\]\\])\\Z",
    _ASCII_I,
)
STATE_ALIAS = re.compile(f'^state{S}+"([^"]*)"{S}+as{S}+({ID})(?:{S}*:{S}*({DOT}+))?\\Z')
STATE_BARE = re.compile(f"^state{S}+({ID})\\Z")
CONCURRENCY = re.compile("^--\\Z")
TRANSITION = re.compile(f"^{ENDPOINT}{S}*-->{S}*{ENDPOINT}(?:{S}*:{S}*({DOT}*))?\\Z")
DESCRIPTION = re.compile(f"^({ID}){S}*:{S}*({DOT}+)\\Z")
STATE_REF = re.compile(f"^{ENDPOINT}\\Z")
_LINE_SPLIT = re.compile(r"\r?\n")
_TRAILING_SEMICOLON = re.compile(f";{S}*\\Z")
_LINE_BREAKS = re.compile("[\\r\\n]+")
_HAS_LINE_BREAK = re.compile("[\\r\\n]")
_NOTE_NEEDS_BLOCK = re.compile("[\\r\\n:;]")

PSEUDO_ROLES = {"choice": "choice", "fork": "fork", "join": "join"}
ROLE_SHAPE = {
    "state": "rounded-rectangle",
    "start": "state-start",
    "end": "state-end",
    "choice": "diamond",
    "fork": "fork-bar",
    "join": "fork-bar",
}
#: JavaScript's Number.MAX_SAFE_INTEGER: a key past every connector.
_LAST = sys.maxsize


def _style_props(props_raw: str) -> dict[str, Any]:
    return parse_style_props(_TRAILING_SEMICOLON.sub("", props_raw, count=1))


def _scope_key(scope: list[Any] | None) -> str:
    """A scope is [composite id, region]; the top level is ''."""
    return f"{scope[0]}\u0000{scope[1]}" if scope else ""


def _saved_size(meta: Any) -> dict[str, Any]:
    """A group's saved size, when the front matter gives both (a null counts as none)."""
    if isinstance(meta, dict) and meta.get("width") is not None and meta.get("height") is not None:
        return {"size": {"width": meta["width"], "height": meta["height"]}}
    return {}


def _saved_position(meta: Any, placeholder: dict[str, Any]) -> dict[str, Any]:
    if js_truthy(meta):
        return {
            "x": meta.get("x") if isinstance(meta, dict) else None,
            "y": meta.get("y") if isinstance(meta, dict) else None,
        }
    return placeholder


def _append_description(node: dict[str, Any], text: str) -> None:
    node["description"] = f"{node['description']}\n{text}" if node.get("description") else text


def parse_state(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    canvas = canvas_section(front_matter)
    positions = section(canvas, "positions")
    styles = section(canvas, "styles")
    container_meta = section(canvas, "containers")
    edge_styles = section(canvas, "edgeStyles")
    is_fresh_import = not positions and not container_meta
    placeholder: dict[str, Any] = {"x": 0, "y": 0}
    auto = [0]

    def next_position() -> dict[str, Any]:
        k = auto[0]
        auto[0] += 1
        return {"x": (k % 5) * 200 + 40, "y": (k // 5) * 140 + 40}

    def place(node_id: str) -> Any:
        saved = positions.get(node_id)
        if saved is not None:
            return saved
        return placeholder if is_fresh_import else next_position()

    errors: list[dict[str, Any]] = []
    nodes: dict[str, dict[str, Any]] = {}
    node_scope: dict[str, str] = {}
    composites: dict[str, dict[str, Any]] = {}
    composite_scope: dict[str, str] = {}
    region_count: dict[str, int] = {}
    notes: list[tuple[dict[str, Any], str]] = []
    edges: list[tuple[dict[str, Any], str]] = []
    class_defs: dict[str, dict[str, Any]] = {}
    class_uses: list[tuple[list[str], str]] = []
    style_uses: list[tuple[list[str], str]] = []
    #: [composite, region, line, content] per open composite block.
    stack: list[list[Any]] = []
    header_seen = False
    direction = None
    raw_title = front_matter.get("title") if isinstance(front_matter, dict) else None
    title = raw_title if isinstance(raw_title, str) else None
    acc_title = acc_descr = config_directive = None
    open_note: dict[str, Any] | None = None
    open_acc_descr: list[str] | None = None
    edge_counter = 0

    def current_scope() -> list[Any] | None:
        return stack[-1] if stack else None

    def pseudo_id(kind: str, scope: list[Any] | None) -> str:
        return f"\u0000{kind}\u0000{_scope_key(scope)}"

    def ensure_node(node_id: str, scope: list[Any] | None, role: str = "state") -> dict[str, Any] | None:
        if node_id in composites:
            return None
        node = nodes.get(node_id)
        if node is None:
            node = {
                "id": node_id,
                "label": node_id if role == "state" else "",
                "shape": ROLE_SHAPE[role],
                "role": role,
                "position": place(node_id),
                "style": styles.get(node_id),
            }
            nodes[node_id] = node
            node_scope[node_id] = _scope_key(scope)
        return node

    def endpoint(raw: str, kind: str, scope: list[Any] | None) -> str:
        if raw != "[*]":
            ensure_node(raw, scope)
            return raw
        node_id = pseudo_id(kind, scope)
        if node_id not in nodes:
            nodes[node_id] = {
                "id": node_id,
                "label": "",
                "shape": ROLE_SHAPE[kind],
                "role": kind,
                "position": placeholder,
            }
            node_scope[node_id] = _scope_key(scope)
        return node_id

    def add_note(side: str, target: str, text: str, scope: list[Any] | None) -> None:
        ensure_node(target, scope)
        container = {
            "id": f"note{len(notes) + 1}",
            "label": text,
            "role": f"note-{side}",
            "attachedNodeIds": [target],
            "position": placeholder,
        }
        notes.append((container, _scope_key(scope)))

    for index, raw_line in enumerate(_LINE_SPLIT.split(body)):
        line_number = index + 1
        if open_note is not None:
            if NOTE_END.match(js_trim(raw_line)):
                add_note(open_note["side"], open_note["target"], js_trim("\n".join(open_note["text"])), current_scope())
                open_note = None
            else:
                open_note["text"].append(js_trim(raw_line))
            continue
        if open_acc_descr is not None:
            if js_trim(raw_line) == "}":
                acc_descr = js_trim("\n".join(open_acc_descr))
                open_acc_descr = None
            else:
                open_acc_descr.append(js_trim(raw_line))
            continue
        trimmed = js_trim(raw_line)
        if MERMAID_CONFIG_DIRECTIVE.match(trimmed):
            config_directive = trimmed
            continue
        line = js_trim(strip_trailing_comment(trimmed))
        if not line or line.startswith("#"):
            continue

        if not header_seen:
            header_seen = True
            if not HEADER.match(line):
                errors.append(
                    {"line": line_number, "content": raw_line, "message": 'Expected a "stateDiagram-v2" header.'}
                )
            continue
        scope = current_scope()

        def fail(message: str, line_number: int = line_number, raw_line: str = raw_line) -> None:
            errors.append({"line": line_number, "content": raw_line, "message": message})

        if m := DIRECTION.match(line):
            value = m.group(1).upper()
            if scope:
                composites[scope[0]]["direction"] = value
            else:
                direction = value
            continue
        if not scope and (m := TITLE.match(line)):
            title = m.group(1)
            continue
        if not scope and (m := ACC_TITLE.match(line)):
            acc_title = m.group(1)
            continue
        if not scope and ACC_DESCR_BLOCK.match(line):
            open_acc_descr = []
            continue
        if not scope and (m := ACC_DESCR.match(line)):
            acc_descr = m.group(1)
            continue
        if any(pattern.match(line) for pattern in IGNORED):
            continue
        if m := CLASS_DEF.match(line):
            class_defs[m.group(1)] = {**(class_defs.get(m.group(1)) or {}), **_style_props(m.group(2))}
            continue
        if m := CLASS_ASSIGN.match(line):
            class_uses.append(([js_trim(part) for part in m.group(1).split(",")], m.group(2)))
            continue
        if m := STYLE.match(line):
            style_uses.append(([part for part in m.group(1).split(",") if part], m.group(2)))
            continue
        if CLICK_CALL.match(line):
            fail('"click <id> call ..." is not supported (it runs script); use "click <id> href \\"<url>\\"".')
            continue
        if m := CLICK_HREF.match(line) or CLICK_URL.match(line):
            node_id, href, tooltip = m.group(1), m.group(2), m.group(3)
            if not is_allowed_link_href(href):
                fail(f'Link "{href}" is not allowed: only http(s) URLs or relative paths.')
                continue
            node = ensure_node(node_id, scope)
            if node is not None:
                node["link"] = {"href": href, **({"tooltip": tooltip} if tooltip else {})}
            continue
        if m := NOTE_LINE.match(line):
            add_note(m.group(1).lower(), m.group(2), js_trim(m.group(3)), scope)
            continue
        if m := NOTE_START.match(line):
            open_note = {
                "side": m.group(1).lower(),
                "target": m.group(2),
                "text": [],
                "line": line_number,
                "content": raw_line,
            }
            continue
        if m := COMPOSITE_ALIAS_START.match(line) or COMPOSITE_START.match(line):
            label, composite_id = (m.group(1), m.group(2)) if m.re is COMPOSITE_ALIAS_START else (None, m.group(1))
            if composite_id in composites or any(open_block[0] == composite_id for open_block in stack):
                fail(f'Composite state "{composite_id}" is already defined.')
                continue
            earlier = nodes.get(composite_id)
            if earlier is not None and earlier.get("role") != "state":
                fail(f'"{composite_id}" is already a {earlier.get("role")} state.')
                continue
            nodes.pop(composite_id, None)
            prior_scope = node_scope[composite_id] if earlier is not None else _scope_key(scope)
            node_scope.pop(composite_id, None)
            meta = container_meta.get(composite_id)
            if label is None:
                description = earlier.get("description") if earlier is not None else None
                label = description if description is not None else composite_id
            composite: dict[str, Any] = {
                "id": composite_id,
                "label": label,
                "role": "composite",
                "position": _saved_position(meta, placeholder),
                **_saved_size(meta),
            }
            if earlier is not None and js_truthy(earlier.get("style")):
                composite["style"] = earlier["style"]
            elif js_truthy(styles.get(composite_id)):
                composite["style"] = styles[composite_id]
            composites[composite_id] = composite
            composite_scope[composite_id] = prior_scope
            region_count[composite_id] = 1
            stack.append([composite_id, 0, line_number, raw_line])
            continue
        if BLOCK_END.match(line):
            if not stack:
                fail('"}" with no open composite state.')
            else:
                stack.pop()
            continue
        if CONCURRENCY.match(line):
            if not scope:
                fail('"--" (concurrent regions) only belongs inside a composite state.')
                continue
            scope[1] += 1
            region_count[scope[0]] = scope[1] + 1
            continue
        if m := STEREOTYPE.match(line):
            role = PSEUDO_ROLES[(m.group(2) if m.group(2) is not None else m.group(3)).lower()]
            node = ensure_node(m.group(1), scope, role)
            if node is not None:
                node["role"] = role
                node["shape"] = ROLE_SHAPE[role]
                if node.get("label") == node.get("id"):
                    node["label"] = ""
            continue
        if m := STATE_ALIAS.match(line):
            node = ensure_node(m.group(2), scope)
            if node is not None:
                node["label"] = m.group(1)
                if m.group(3):
                    _append_description(node, js_trim(m.group(3)))
            continue
        if m := STATE_BARE.match(line):
            ensure_node(m.group(1), scope)
            continue
        if m := TRANSITION.match(line):
            source, source_class, target, target_class, label = m.groups()
            source_id = endpoint(source, "start", scope)
            target_id = endpoint(target, "end", scope)
            if source_class:
                class_uses.append(([source_id], source_class))
            if target_class:
                class_uses.append(([target_id], target_class))
            edge_counter += 1
            edge: dict[str, Any] = {
                "id": f"e{edge_counter}",
                "sourceId": source_id,
                "targetId": target_id,
                "arrow": "target",
            }
            if label is not None and js_trim(label):
                edge["label"] = js_trim(label)
            edges.append((edge, _scope_key(scope)))
            continue
        if m := STATE_REF.match(line):
            if m.group(1) == "[*]":
                fail('"[*]" on its own is not a statement.')
                continue
            ensure_node(m.group(1), scope)
            if m.group(2):
                class_uses.append(([m.group(1)], m.group(2)))
            continue
        if m := DESCRIPTION.match(line):
            existing = composites.get(m.group(1))
            if existing is not None:
                existing["label"] = js_trim(m.group(2))
                continue
            node = ensure_node(m.group(1), scope)
            if node is not None:
                _append_description(node, js_trim(m.group(2)))
            continue
        fail("Could not interpret line as a state, transition, note or composite state.")

    if open_note is not None:
        errors.append(
            {"line": open_note["line"], "content": open_note["content"], "message": 'Note has no "end note".'}
        )
    for open_block in stack:
        errors.append(
            {
                "line": open_block[2],
                "content": open_block[3],
                "message": f'Composite state "{open_block[0]}" has no closing "}}".',
            }
        )
    if not header_seen:
        errors.append({"line": 1, "content": "", "message": 'Expected a "stateDiagram-v2" header.'})
    if errors:
        return {"errors": errors}

    # Regions, and what each scope key resolves to.
    regions: list[dict[str, Any]] = []
    container_of_scope: dict[str, str | None] = {"": None}
    for composite_id, count in region_count.items():
        if count == 1:
            container_of_scope[f"{composite_id}\u00000"] = composite_id
            continue
        for k in range(count):
            region_id = f"{composite_id}__region{k + 1}"
            meta = container_meta.get(region_id)
            regions.append(
                {
                    "id": region_id,
                    "label": "",
                    "role": "region",
                    "parentContainerId": composite_id,
                    "position": _saved_position(meta, placeholder),
                    **_saved_size(meta),
                }
            )
            container_of_scope[f"{composite_id}\u0000{k}"] = region_id

    def resolve(key: str) -> str | None:
        return container_of_scope.get(key)

    renamed: dict[str, str] = {}
    for node in nodes.values():
        node_id = node["id"]
        if not node_id.startswith("\u0000"):
            continue
        second = node_id.index("\u0000", 1)
        kind, key = node_id[1:second], node_id[second + 1 :]
        resolved = resolve(key)
        renamed[node_id] = f"{resolved if resolved is not None else 'root'}_{kind}"

    final_nodes: list[dict[str, Any]] = []
    for node in nodes.values():
        node_id = renamed.get(node["id"], node["id"])
        container_id = resolve(node_scope.get(node["id"], ""))
        final = {**node, "id": node_id, "position": place(node_id) if node["id"] in renamed else node["position"]}
        if node["id"] in renamed and js_truthy(styles.get(node_id)):
            final["style"] = styles[node_id]
        if container_id:
            final["containerId"] = container_id
        final_nodes.append(final)
    by_id: dict[str, dict[str, Any]] = {}
    for node in final_nodes:
        by_id[node["id"]] = node

    def apply(element_id: str, style: dict[str, Any]) -> None:
        target = by_id.get(renamed.get(element_id, element_id)) or composites.get(element_id)
        if target is not None and not js_truthy(styles.get(target["id"])) and style:
            target["style"] = {**(target.get("style") or {}), **style}

    for ids, class_name in class_uses:
        class_style = class_defs.get(class_name)
        if class_style is not None:
            for element_id in ids:
                apply(element_id, class_style)
    for ids, props_raw in style_uses:
        for element_id in ids:
            apply(element_id, _style_props(props_raw))

    containers: list[dict[str, Any]] = []
    for composite in composites.values():
        parent = resolve(composite_scope.get(composite["id"], ""))
        containers.append({**composite, **({"parentContainerId": parent} if parent else {})})
    containers.extend(regions)
    for container, scope_key in notes:
        meta = container_meta.get(container["id"])
        parent = resolve(scope_key)
        containers.append(
            {
                **container,
                "attachedNodeIds": [
                    target_id if target_id in composites else renamed.get(target_id, target_id)
                    for target_id in container["attachedNodeIds"]
                ],
                "position": _saved_position(meta, placeholder),
                **_saved_size(meta),
                **({"parentContainerId": parent} if parent else {}),
            }
        )

    final_edges: list[dict[str, Any]] = []
    for edge, scope_key in edges:
        container_id = resolve(scope_key)
        final_edge = {
            **edge,
            "sourceId": renamed.get(edge["sourceId"], edge["sourceId"]),
            "targetId": renamed.get(edge["targetId"], edge["targetId"]),
        }
        if container_id:
            final_edge["containerId"] = container_id
        if js_truthy(edge_styles.get(edge["id"])):
            final_edge["style"] = edge_styles[edge["id"]]
        final_edges.append(final_edge)

    if is_fresh_import:
        node_positions, container_positions, container_sizes = compute_containment_layout(final_nodes, containers)
        for node in final_nodes:
            node["position"] = node_positions.get(node["id"], node["position"])
        for container in containers:
            container["position"] = container_positions.get(container["id"], container["position"])
            size = container_sizes.get(container["id"])
            if size:
                container["size"] = size

    model = create_empty_diagram_model("state")
    model.update(
        {
            "nodes": final_nodes,
            "containers": containers,
            "edges": final_edges,
            "direction": direction,
            "title": title,
            "accTitle": acc_title,
            "accDescr": acc_descr,
            "mermaidConfigDirective": config_directive,
            "legend": read_legend(front_matter),
        }
    )
    if pinned := read_pinned(front_matter, model):
        model["pinned"] = pinned
    apply_links(front_matter, model)
    apply_frames(front_matter, model)
    return {"model": model}


# --- serializing -----------------------------------------------------------------------------------

PSEUDO_ROLE_KEYWORD = {"choice": "choice", "fork": "fork", "join": "join"}
#: canvas-bnnh part 2: a node drawn in the editor or by the AI may have only a shape; its role follows from it.
SHAPE_ROLE = {"state-start": "start", "state-end": "end", "fork-bar": "fork", "diamond": "choice"}
NOTE_ROLES = ("note-left", "note-right")


def _role_of(node: dict[str, Any]) -> str:
    role = node.get("role")
    if role is not None:
        return str(role)
    shape = node.get("shape")
    return SHAPE_ROLE[shape] if isinstance(shape, str) and shape in SHAPE_ROLE else "state"


def _is_composite(container: dict[str, Any]) -> bool:
    """Any group that isn't a region or a note (a group drawn in the editor has no role)."""
    role = container.get("role")
    return role != "region" and role not in NOTE_ROLES


def _quotable(text: str) -> bool:
    """Text that fits `state "..." as id` (no quote) and stays on one line."""
    return '"' not in text and not _HAS_LINE_BREAK.search(text)


def _entries(pairs: list[tuple[Any, Any]]) -> dict[str, Any]:
    """Object.fromEntries: a later duplicate key replaces the value but keeps the first position."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        out[key] = value
    return out


def _direction_word(direction: str) -> str:
    return "TB" if direction == "TD" else direction


def serialize_state(model: dict[str, Any]) -> str:
    """The model as Mermaid text, in the order reading it back gives (canvas-ra0g: see read_order)."""
    return _write_state(in_read_order(model, parse_state, _write_state))


def _write_state(model: dict[str, Any]) -> str:
    nodes: list[dict[str, Any]] = model.get("nodes") or []
    edges: list[dict[str, Any]] = model.get("edges") or []
    containers: list[dict[str, Any]] = model.get("containers") or []

    def is_pseudo(node: dict[str, Any]) -> bool:
        return _role_of(node) in ("start", "end")

    lines: list[str] = []
    if model.get("mermaidConfigDirective"):
        lines.append(model["mermaidConfigDirective"])
    lines.append("stateDiagram-v2")
    if model.get("accTitle"):
        lines.append(f"  accTitle: {model['accTitle']}")
    acc_descr = model.get("accDescr")
    if acc_descr and _HAS_LINE_BREAK.search(acc_descr):
        lines.append("  accDescr {")
        lines.extend(f"    {js_trim(part)}" for part in _LINE_SPLIT.split(acc_descr))
        lines.append("  }")
    elif acc_descr:
        lines.append(f"  accDescr: {acc_descr}")
    if model.get("direction"):
        lines.append(f"  direction {_direction_word(model['direction'])}")

    node_by_id: dict[str, dict[str, Any]] = {}
    for node in nodes:
        node_by_id[node["id"]] = node
    container_ids = {c["id"] for c in containers}

    def ref(element_id: str) -> str:
        node = node_by_id.get(element_id)
        return "[*]" if node is not None and is_pseudo(node) else element_id

    def scope_of(value: Any) -> Any:
        return value if value and value in container_ids else None

    def in_scope(items: list[dict[str, Any]], scope: str | None) -> list[dict[str, Any]]:
        return [item for item in items if scope_of(item.get("containerId")) == scope]

    def child_containers(scope: str | None) -> list[dict[str, Any]]:
        return [c for c in containers if scope_of(c.get("parentContainerId")) == scope]

    containers_by_id: dict[str, dict[str, Any]] = {}
    for container in containers:
        containers_by_id.setdefault(container["id"], container)

    def container_of_element(element_id: Any) -> Any:
        node = node_by_id.get(element_id)
        if node is not None:
            return scope_of(node.get("containerId"))
        group = containers_by_id.get(element_id)
        return scope_of(group.get("parentContainerId")) if group is not None else None

    def edge_scope(edge: dict[str, Any]) -> Any:
        """The scope a connector was read from; one drawn in the editor goes where both its ends are."""
        own = scope_of(edge.get("containerId"))
        if own is not None:
            return own
        source = container_of_element(edge.get("sourceId"))
        return source if source is not None and source == container_of_element(edge.get("targetId")) else None

    emitted_edges: list[dict[str, Any]] = []
    emitted_notes: list[dict[str, Any]] = []
    mentioned = {endpoint for edge in edges for endpoint in (edge.get("sourceId"), edge.get("targetId"))}
    edge_index: dict[Any, int] = {}
    for i, edge in enumerate(edges):
        edge_index[edge.get("id")] = i

    def first_edge_within(container_id: str) -> int:
        inside: set[str] = set()

        def walk(element_id: str) -> None:
            inside.add(element_id)
            for child in containers:
                if child.get("parentContainerId") == element_id and child["id"] not in inside:
                    walk(child["id"])

        walk(container_id)
        first = _LAST
        for edge in edges:
            scope = edge_scope(edge)
            if scope and scope in inside:
                first = min(first, edge_index[edge.get("id")])
        return first

    def emit_composite(container: dict[str, Any], indent: str) -> None:
        label = container.get("label")
        if label and label != container["id"] and _quotable(label):
            lines.append(f'{indent}state "{label}" as {container["id"]} {{')
        else:
            lines.append(f"{indent}state {container['id']} {{")
        if container.get("direction"):
            lines.append(f"{indent}  direction {_direction_word(container['direction'])}")
        regions = [c for c in child_containers(container["id"]) if c.get("role") == "region"]
        emit_scope(container["id"], f"{indent}  ")
        for i, region in enumerate(regions):
            if i > 0:
                lines.append(f"{indent}  --")
            emit_scope(region["id"], f"{indent}  ")
        lines.append(f"{indent}}}")

    def emit_edge(edge: dict[str, Any], indent: str) -> None:
        emitted_edges.append(edge)
        label = f" : {_LINE_BREAKS.sub(' ', edge['label'])}" if edge.get("label") else ""
        lines.append(f"{indent}{ref(edge['sourceId'])} --> {ref(edge['targetId'])}{label}")

    def emit_scope(scope: str | None, indent: str) -> None:
        for node in in_scope(nodes, scope):
            if is_pseudo(node):
                continue
            keyword = PSEUDO_ROLE_KEYWORD.get(_role_of(node))
            if keyword:
                lines.append(f"{indent}state {node['id']} <<{keyword}>>")
                continue
            label = node.get("label")
            if label and label != node["id"] and _quotable(label):
                lines.append(f'{indent}state "{label}" as {node["id"]}')
            elif not node.get("description") and node["id"] not in mentioned:
                lines.append(f"{indent}{node['id']}")
            for text in (node.get("description") or "").split("\n"):
                if js_trim(text):
                    lines.append(f"{indent}{node['id']} : {js_trim(text)}")
        # Connectors and composite blocks in the order the connectors were read (see state.ts).
        items: list[tuple[int, int, Any]] = []
        for edge in [e for e in edges if edge_scope(e) == scope]:
            items.append((edge_index.get(edge.get("id"), _LAST), len(items), ("edge", edge)))
        for container in child_containers(scope):
            if _is_composite(container):
                items.append((first_edge_within(container["id"]), len(items), ("composite", container)))
        for _key, _order, (kind, item) in sorted(items, key=lambda entry: (entry[0], entry[1])):
            if kind == "edge":
                emit_edge(item, indent)
            else:
                emit_composite(item, indent)
        for note in child_containers(scope):
            if note.get("role") not in NOTE_ROLES:
                continue
            attached = note.get("attachedNodeIds") or []
            target = attached[0] if attached else None
            if not target:
                continue
            side = "left" if note["role"] == "note-left" else "right"
            emitted_notes.append(note)
            text = note.get("label") or ""
            if _NOTE_NEEDS_BLOCK.search(text):
                lines.append(f"{indent}note {side} of {target}")
                lines.extend(f"{indent}  {text_line}" for text_line in _LINE_SPLIT.split(text))
                lines.append(f"{indent}end note")
            else:
                lines.append(f"{indent}note {side} of {target} : {text}")
        for node in in_scope(nodes, scope):
            link = node.get("link")
            if not link or not is_allowed_link_href(link["href"]):
                continue
            if link.get("tooltip"):
                lines.append(f'{indent}click {node["id"]} "{link["href"]}" "{link["tooltip"]}"')
            else:
                lines.append(f'{indent}click {node["id"]} href "{link["href"]}"')

    emit_scope(None, "  ")

    note_ids = {note["id"]: f"note{i + 1}" for i, note in enumerate(emitted_notes)}

    def saved_id(element_id: str) -> str:
        return note_ids.get(element_id, element_id)

    def container_meta(container: dict[str, Any]) -> dict[str, Any]:
        position, size = container["position"], container.get("size")
        if size:
            return {"x": position["x"], "y": position["y"], "width": size["width"], "height": size["height"]}
        return {"x": position["x"], "y": position["y"]}

    front_matter: dict[str, Any] = {}
    if model.get("title"):
        front_matter["title"] = model["title"]
    front_matter["canvas"] = {
        "positions": _entries([(n["id"], {"x": n["position"]["x"], "y": n["position"]["y"]}) for n in nodes]),
        "containers": _entries([(saved_id(c["id"]), container_meta(c)) for c in containers]),
        "styles": _entries([(saved_id(e["id"]), e["style"]) for e in [*nodes, *containers] if e.get("style")]),
        "edgeStyles": _entries(
            [(f"e{i + 1}", edge["style"]) for i, edge in enumerate(emitted_edges) if edge.get("style")]
        ),
    }
    saved = {
        **model,
        "containers": [{**c, "id": saved_id(c["id"])} for c in containers],
        **({"pinned": [saved_id(p) for p in model["pinned"]]} if model.get("pinned") else {}),
    }
    linked = with_links(
        with_pinned(with_legend(front_matter, model), saved),
        model,
        lambda element_id, kind: saved_id(element_id) if kind == "container" else element_id,
    )
    return join_front_matter(with_frames(linked, model), "\n".join(lines) + "\n")
