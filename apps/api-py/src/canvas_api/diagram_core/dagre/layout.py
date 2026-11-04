# Copyright (c) 2012-2014 Chris Pettitt. MIT licence: see LICENSE in this directory.
"""dagre 3.1.0 lib/layout.ts: `layout(g, { useDynamic: false })` for what Auto Layout gives it -- a plain directed
graph (no clusters, no self-loops, no edge labels) with graph options rankdir/nodesep/ranksep/marginx/marginy and
nodes {width, height}. Writes x/y onto the input graph's node labels.

The runLayout steps kept are the ones that change numbers here. Left out as no-ops for this input:
makeSpaceForEdgeLabels' edge widths (only edge-label nodes would use them), removeSelfEdges/insertSelfEdges/
positionSelfEdges (no self-loops), injectEdgeLabelProxies/removeEdgeLabelProxies (no labelled edges),
removeEmptyRanks (nodeRankFactor is 1 without clusters), assignRankMinMax, parentDummyChains, addBorderSegments,
removeBorderNodes (no clusters), fixupEdgeLabelCoords, and everything after translateGraph (edge points only).
The cluster pass of recursiveClusterLayout never runs (no node has children).
"""

from __future__ import annotations

import math
import sys
from typing import Any

from canvas_api.diagram_core.dagre.graph import Graph
from canvas_api.diagram_core.dagre.order import order
from canvas_api.diagram_core.dagre.position import position
from canvas_api.diagram_core.dagre.rank import acyclic, network_simplex
from canvas_api.diagram_core.dagre.util import add_dummy_node, as_non_compound_graph, new_ids

__all__ = ["layout"]

GRAPH_NUM_ATTRS = ("nodesep", "edgesep", "ranksep", "marginx", "marginy")
GRAPH_DEFAULTS: dict[str, Any] = {"ranksep": 50, "edgesep": 20, "nodesep": 50, "rankdir": "TB", "rankalign": "center"}
# dagre recurses as deep as the longest path (more with dummy nodes); JavaScript's stack allows about ten thousand.
RECURSION_LIMIT = 20_000


def layout(input_graph: Graph) -> None:
    if sys.getrecursionlimit() < RECURSION_LIMIT:
        sys.setrecursionlimit(RECURSION_LIMIT)
    graph = _build_layout_graph(input_graph)
    _run_layout(graph)
    for v in input_graph.nodes():
        label = input_graph.node(v)
        if label is not None:
            laid = graph.node(v)
            label["x"] = laid["x"]
            label["y"] = laid["y"]


def _build_layout_graph(input_graph: Graph) -> Graph:
    graph = Graph(multigraph=True)
    given = {k.lower(): v for k, v in input_graph.label.items()}
    graph.label = {
        **GRAPH_DEFAULTS,
        **{k: given[k] for k in GRAPH_NUM_ATTRS if given.get(k) is not None},
        **({"rankdir": given["rankdir"]} if given.get("rankdir") is not None else {}),
    }
    for v in input_graph.nodes():
        node = {k.lower(): value for k, value in (input_graph.node(v) or {}).items()}
        graph.set_node(
            v,
            {
                "width": node["width"] if node.get("width") is not None else 0,
                "height": node["height"] if node.get("height") is not None else 0,
            },
        )
    for e in input_graph.edges():
        if e.v == e.w:
            raise ValueError("self-loops are not supported by this port of dagre")
        # dagre's edge defaults; width/height/labeloffset/labelpos only matter for labelled edges.
        graph.set_edge_obj(e, {"minlen": 1, "weight": 1})
    return graph


def _run_layout(graph: Graph) -> None:
    ids = new_ids()
    # makeSpaceForEdgeLabels: ranks are split in two (labels would sit in between).
    graph.label["ranksep"] /= 2
    for e in graph.edges():
        graph.edge_obj(e)["minlen"] *= 2

    acyclic(graph, ids)

    # nestingGraph.run without clusters: every tree depth is 1, so nodeSep is 1 (minlens unchanged) and a root
    # node joins every node with a weight-0 edge, which makes the graph connected for the ranker.
    root = add_dummy_node(graph, "root", {}, "_root", ids)
    for v in graph.nodes():
        if v != root:
            graph.set_edge(root, v, {"weight": 0, "minlen": 1})

    network_simplex(as_non_compound_graph(graph))

    # nestingGraph.cleanup
    graph.remove_node(root)

    _normalize_ranks(graph)
    _normalize(graph, ids)
    order(graph)
    _adjust_coordinate_system(graph)
    position(graph)
    # normalize.undo, as far as nodes go: the dummies go.
    for v in graph.nodes():
        if graph.node(v).get("dummy"):
            graph.remove_node(v)
    _undo_coordinate_system(graph)
    _translate_graph(graph)


def _normalize_ranks(graph: Graph) -> None:
    lowest = min(graph.node(v)["rank"] for v in graph.nodes())
    for v in graph.nodes():
        node = graph.node(v)
        if "rank" in node:
            node["rank"] -= lowest


def _normalize(graph: Graph, ids: Any) -> None:
    """normalize.run: an edge spanning several ranks becomes a chain through a dummy node on each rank between."""
    for e in graph.edges():
        v = e.v
        v_rank = graph.node(v)["rank"]
        w = e.w
        w_rank = graph.node(w)["rank"]
        edge_label = graph.edge_obj(e)
        if w_rank == v_rank + 1:
            continue
        graph.remove_edge(e)
        v_rank += 1
        while v_rank < w_rank:
            attrs = {"width": 0, "height": 0, "edgeLabel": edge_label, "edgeObj": e, "rank": v_rank}
            dummy = add_dummy_node(graph, "edge", attrs, "_d", ids)
            graph.set_edge(v, dummy, {"weight": edge_label["weight"]}, e.name)
            v = dummy
            v_rank += 1
        graph.set_edge(v, w, {"weight": edge_label["weight"]}, e.name)


def _rankdir(graph: Graph) -> str:
    rankdir = graph.label.get("rankdir")
    return rankdir.lower() if isinstance(rankdir, str) else ""


def _swap_width_height(graph: Graph) -> None:
    for v in graph.nodes():
        node = graph.node(v)
        node["width"], node["height"] = node["height"], node["width"]


def _adjust_coordinate_system(graph: Graph) -> None:
    if _rankdir(graph) in ("lr", "rl"):
        _swap_width_height(graph)


def _undo_coordinate_system(graph: Graph) -> None:
    rankdir = _rankdir(graph)
    if rankdir in ("bt", "rl"):
        for v in graph.nodes():
            node = graph.node(v)
            node["y"] = -node["y"]
    if rankdir in ("lr", "rl"):
        for v in graph.nodes():
            node = graph.node(v)
            node["x"], node["y"] = node["y"], node["x"]
        _swap_width_height(graph)


def _translate_graph(graph: Graph) -> None:
    """Moves the drawing so its top-left corner is at the margins (no edge carries a label position here)."""
    min_x = math.inf
    min_y = math.inf
    margin_x = graph.label.get("marginx") or 0
    margin_y = graph.label.get("marginy") or 0
    for v in graph.nodes():
        node = graph.node(v)
        min_x = min(min_x, node["x"] - node["width"] / 2)
        min_y = min(min_y, node["y"] - node["height"] / 2)
    min_x -= margin_x
    min_y -= margin_y
    for v in graph.nodes():
        node = graph.node(v)
        node["x"] -= min_x
        node["y"] -= min_y
