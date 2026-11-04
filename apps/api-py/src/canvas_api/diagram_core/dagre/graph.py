# Copyright (c) 2012-2014 Chris Pettitt. MIT licence: see LICENSE in this directory.
"""The parts of @dagrejs/graphlib's Graph (bundled in @dagrejs/dagre 3.1.0, lib/graph.ts) that dagre's layout uses:
directed or undirected, optionally a multigraph; not compound (Auto Layout's graphs never have clusters).

Iteration order is the point of this port. graphlib keeps everything in plain JavaScript objects, which iterate in
insertion order (a deleted key re-added goes to the end) -- exactly what a Python dict does -- EXCEPT that
integer-like keys come first, in numeric order. The ids dagre sees here never look like integers (Auto Layout's are
`#`-prefixed, dagre's own dummies `_d`/`_root`...), so a dict is a faithful stand-in.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, NamedTuple

__all__ = ["Edge", "Graph", "js_string_gt"]

DEFAULT_EDGE_NAME = "\x00"
EDGE_KEY_DELIM = "\x01"


class Edge(NamedTuple):
    """graphlib's edgeObj: {v, w, name?}."""

    v: str
    w: str
    name: str | None = None


def js_string_gt(a: str, b: str) -> bool:
    """`a > b` on JavaScript strings: by UTF-16 code unit (Python compares code points, which differs only when a
    character outside the BMP meets one in U+E000-U+FFFF)."""
    if a.isascii() and b.isascii():
        return a > b
    return a.encode("utf-16-be", errors="surrogatepass") > b.encode("utf-16-be", errors="surrogatepass")


def _edge_id(directed: bool, v: str, w: str, name: str | None) -> str:
    if not directed and js_string_gt(v, w):
        v, w = w, v
    return v + EDGE_KEY_DELIM + w + EDGE_KEY_DELIM + (DEFAULT_EDGE_NAME if name is None else name)


def _edge_obj(directed: bool, v: str, w: str, name: str | None) -> Edge:
    if not directed and js_string_gt(v, w):
        v, w = w, v
    # graphlib only sets `name` when it is truthy.
    return Edge(v, w, name if name else None)


_MISSING: Any = object()


class Graph:
    def __init__(self, *, directed: bool = True, multigraph: bool = False) -> None:
        self.directed = directed
        self.multigraph = multigraph
        self.label: dict[str, Any] = {}
        self._nodes: dict[str, Any] = {}
        self._in: dict[str, dict[str, Edge]] = {}
        self._preds: dict[str, dict[str, int]] = {}
        self._out: dict[str, dict[str, Edge]] = {}
        self._sucs: dict[str, dict[str, int]] = {}
        self._edge_objs: dict[str, Edge] = {}
        self._edge_labels: dict[str, Any] = {}
        self.default_node_label: Callable[[str], Any] = lambda _v: None

    # --- nodes ---------------------------------------------------------------------------------------------------

    def nodes(self) -> list[str]:
        return list(self._nodes)

    def node_count(self) -> int:
        return len(self._nodes)

    def sources(self) -> list[str]:
        return [v for v in self._nodes if not self._in[v]]

    def set_node(self, name: str, label: Any = _MISSING) -> None:
        if name in self._nodes:
            if label is not _MISSING:
                self._nodes[name] = label
            return
        self._nodes[name] = self.default_node_label(name) if label is _MISSING else label
        self._in[name] = {}
        self._preds[name] = {}
        self._out[name] = {}
        self._sucs[name] = {}

    def node(self, name: str) -> Any:
        return self._nodes.get(name)

    def has_node(self, name: str) -> bool:
        return name in self._nodes

    def remove_node(self, name: str) -> None:
        if name not in self._nodes:
            return
        del self._nodes[name]
        for e in list(self._in[name]):
            self.remove_edge(self._edge_objs[e])
        del self._in[name]
        del self._preds[name]
        for e in list(self._out[name]):
            self.remove_edge(self._edge_objs[e])
        del self._out[name]
        del self._sucs[name]

    def predecessors(self, v: str) -> list[str] | None:
        preds = self._preds.get(v)
        return None if preds is None else list(preds)

    def successors(self, v: str) -> list[str] | None:
        sucs = self._sucs.get(v)
        return None if sucs is None else list(sucs)

    def neighbors(self, v: str) -> list[str] | None:
        preds = self._preds.get(v)
        if preds is None:
            return None
        union = dict.fromkeys(preds)
        union.update(dict.fromkeys(self._sucs[v]))
        return list(union)

    # --- edges ---------------------------------------------------------------------------------------------------

    def edges(self) -> list[Edge]:
        return list(self._edge_objs.values())

    def set_edge(self, v: str, w: str, label: Any = _MISSING, name: str | None = None) -> None:
        e = _edge_id(self.directed, v, w, name)
        if e in self._edge_labels:
            if label is not _MISSING:
                self._edge_labels[e] = label
            return
        if name is not None and not self.multigraph:
            raise ValueError("Cannot set a named edge when isMultigraph = false")
        self.set_node(v)
        self.set_node(w)
        # Auto Layout's default edge label is a fresh {}; dagre's own graphs always pass one.
        self._edge_labels[e] = {} if label is _MISSING else label
        obj = _edge_obj(self.directed, v, w, name)
        self._edge_objs[e] = obj
        preds = self._preds[obj.w]
        preds[obj.v] = preds.get(obj.v, 0) + 1
        sucs = self._sucs[obj.v]
        sucs[obj.w] = sucs.get(obj.w, 0) + 1
        self._in[obj.w][e] = obj
        self._out[obj.v][e] = obj

    def set_edge_obj(self, e: Edge, label: Any) -> None:
        self.set_edge(e.v, e.w, label, e.name)

    def edge(self, v: str, w: str, name: str | None = None) -> Any:
        return self._edge_labels.get(_edge_id(self.directed, v, w, name))

    def edge_obj(self, e: Edge) -> Any:
        return self._edge_labels.get(_edge_id(self.directed, e.v, e.w, e.name))

    def has_edge(self, v: str, w: str, name: str | None = None) -> bool:
        return _edge_id(self.directed, v, w, name) in self._edge_labels

    def remove_edge(self, e: Edge) -> None:
        self.remove_edge_between(e.v, e.w, e.name)

    def remove_edge_between(self, v: str, w: str, name: str | None = None) -> None:
        e = _edge_id(self.directed, v, w, name)
        obj = self._edge_objs.get(e)
        if obj is None:
            return
        del self._edge_labels[e]
        del self._edge_objs[e]
        _decrement(self._preds[obj.w], obj.v)
        _decrement(self._sucs[obj.v], obj.w)
        del self._in[obj.w][e]
        del self._out[obj.v][e]

    def in_edges(self, v: str) -> list[Edge] | None:
        if self.directed:
            edges = self._in.get(v)
            return None if edges is None else list(edges.values())
        return self.node_edges(v)

    def out_edges(self, v: str) -> list[Edge] | None:
        if self.directed:
            edges = self._out.get(v)
            return None if edges is None else list(edges.values())
        return self.node_edges(v)

    def node_edges(self, v: str) -> list[Edge] | None:
        if v not in self._nodes:
            return None
        # {...in, ...out}: a key in both keeps its first place.
        return list({**self._in[v], **self._out[v]}.values())


def _decrement(counts: dict[str, int], key: str) -> None:
    if key in counts:
        counts[key] -= 1
        if not counts[key]:
            del counts[key]
