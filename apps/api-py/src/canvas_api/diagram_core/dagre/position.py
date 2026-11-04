# Copyright (c) 2012-2014 Chris Pettitt. MIT licence: see LICENSE in this directory.
"""dagre 3.1.0 lib/position/: y by rank, x by Brandes-Koepf (four alignments, then balanced).

Left out because this path never has them: border nodes (so no type-2 conflicts, no borderType check), edge-label
nodes (no `labelpos`), a core path, a forced `align`, and `rankalign` other than its default "center".
Floating-point operations are done in dagre's order (`sep` adds its four terms one by one), so x matches exactly.
"""

from __future__ import annotations

import math
from collections.abc import Callable

from canvas_api.diagram_core.dagre.graph import Graph, js_string_gt
from canvas_api.diagram_core.dagre.util import as_non_compound_graph, build_layer_matrix

__all__ = ["position"]

Conflicts = dict[str, dict[str, bool]]
PositionMap = dict[str, float]


def position(graph: Graph) -> None:
    graph = as_non_compound_graph(graph)
    _position_y(graph)
    for v, x in _position_x(graph).items():
        graph.node(v)["x"] = x


def _position_y(graph: Graph) -> None:
    rank_sep: float = graph.label["ranksep"]
    prev_y: float = 0
    for layer in build_layer_matrix(graph):
        max_height: float = 0
        for v in layer:
            height = graph.node(v).get("height")
            height = 0 if height is None else height
            max_height = max_height if max_height > height else height
        for v in layer:
            graph.node(v)["y"] = prev_y + max_height / 2
        prev_y += max_height + rank_sep


def _position_x(graph: Graph) -> PositionMap:
    layering = build_layer_matrix(graph)
    conflicts = _find_type1_conflicts(graph, layering)

    xss: dict[str, PositionMap] = {}
    for vert in ("u", "d"):
        adjusted = layering if vert == "u" else list(reversed(layering))
        for horiz in ("l", "r"):
            if horiz == "r":
                adjusted = [list(reversed(inner)) for inner in adjusted]

            def neighbor_fn(v: str, vert: str = vert) -> list[str]:
                return (graph.predecessors(v) if vert == "u" else graph.successors(v)) or []

            root, align = _vertical_alignment(graph, adjusted, conflicts, neighbor_fn)
            xs = _horizontal_compaction(graph, adjusted, root, align, horiz == "r")
            if horiz == "r":
                xs = {v: -x for v, x in xs.items()}
            xss[vert + horiz] = xs

    smallest_width = _find_smallest_width_alignment(graph, xss)
    _align_coordinates(xss, smallest_width)
    return _balance(xss)


def _find_type1_conflicts(graph: Graph, layering: list[list[str]]) -> Conflicts:
    """Non-inner segments crossing an inner segment (one between two dummies)."""
    conflicts: Conflicts = {}

    def visit_layer(prev_layer: list[str], layer: list[str]) -> None:
        k0 = 0
        scan_pos = 0
        prev_layer_length = len(prev_layer)
        last_node = layer[-1] if layer else None
        for i, v in enumerate(layer):
            w = _find_other_inner_segment_node(graph, v)
            k1 = graph.node(w)["order"] if w else prev_layer_length
            if w or v == last_node:
                for scan_node in layer[scan_pos : i + 1]:
                    for u in graph.predecessors(scan_node) or []:
                        u_label = graph.node(u)
                        u_pos = u_label["order"]
                        if (u_pos < k0 or k1 < u_pos) and not (
                            u_label.get("dummy") and graph.node(scan_node).get("dummy")
                        ):
                            _add_conflict(conflicts, u, scan_node)
                scan_pos = i + 1
                k0 = k1

    # layering.reduce(visitLayer): each layer against the one before it.
    for i in range(1, len(layering)):
        visit_layer(layering[i - 1], layering[i])
    return conflicts


def _find_other_inner_segment_node(graph: Graph, v: str) -> str | None:
    if graph.node(v).get("dummy"):
        return next((u for u in graph.predecessors(v) or [] if graph.node(u).get("dummy")), None)
    return None


def _add_conflict(conflicts: Conflicts, v: str, w: str) -> None:
    if js_string_gt(v, w):
        v, w = w, v
    conflicts.setdefault(v, {})[w] = True


def _has_conflict(conflicts: Conflicts, v: str, w: str) -> bool:
    if js_string_gt(v, w):
        v, w = w, v
    return w in conflicts.get(v, {})


def _vertical_alignment(
    graph: Graph, layering: list[list[str]], conflicts: Conflicts, neighbor_fn: Callable[[str], list[str]]
) -> tuple[dict[str, str], dict[str, str]]:
    """Each node joins the block of one of its median neighbours where it can: (root, align)."""
    root: dict[str, str] = {}
    align: dict[str, str] = {}
    pos: dict[str, int] = {}
    for layer in layering:
        for order, v in enumerate(layer):
            root[v] = v
            align[v] = v
            pos[v] = order

    for layer in layering:
        prev_idx = -1
        for v in layer:
            ws = neighbor_fn(v)
            if not ws:
                continue
            ws = sorted(ws, key=lambda a: pos.get(a, 0))
            mp = (len(ws) - 1) / 2
            for i in range(math.floor(mp), math.ceil(mp) + 1):
                w = ws[i]
                pos_w = pos.get(w)
                if pos_w is not None and align[v] == v and prev_idx < pos_w and not _has_conflict(conflicts, v, w):
                    root_w = root.get(w)
                    if root_w is not None:
                        align[w] = v
                        root[v] = root_w
                        align[v] = root_w
                        prev_idx = pos_w
    return root, align


def _horizontal_compaction(
    graph: Graph, layering: list[list[str]], root: dict[str, str], align: dict[str, str], reverse_sep: bool
) -> PositionMap:
    xs: PositionMap = {}
    block_g = _build_block_graph(graph, layering, root, reverse_sep)

    def iterate(set_xs: Callable[[str], None], next_nodes: Callable[[str], list[str]]) -> None:
        stack = block_g.nodes()
        visited: set[str] = set()
        elem = stack.pop() if stack else None
        while elem:
            if elem in visited:
                set_xs(elem)
            else:
                visited.add(elem)
                stack.append(elem)
                stack.extend(next_nodes(elem))
            elem = stack.pop() if stack else None

    def pass1(elem: str) -> None:
        # The smallest coordinates.
        acc: float = 0
        for e in block_g.in_edges(elem) or []:
            xs_v = xs.get(e.v)
            weight = block_g.edge_obj(e)
            acc = max(acc, (0 if xs_v is None else xs_v) + (0 if weight is None else weight))
        xs[elem] = acc

    def pass2(elem: str) -> None:
        # The greatest coordinates, without breaking separation.
        smallest: float = math.inf
        for e in block_g.out_edges(elem) or []:
            xs_w = xs.get(e.w)
            weight = block_g.edge_obj(e)
            smallest = min(smallest, (0 if xs_w is None else xs_w) - (0 if weight is None else weight))
        if smallest != math.inf:
            current = xs.get(elem)
            xs[elem] = max(0 if current is None else current, smallest)

    iterate(pass1, lambda elem: block_g.predecessors(elem) or [])
    iterate(pass2, lambda elem: block_g.successors(elem) or [])

    for v in align:
        root_v = root.get(v)
        if root_v is not None:
            xs[v] = xs.get(root_v, 0)
    return xs


def _build_block_graph(graph: Graph, layering: list[list[str]], root: dict[str, str], reverse_sep: bool) -> Graph:
    block_graph = Graph()
    node_sep: float = graph.label["nodesep"]
    edge_sep: float = graph.label["edgesep"]
    for layer in layering:
        u: str | None = None
        for v in layer:
            v_root = root.get(v)
            if v_root is None:
                continue
            block_graph.set_node(v_root)
            if u is not None:
                u_root = root.get(u)
                if u_root is not None:
                    prev_max = block_graph.edge(u_root, v_root)
                    block_graph.set_edge(u_root, v_root, max(_sep(graph, node_sep, edge_sep, v, u), prev_max or 0))
            u = v
    return block_graph


def _sep(graph: Graph, node_sep: float, edge_sep: float, v: str, w: str) -> float:
    """dagre's sep(), term by term (no node here has a `labelpos`)."""
    v_label = graph.node(v)
    w_label = graph.node(w)
    total: float = 0
    total += v_label["width"] / 2
    total += (edge_sep if v_label.get("dummy") else node_sep) / 2
    total += (edge_sep if w_label.get("dummy") else node_sep) / 2
    total += w_label["width"] / 2
    return total


def _find_smallest_width_alignment(graph: Graph, xss: dict[str, PositionMap]) -> PositionMap:
    best: tuple[float, PositionMap | None] = (math.inf, None)
    for xs in xss.values():
        hi = -math.inf
        lo = math.inf
        for v, x in xs.items():
            half_width = graph.node(v)["width"] / 2
            hi = max(x + half_width, hi)
            lo = min(x - half_width, lo)
        width = hi - lo
        if width < best[0]:
            best = (width, xs)
    if best[1] is None:  # never: there are always four alignments with finite widths
        raise ValueError("no alignment")
    return best[1]


def _align_coordinates(xss: dict[str, PositionMap], align_to: PositionMap) -> None:
    """Left alignments share the narrowest one's left edge, right alignments its right edge."""
    align_to_min = min(align_to.values())
    align_to_max = max(align_to.values())
    for vert in ("u", "d"):
        for horiz in ("l", "r"):
            alignment = vert + horiz
            xs = xss.get(alignment)
            if xs is None or xs is align_to:
                continue
            delta = align_to_min - min(xs.values()) if horiz == "l" else align_to_max - max(xs.values())
            if delta:
                xss[alignment] = {v: x + delta for v, x in xs.items()}


def _balance(xss: dict[str, PositionMap]) -> PositionMap:
    """The mean of the two median candidates of the four alignments."""
    ul = xss.get("ul")
    if ul is None:
        return {}
    out: PositionMap = {}
    for v in ul:
        xs = sorted(alignment.get(v, 0) for alignment in xss.values())
        out[v] = (xs[1] + xs[2]) / 2
    return out
