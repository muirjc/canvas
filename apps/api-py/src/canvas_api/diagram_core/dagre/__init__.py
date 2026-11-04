# Copyright (c) 2012-2014 Chris Pettitt. MIT licence: see LICENSE in this directory.
"""A port of the part of dagre (@dagrejs/dagre 3.1.0, with the @dagrejs/graphlib it bundles) that Auto Layout
reaches (canvas-p2g8.2): a plain directed graph laid out with `useDynamic: false`. Node x/y come out exactly as
TypeScript's do; tests/test_diagram_core_auto_layout.py replays dagre's own results."""

from canvas_api.diagram_core.dagre.graph import Edge, Graph
from canvas_api.diagram_core.dagre.layout import layout

__all__ = ["Edge", "Graph", "layout"]
