# Copyright (c) 2012-2014 Chris Pettitt. MIT licence: see LICENSE in this directory.
"""dagre 3.1.0 lib/util.ts: the helpers the layout path uses."""

from __future__ import annotations

import itertools
from collections.abc import Iterator
from typing import Any

from canvas_api.diagram_core.dagre.graph import Graph

__all__ = ["add_dummy_node", "as_non_compound_graph", "build_layer_matrix", "max_rank", "simplify"]


def add_dummy_node(graph: Graph, kind: str, attrs: dict[str, Any], name: str, ids: Iterator[int]) -> str:
    """A node named `name`, or `name` + a counter when that is taken. JavaScript's counter is global to the page, so
    the names differ from TypeScript's, but a dummy's name is only ever an identity: nothing sorts or prints it."""
    v = name
    while graph.has_node(v):
        v = f"{name}{next(ids)}"
    attrs["dummy"] = kind
    graph.set_node(v, attrs)
    return v


def new_ids() -> Iterator[int]:
    return itertools.count(1)


def simplify(graph: Graph) -> Graph:
    """A non-multigraph copy: parallel edges merged (weights summed, the longest minlen kept). Node labels shared."""
    simplified = Graph()
    simplified.label = graph.label
    for v in graph.nodes():
        simplified.set_node(v, graph.node(v))
    for e in graph.edges():
        simple = simplified.edge(e.v, e.w) or {"weight": 0, "minlen": 1}
        label = graph.edge_obj(e)
        simplified.set_edge(
            e.v,
            e.w,
            {"weight": simple["weight"] + label["weight"], "minlen": max(simple["minlen"], label["minlen"])},
        )
    return simplified


def as_non_compound_graph(graph: Graph) -> Graph:
    """A copy with the same nodes and edges (labels shared). Rebuilt rather than reused because its predecessor and
    successor lists come out in edge order, which can differ from the original's after edges were removed."""
    copy = Graph(multigraph=graph.multigraph)
    copy.label = graph.label
    for v in graph.nodes():
        copy.set_node(v, graph.node(v))
    for e in graph.edges():
        copy.set_edge_obj(e, graph.edge_obj(e))
    return copy


def max_rank(graph: Graph) -> int:
    # Every node is ranked by now, and there is at least one (dagre would use Number.MIN_VALUE for an unranked
    # node, and Math.max() of nothing is -Infinity).
    return max(int(graph.node(v)["rank"]) for v in graph.nodes())


def build_layer_matrix(graph: Graph) -> list[list[str]]:
    """One list per rank, each in `order`."""
    top = max_rank(graph)
    by_rank: list[dict[int, str]] = [{} for _ in range(top + 1)]
    for v in graph.nodes():
        node = graph.node(v)
        rank = node.get("rank")
        if rank is not None:
            by_rank[rank][node["order"]] = v
    # Orders are always 0..n-1 within a rank here, so a JavaScript array never has holes.
    return [[layer[i] for i in range(len(layer))] for layer in by_rank]
