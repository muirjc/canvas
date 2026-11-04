# Copyright (c) 2012-2014 Chris Pettitt. MIT licence: see LICENSE in this directory.
"""dagre 3.1.0 lib/acyclic.ts (the default DFS feedback-arc set) and lib/rank/ (the default ranker: network simplex,
with its longest-path start and feasible tight tree), plus graphlib's pre/postorder they walk with.

Only the stateless path: Auto Layout calls dagre with `useDynamic: false` (canvas-p2g8.2), so acyclic never sees a
previous layout's graph (no `dfsDynamic`) and the greedy acyclicer is never chosen.
"""

from __future__ import annotations

import math
from collections.abc import Iterator

from canvas_api.diagram_core.dagre.graph import Edge, Graph
from canvas_api.diagram_core.dagre.util import simplify

__all__ = ["acyclic", "network_simplex"]


def acyclic(graph: Graph, ids: Iterator[int]) -> None:
    """Reverses a feedback-arc set found by DFS (sources first, then every node), so the graph becomes a DAG."""
    fas: list[Edge] = []
    stack: set[str] = set()
    visited: set[str] = set()

    def dfs(v: str) -> None:
        if v in visited:
            return
        visited.add(v)
        stack.add(v)
        for e in graph.out_edges(v) or []:
            if e.w in stack:
                fas.append(e)
            else:
                dfs(e.w)
        stack.discard(v)

    for v in graph.sources():
        dfs(v)
    for v in graph.nodes():
        dfs(v)

    for e in fas:
        label = graph.edge_obj(e)
        graph.remove_edge(e)
        label["forwardName"] = e.name
        label["reversed"] = True
        graph.set_edge(e.w, e.v, label, f"rev{next(ids)}")


# --- graphlib alg/reduce.ts --------------------------------------------------------------------------------------


def _walk(graph: Graph, vs: list[str], post: bool) -> list[str]:
    visited: set[str] = set()
    out: list[str] = []

    def navigate(v: str) -> list[str]:
        return (graph.successors(v) if graph.directed else graph.neighbors(v)) or []

    def visit(v: str) -> None:
        if v in visited:
            return
        visited.add(v)
        if not post:
            out.append(v)
        for w in navigate(v):
            visit(w)
        if post:
            out.append(v)

    for v in vs:
        if not graph.has_node(v):
            raise ValueError(f"Graph does not have node: {v}")
        visit(v)
    return out


def preorder(graph: Graph, vs: list[str]) -> list[str]:
    return _walk(graph, vs, post=False)


def postorder(graph: Graph, vs: list[str]) -> list[str]:
    return _walk(graph, vs, post=True)


# --- rank/util.ts ------------------------------------------------------------------------------------------------


def longest_path(graph: Graph) -> None:
    visited: set[str] = set()

    def dfs(v: str) -> int:
        label = graph.node(v)
        if v in visited:
            return int(label["rank"])
        visited.add(v)
        lengths = [dfs(e.w) - graph.edge_obj(e)["minlen"] for e in graph.out_edges(v) or []]
        # Math.min() of nothing is Infinity, which becomes 0.
        rank = min(lengths) if lengths else 0
        label["rank"] = rank
        return int(rank)

    for v in graph.sources():
        dfs(v)


def slack(graph: Graph, edge: Edge) -> int:
    return int(graph.node(edge.w)["rank"] - graph.node(edge.v)["rank"] - graph.edge_obj(edge)["minlen"])


# --- rank/feasible-tree.ts ---------------------------------------------------------------------------------------


def feasible_tree(graph: Graph) -> Graph:
    tree = Graph(directed=False)
    nodes = graph.nodes()
    if not nodes:
        raise ValueError("Graph must have at least one node")
    start = nodes[0]
    size = graph.node_count()
    tree.set_node(start, {})
    while _tight_tree(tree, graph) < size:
        edge = _find_min_slack_edge(tree, graph)
        if edge is None:
            break
        delta = slack(graph, edge) if tree.has_node(edge.v) else -slack(graph, edge)
        for v in tree.nodes():
            graph.node(v)["rank"] += delta
    return tree


def _tight_tree(tree: Graph, graph: Graph) -> int:
    def dfs(v: str) -> None:
        for e in graph.node_edges(v) or []:
            w = e.w if v == e.v else e.v
            if not tree.has_node(w) and not slack(graph, e):
                tree.set_node(w, {})
                tree.set_edge(v, w, {})
                dfs(w)

    for v in tree.nodes():
        dfs(v)
    return tree.node_count()


def _find_min_slack_edge(tree: Graph, graph: Graph) -> Edge | None:
    best: tuple[float, Edge | None] = (math.inf, None)
    for edge in graph.edges():
        edge_slack: float = math.inf
        if tree.has_node(edge.v) != tree.has_node(edge.w):
            edge_slack = slack(graph, edge)
        if edge_slack < best[0]:
            best = (edge_slack, edge)
    return best[1]


# --- rank/network-simplex.ts -------------------------------------------------------------------------------------


def network_simplex(graph: Graph) -> None:
    """Assigns `rank` to every node (on the labels, which the simplified copy shares with `graph`)."""
    graph = simplify(graph)
    longest_path(graph)
    tree = feasible_tree(graph)
    _init_low_lim_values(tree)
    _init_cut_values(tree, graph)
    while (e := _leave_edge(tree)) is not None:
        f = _enter_edge(tree, graph, e)
        _exchange_edges(tree, graph, e, f)


def _init_cut_values(tree: Graph, graph: Graph) -> None:
    visited = postorder(tree, tree.nodes())
    for v in visited[:-1]:
        child = tree.node(v)
        tree.edge(v, child["parent"])["cutvalue"] = _calc_cut_value(tree, graph, v)


def _calc_cut_value(tree: Graph, graph: Graph, child: str) -> int:
    parent = tree.node(child)["parent"]
    child_is_tail = True
    graph_edge = graph.edge(child, parent)
    if graph_edge is None:
        child_is_tail = False
        graph_edge = graph.edge(parent, child)
    cut_value: int = graph_edge["weight"]
    for edge in graph.node_edges(child) or []:
        is_out_edge = edge.v == child
        other = edge.w if is_out_edge else edge.v
        if other != parent:
            points_to_head = is_out_edge == child_is_tail
            other_weight: int = graph.edge_obj(edge)["weight"]
            cut_value += other_weight if points_to_head else -other_weight
            if tree.has_edge(child, other):
                other_cut_value: int = tree.edge(child, other)["cutvalue"]
                cut_value += -other_cut_value if points_to_head else other_cut_value
    return cut_value


def _init_low_lim_values(tree: Graph) -> None:
    _dfs_assign_low_lim(tree, set(), 1, tree.nodes()[0], None)


def _dfs_assign_low_lim(tree: Graph, visited: set[str], next_lim: int, v: str, parent: str | None) -> int:
    low = next_lim
    label = tree.node(v)
    visited.add(v)
    for w in tree.neighbors(v) or []:
        if w not in visited:
            next_lim = _dfs_assign_low_lim(tree, visited, next_lim, w, v)
    label["low"] = low
    label["lim"] = next_lim
    next_lim += 1
    if parent:
        label["parent"] = parent
    else:
        label.pop("parent", None)
    return next_lim


def _leave_edge(tree: Graph) -> Edge | None:
    return next((e for e in tree.edges() if tree.edge_obj(e)["cutvalue"] < 0), None)


def _enter_edge(tree: Graph, graph: Graph, edge: Edge) -> Edge:
    v, w = edge.v, edge.w
    # Make v the tail and w the head, as the graph has them.
    if not graph.has_edge(v, w):
        v, w = edge.w, edge.v
    v_label = tree.node(v)
    w_label = tree.node(w)
    tail_label = v_label
    flip = False
    # The root is in the tail of the edge: flip the head/tail test below.
    if v_label["lim"] > w_label["lim"]:
        tail_label = w_label
        flip = True
    candidates = [
        e
        for e in graph.edges()
        if flip == _is_descendant(tree.node(e.v), tail_label) and flip != _is_descendant(tree.node(e.w), tail_label)
    ]
    # reduce() with no initial value: the first candidate, replaced only by a strictly smaller slack.
    best = candidates[0]
    for e in candidates[1:]:
        if slack(graph, e) < slack(graph, best):
            best = e
    return best


def _exchange_edges(tree: Graph, graph: Graph, e: Edge, f: Edge) -> None:
    tree.remove_edge_between(e.v, e.w)
    tree.set_edge(f.v, f.w, {})
    _init_low_lim_values(tree)
    _init_cut_values(tree, graph)
    _update_ranks(tree, graph)


def _update_ranks(tree: Graph, graph: Graph) -> None:
    root = next((v for v in tree.nodes() if not tree.node(v).get("parent")), None)
    if root is None:
        return
    for v in preorder(tree, [root])[1:]:
        parent = tree.node(v)["parent"]
        edge = graph.edge(v, parent)
        flipped = False
        if edge is None:
            edge = graph.edge(parent, v)
            flipped = True
        graph.node(v)["rank"] = graph.node(parent)["rank"] + (edge["minlen"] if flipped else -edge["minlen"])


def _is_descendant(v_label: dict[str, int], root_label: dict[str, int]) -> bool:
    return root_label["low"] <= v_label["lim"] <= root_label["lim"]
