"""Mermaid architecture-beta (packages/diagram-core/src/dsl/architecture.ts).

A line-by-line port, in flowchart.py's style: the same regular expressions (JavaScript's `\\s` and `.` spelled
out), tried in the same order, the same front matter (positions, containers, icons, kinds, styles, legend), and
the same fresh-import layout (architecture_layout.py). Parse returns {"model": ...} or {"errors": [...]}, never
raises (bad YAML front matter excepted, as in TypeScript).
"""

from __future__ import annotations

import re
from typing import Any

from canvas_api.diagram_core.architecture_layout import compute_architecture_layout
from canvas_api.diagram_core.front_matter import (
    apply_links,
    canvas_section,
    join_front_matter,
    read_legend,
    read_pinned,
    section,
    split_front_matter,
    strip_trailing_comment,
    with_legend,
    with_links,
    with_pinned,
)
from canvas_api.diagram_core.model import create_empty_diagram_model
from canvas_api.github.jstext import JS_WHITESPACE, js_trim

__all__ = ["MERMAID_ARCHITECTURE_ICON_IDS", "parse_architecture", "serialize_architecture"]

S = f"[{JS_WHITESPACE}]"  # JavaScript's \s
DOT = "[^\\n\\r\\u2028\\u2029]"  # JavaScript's .
ID = "[A-Za-z0-9_]+"

GROUP_PATTERN = re.compile(f"^group{S}+({ID})\\(([^)]*)\\)\\[({DOT}+)\\](?:{S}+in{S}+({ID}))?$")
TITLE_PATTERN = re.compile(f"^title{S}+({DOT}+)$")
ACC_TITLE_PATTERN = re.compile(f"^accTitle{S}*:{S}*({DOT}+)$")
ACC_DESCR_PATTERN = re.compile(f"^accDescr{S}*:{S}*({DOT}+)$")
MERMAID_CONFIG_DIRECTIVE_PATTERN = re.compile(f"^%%\\{{{DOT}*\\}}%%$")
SERVICE_PATTERN = re.compile(f"^service{S}+({ID})\\(([^)]*)\\)\\[({DOT}+?)\\](?:{S}+in{S}+({ID}))?$")
JUNCTION_PATTERN = re.compile(f"^junction{S}+({ID})(?:{S}+in{S}+({ID}))?$")
EDGE_PATTERN = re.compile(
    f"^({ID})(\\{{group\\}})?(?::([TBLR]))?{S}*(-->|<--|--){S}*(?:([TBLR]):)?({ID})(\\{{group\\}})?$"
)
ALIGN_PATTERN = re.compile(f"^align{S}+(row|column){S}+((?:{ID})(?:{S}+{ID})*)$")
# `/^([a-z0-9-]+):(.+)$/i`: JavaScript's non-unicode case folding never maps a non-ASCII letter onto an ASCII
# one, so the letters are spelled out (Python's IGNORECASE would also take the Kelvin sign, long s, dotless i).
ICONIFY_ICON_PATTERN = re.compile(f"^([A-Za-z0-9-]+):({DOT}+)$")
_LINE_SPLIT = re.compile(r"\r?\n")
_WHITESPACE_RUN = re.compile(f"{S}+")

#: libraries/mermaid-architecture-icons.ts: Mermaid's five built-in icons, and their library.
MERMAID_ARCHITECTURE_ICON_IDS = ("cloud", "database", "disk", "internet", "server")
MERMAID_ARCHITECTURE_LIBRARY_ID = "mermaid-architecture"
MERMAID_ARCHITECTURE_LIBRARY_VERSION = "1.0.0"


def _truthy(value: Any) -> bool:
    """JavaScript truthiness for front-matter values (None stands for undefined/null)."""
    if value is None or value is False:
        return False
    if isinstance(value, int | float) and not isinstance(value, bool):
        return value != 0 and value == value  # 0 and NaN are falsy
    if isinstance(value, str):
        return value != ""
    return True


def _prop(value: Any, key: str) -> Any:
    """`value.key` on whatever the front matter holds (None for anything without it)."""
    return value.get(key) if isinstance(value, dict) else None


def _builtin_icon_ref(icon_id: str) -> dict[str, Any]:
    return {
        "libraryId": MERMAID_ARCHITECTURE_LIBRARY_ID,
        "libraryVersion": MERMAID_ARCHITECTURE_LIBRARY_VERSION,
        "iconId": icon_id,
    }


def _resolve_icon_from_name(icon_name: str) -> dict[str, Any] | None:
    if not icon_name:
        return None
    iconify = ICONIFY_ICON_PATTERN.match(icon_name)
    if iconify:
        return {"libraryId": iconify.group(1), "libraryVersion": "iconify", "iconId": iconify.group(2)}
    if icon_name in MERMAID_ARCHITECTURE_ICON_IDS:
        return _builtin_icon_ref(icon_name)
    return {"libraryId": "generic", "libraryVersion": "1.0.0", "iconId": icon_name}


def _upgrade_legacy_builtin_icon(ref: Any) -> Any:
    """A diagram saved before jmuir-dtu.27 stored `generic/<built-in name>`; it becomes the bundled library's."""
    if (
        _truthy(ref)
        and _prop(ref, "libraryId") == "generic"
        and isinstance(_prop(ref, "iconId"), str)
        and ref["iconId"] in MERMAID_ARCHITECTURE_ICON_IDS
    ):
        return _builtin_icon_ref(ref["iconId"])
    return ref


def parse_architecture(dsl: str) -> dict[str, Any]:
    front_matter, body = split_front_matter(dsl)
    canvas = canvas_section(front_matter)
    positions = section(canvas, "positions")
    container_meta = section(canvas, "containers")
    icons = section(canvas, "icons")
    kinds = section(canvas, "kinds")
    styles = section(canvas, "styles")
    # `frontMatter.canvas !== undefined`: a `canvas:` key counts even when it holds null.
    saved_by_app = isinstance(front_matter, dict) and "canvas" in front_matter
    is_fresh_import = not positions and not container_meta
    auto = [0]

    def next_auto_position() -> dict[str, float]:
        k = auto[0]
        auto[0] += 1
        return {"x": (k % 5) * 180 + 40, "y": (k // 5) * 140 + 40}

    lines = _LINE_SPLIT.split(body)
    errors: list[dict[str, Any]] = []
    nodes_by_id: dict[str, dict[str, Any]] = {}
    containers_by_id: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    alignments: list[dict[str, Any]] = []
    header_seen = False
    edge_counter = 0
    title = acc_title = acc_descr = config_directive = None

    for i, raw_line in enumerate(lines):
        line = js_trim(raw_line)
        if not line:
            continue
        if MERMAID_CONFIG_DIRECTIVE_PATTERN.match(line):
            config_directive = line
            continue
        line = strip_trailing_comment(line)
        if not line:
            continue

        if not header_seen:
            if line == "architecture-beta":
                header_seen = True
                continue
            errors.append({"line": i + 1, "content": raw_line, "message": 'Expected "architecture-beta" header line'})
            continue

        if m := TITLE_PATTERN.match(line):
            title = m.group(1)
            continue
        if m := ACC_TITLE_PATTERN.match(line):
            acc_title = m.group(1)
            continue
        if m := ACC_DESCR_PATTERN.match(line):
            acc_descr = m.group(1)
            continue

        if m := GROUP_PATTERN.match(line):
            group_id, icon_name, label, parent_group_id = m.groups()
            meta = container_meta.get(group_id)
            icon_token = js_trim(icon_name)
            group_icon = _upgrade_legacy_builtin_icon(icons.get(group_id))
            if group_icon is None:
                group_icon = (
                    None if icon_token == "cloud" and saved_by_app else _resolve_icon_from_name(icon_token)  # noqa: S105
                )
            container: dict[str, Any] = {
                "id": group_id,
                "label": label,
                "position": {"x": _prop(meta, "x"), "y": _prop(meta, "y")} if _truthy(meta) else next_auto_position(),
                "size": {"width": _prop(meta, "width"), "height": _prop(meta, "height")}
                if _prop(meta, "width") is not None and _prop(meta, "height") is not None
                else None,
                "parentContainerId": parent_group_id,
            }
            if _truthy(group_icon):
                container["icon"] = group_icon
            containers_by_id[group_id] = container
            continue

        if m := SERVICE_PATTERN.match(line):
            node_id, icon_name, label, group_id = m.groups()
            icon_ref = _upgrade_legacy_builtin_icon(icons.get(node_id))
            node: dict[str, Any] = {
                "id": node_id,
                "label": label,
                "shape": "icon",
                "position": positions[node_id] if positions.get(node_id) is not None else next_auto_position(),
                "containerId": group_id,
                "icon": icon_ref if icon_ref is not None else _resolve_icon_from_name(icon_name),
            }
            if _truthy(kinds.get(node_id)):
                node["role"] = kinds[node_id]
            if _truthy(styles.get(node_id)):
                node["style"] = styles[node_id]
            nodes_by_id[node_id] = node
            continue

        if m := JUNCTION_PATTERN.match(line):
            node_id, group_id = m.groups()
            nodes_by_id[node_id] = {
                "id": node_id,
                "label": "",
                "shape": "circle",
                "role": "junction",
                "position": positions[node_id] if positions.get(node_id) is not None else next_auto_position(),
                "containerId": group_id,
            }
            continue

        if m := ALIGN_PATTERN.match(line):
            alignments.append({"axis": m.group(1), "ids": _WHITESPACE_RUN.split(m.group(2))})
            continue

        if m := EDGE_PATTERN.match(line):
            source, source_group, source_anchor, connector, target_anchor, target, target_group = m.groups()
            edge_counter += 1
            edges.append(
                {
                    "id": f"e{edge_counter}",
                    "sourceId": source,
                    "targetId": target,
                    "arrow": "target" if connector == "-->" else "source" if connector == "<--" else None,
                    "sourceAnchor": source_anchor,
                    "targetAnchor": target_anchor,
                    "sourceIsGroup": True if source_group else None,
                    "targetIsGroup": True if target_group else None,
                }
            )
            continue

        errors.append(
            {
                "line": i + 1,
                "content": raw_line,
                "message": f'Could not interpret line as a group, service, junction, align, or edge: "{line}"',
            }
        )

    if errors:
        return {"errors": errors}

    if is_fresh_import:
        all_nodes = list(nodes_by_id.values())
        all_containers = list(containers_by_id.values())
        node_positions, container_positions, container_sizes = compute_architecture_layout(
            all_nodes, all_containers, edges, alignments
        )
        for node in all_nodes:
            node["position"] = node_positions.get(node["id"], node["position"])
        for container in all_containers:
            container["position"] = container_positions.get(container["id"], container["position"])
            container["size"] = container_sizes.get(container["id"], container["size"])

    model = create_empty_diagram_model("cloud-infrastructure")
    model.update(
        {
            "nodes": list(nodes_by_id.values()),
            "containers": list(containers_by_id.values()),
            "edges": edges,
            "title": title,
            "accTitle": acc_title,
            "accDescr": acc_descr,
            "mermaidConfigDirective": config_directive,
            "legend": read_legend(front_matter),
        }
    )
    if alignments:
        model["architectureAlignments"] = alignments
    if pinned := read_pinned(front_matter, model):
        model["pinned"] = pinned
    apply_links(front_matter, model)
    return {"model": model}


# --- serializing -----------------------------------------------------------------------------------


def _js_text(value: Any) -> str:
    """A value in a template literal: `${value}` (undefined as "undefined")."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _entries(pairs: list[tuple[Any, Any]]) -> dict[str, Any]:
    """Object.fromEntries: a later duplicate key replaces the value but keeps the first position."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        out[str(key)] = value
    return out


def _key_count(value: Any) -> int:
    """`Object.keys(value).length`."""
    return len(value) if isinstance(value, dict | list | str) else 0


def _icon_token(icon: Any) -> str:
    """The `(icon)` token: iconify refs as "prefix:iconId", others the bare id."""
    if _prop(icon, "libraryVersion") == "iconify":
        return f"{_js_text(_prop(icon, 'libraryId'))}:{_js_text(_prop(icon, 'iconId'))}"
    return _js_text(_prop(icon, "iconId"))


def serialize_architecture(model: dict[str, Any]) -> str:
    nodes = model.get("nodes") or []
    containers = model.get("containers") or []
    edges = model.get("edges") or []
    canvas: dict[str, Any] = {
        "positions": _entries([(n["id"], n.get("position")) for n in nodes]),
        "containers": _entries(
            [
                (
                    c["id"],
                    {
                        "x": c["position"]["x"],
                        "y": c["position"]["y"],
                        "width": c["size"]["width"],
                        "height": c["size"]["height"],
                    },
                )
                for c in containers
                if _truthy(c.get("size"))
            ]
        ),
        "icons": _entries(
            [(n["id"], n["icon"]) for n in nodes if _truthy(n.get("icon"))]
            + [(c["id"], c["icon"]) for c in containers if _truthy(c.get("icon"))]
        ),
    }
    kinded = [n for n in nodes if _truthy(n.get("role")) and n.get("role") != "junction"]
    if kinded:
        canvas["kinds"] = _entries([(n["id"], n["role"]) for n in kinded])
    styled = [
        n for n in nodes if n.get("role") != "junction" and _truthy(n.get("style")) and _key_count(n["style"]) > 0
    ]
    if styled:
        canvas["styles"] = _entries([(n["id"], n["style"]) for n in styled])
    front_matter = {"canvas": canvas}

    lines = ["architecture-beta"]
    if model.get("title"):
        lines.append(f"title {model['title']}")
    if model.get("mermaidConfigDirective"):
        lines.insert(0, model["mermaidConfigDirective"])
    if model.get("accTitle"):
        lines.append(f"accTitle: {model['accTitle']}")
    if model.get("accDescr"):
        lines.append(f"accDescr: {model['accDescr']}")
    for group in containers:
        in_clause = f" in {group['parentContainerId']}" if group.get("parentContainerId") else ""
        icon = _icon_token(group["icon"]) if _truthy(group.get("icon")) else "cloud"
        lines.append(f"group {group['id']}({icon})[{_js_text(group.get('label'))}]{in_clause}")
    for node in nodes:
        in_clause = f" in {node['containerId']}" if node.get("containerId") else ""
        if node.get("role") == "junction":
            lines.append(f"junction {node['id']}{in_clause}")
            continue
        icon_name = _icon_token(node["icon"]) if _truthy(node.get("icon")) else "default"
        lines.append(f"service {node['id']}({icon_name})[{_js_text(node.get('label'))}]{in_clause}")
    for edge in edges:
        arrow = edge.get("arrow")
        connector = "-->" if arrow == "target" else "<--" if arrow == "source" else "--"
        source_suffix = "{group}" if edge.get("sourceIsGroup") else ""
        target_suffix = "{group}" if edge.get("targetIsGroup") else ""
        source_part = (
            f"{edge['sourceId']}{source_suffix}:{edge['sourceAnchor']}"
            if edge.get("sourceAnchor")
            else f"{edge['sourceId']}{source_suffix}"
        )
        target_part = (
            f"{edge['targetAnchor']}:{edge['targetId']}{target_suffix}"
            if edge.get("targetAnchor")
            else f"{edge['targetId']}{target_suffix}"
        )
        lines.append(f"{source_part} {connector} {target_part}")
    for alignment in model.get("architectureAlignments") or []:
        lines.append(f"align {alignment['axis']} {' '.join(alignment['ids'])}")

    return join_front_matter(
        with_links(with_pinned(with_legend(front_matter, model), model), model), "\n".join(lines) + "\n"
    )
