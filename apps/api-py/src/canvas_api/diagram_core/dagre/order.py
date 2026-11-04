# Copyright (c) 2012-2014 Chris Pettitt. MIT licence: see LICENSE in this directory.
"""dagre 3.1.0 lib/order/: crossing reduction. Sets `order` on every node.

What this path never meets, and so leaves out: clusters (no subgraphs to sort, no border nodes, so the constraint
graph stays empty and resolveConflicts only reverses its input), custom orders and constraints, and the previous
layout's order hints (`useDynamic: false`, canvas-p2g8.2).
"""

from __future__ import annotations

import math
from typing import Any

from canvas_api.diagram_core.dagre.graph import Graph
from canvas_api.diagram_core.dagre.util import build_layer_matrix, max_rank

__all__ = ["order"]

Entry = dict[str, Any]


def order(graph: Graph) -> None:
    top = max_rank(graph)
    down_layer_graphs = _build_layer_graphs(graph, list(range(1, top + 1)), "in")
    up_layer_graphs = _build_layer_graphs(graph, list(range(top - 1, -1, -1)), "out")

    layering = _init_order(graph)
    _assign_order(graph, layering)

    best_cc: float = math.inf
    best: list[list[str]] = layering
    i = 0
    last_best = 0
    while last_best < 4:
        _sweep_layer_graphs(down_layer_graphs if i % 2 else up_layer_graphs, i % 4 >= 2)
        layering = build_layer_matrix(graph)
        cc = _cross_count(graph, layering)
        if cc < best_cc:
            last_best = 0
            best = [list(layer) for layer in layering]
            best_cc = cc
        elif cc == best_cc:
            best = [list(layer) for layer in layering]
        i += 1
        last_best += 1

    _assign_order(graph, best)


def _build_layer_graphs(graph: Graph, ranks: list[int], relationship: str) -> list[Graph]:
    nodes_by_rank: dict[int, list[str]] = {}
    for v in graph.nodes():
        nodes_by_rank.setdefault(graph.node(v)["rank"], []).append(v)
    return [_build_layer_graph(graph, rank, relationship, nodes_by_rank.get(rank, [])) for rank in ranks]


def _build_layer_graph(graph: Graph, rank: int, relationship: str, nodes_with_rank: list[str]) -> Graph:
    """The rank's nodes (all movable: in graphlib they are the children of one root node) and their edges to the
    neighbouring rank, as u -> v with weights summed. Node labels are the main graph's own."""
    result = Graph()
    result.default_node_label = graph.node
    result.label["movable"] = nodes_with_rank
    for v in nodes_with_rank:
        result.set_node(v)
        edges = graph.in_edges(v) if relationship == "in" else graph.out_edges(v)
        for e in edges or []:
            u = e.w if e.v == v else e.v
            edge = result.edge(u, v)
            weight = edge["weight"] if edge is not None else 0
            result.set_edge(u, v, {"weight": graph.edge_obj(e)["weight"] + weight})
    return result


def _init_order(graph: Graph) -> list[list[str]]:
    """DFS from the nodes in rank order; each node takes the next place in its rank when first reached."""
    visited: set[str] = set()
    simple_nodes = graph.nodes()
    layers: list[list[str]] = [[] for _ in range(max_rank(graph) + 1)]

    def dfs(v: str) -> None:
        if v in visited:
            return
        visited.add(v)
        layers[graph.node(v)["rank"]].append(v)
        # Sorted by the previous layout's order in dagre, which is no order at all without one (a stable sort).
        for w in graph.successors(v) or []:
            dfs(w)

    for v in sorted(simple_nodes, key=lambda n: graph.node(n)["rank"]):
        dfs(v)
    return layers


def _assign_order(graph: Graph, layering: list[list[str]]) -> None:
    for layer in layering:
        for i, v in enumerate(layer):
            graph.node(v)["order"] = i


def _sweep_layer_graphs(layer_graphs: list[Graph], switch_bias: bool) -> None:
    bias_right = True
    for lg in layer_graphs:
        vs, used_bias = _sort_subgraph(lg, bias_right)
        if switch_bias and used_bias:
            bias_right = not bias_right
        for i, v in enumerate(vs):
            lg.node(v)["order"] = i


def _sort_subgraph(lg: Graph, bias_right: bool) -> tuple[list[str], bool]:
    barycenters: list[Entry] = []
    for v in lg.label["movable"]:
        in_v = lg.in_edges(v)
        if not in_v:
            barycenters.append({"v": v})
            continue
        total = 0
        weight = 0
        for e in in_v:
            edge_weight = lg.edge_obj(e)["weight"]
            total = total + edge_weight * lg.node(e.v)["order"]
            weight = weight + edge_weight
        barycenters.append({"v": v, "barycenter": total / weight, "weight": weight})

    # resolveConflicts with an empty constraint graph: every entry is a source, popped from the end.
    entries: list[Entry] = []
    for i, entry in enumerate(barycenters):
        resolved: Entry = {"vs": [entry["v"]], "i": i}
        if "barycenter" in entry:
            resolved["barycenter"] = entry["barycenter"]
            resolved["weight"] = entry["weight"]
        entries.append(resolved)
    entries.reverse()

    # Two dummies of parallel edges (an edge and the reversed copy of its opposite) with the same barycenter are
    # kept side by side; any other tie means the bias decides.
    reversed_pairs: dict[str, Entry] = {}
    used_bias = False
    i = 0
    while i < len(entries):
        j = i + 1
        while j < len(entries):
            entry_i, entry_j = entries[i], entries[j]
            if not entry_i.get("barycenter") or not entry_j.get("barycenter"):
                j += 1
                continue
            if entry_i["barycenter"] == entry_j["barycenter"]:
                name_i = entry_i["vs"][0]
                name_j = entry_j["vs"][0]
                node_i = lg.node(name_i)
                node_j = lg.node(name_j)
                if (
                    node_i.get("dummy") == "edge"
                    and node_j.get("dummy") == "edge"
                    and node_i["edgeObj"].v == node_j["edgeObj"].v
                    and node_i["edgeObj"].w == node_j["edgeObj"].w
                ):
                    if node_i["edgeLabel"].get("reversed"):
                        reversed_pairs[name_j] = entry_i
                        del entries[i]
                        i -= 1
                        break
                    reversed_pairs[name_i] = entry_j
                    del entries[j]
                    j -= 1
                else:
                    used_bias = True
            j += 1
        i += 1

    return _sort(entries, reversed_pairs, bias_right), used_bias


def _sort(entries: list[Entry], reversed_pairs: dict[str, Entry], bias_right: bool) -> list[str]:
    sortable = [entry for entry in entries if "barycenter" in entry]
    unsortable = sorted((entry for entry in entries if "barycenter" not in entry), key=lambda e: -e["i"])
    # By barycenter, ties by original index (descending when biased right). Indexes are unique, so this is a total
    # order and any stable sort gives JavaScript's result.
    sortable.sort(key=lambda e: (e["barycenter"], -e["i"] if bias_right else e["i"]))

    for key, value in reversed_pairs.items():
        key_index = next((k for k, entry in enumerate(sortable) if entry["vs"][0] == key), -1)
        sortable.insert(key_index + 1, value)

    vs: list[str] = []
    vs_index = _consume_unsortable(vs, unsortable, 0)
    for entry in sortable:
        vs_index += len(entry["vs"])
        vs.extend(entry["vs"])
        vs_index = _consume_unsortable(vs, unsortable, vs_index)
    return vs


def _consume_unsortable(vs: list[str], unsortable: list[Entry], index: int) -> int:
    while unsortable and unsortable[-1]["i"] <= index:
        vs.extend(unsortable.pop()["vs"])
        index += 1
    return index


def _cross_count(graph: Graph, layering: list[list[str]]) -> int:
    cc = 0
    for i in range(1, len(layering)):
        cc += _two_layer_cross_count(graph, layering[i - 1], layering[i])
    return cc


def _two_layer_cross_count(graph: Graph, north: list[str], south: list[str]) -> int:
    south_pos = {v: i for i, v in enumerate(south)}
    south_entries: list[tuple[int, int]] = []
    for v in north:
        out = [(south_pos[e.w], graph.edge_obj(e)["weight"]) for e in graph.out_edges(v) or []]
        south_entries.extend(sorted(out, key=lambda entry: entry[0]))

    first_index = 1
    while first_index < len(south):
        first_index <<= 1
    tree_size = 2 * first_index - 1
    first_index -= 1
    tree = [0] * tree_size

    cc = 0
    for pos, weight in south_entries:
        index = pos + first_index
        tree[index] += weight
        weight_sum = 0
        while index > 0:
            if index % 2:
                weight_sum += tree[index + 1]
            index = (index - 1) >> 1
            tree[index] += weight
        cc += weight * weight_sum
    return cc
