"""The model in the order reading its written text back gives (packages/diagram-core/src/dsl/read-order.ts).

canvas-ra0g: a writer groups elements (a boundary's shapes inside its block, a state's declaration before the
transitions), so the text's order isn't the model's and the front matter came out reordered on the next save. Each
serializer writes once, reads that back and writes the model in that order: the first save is already stable.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

__all__ = ["in_read_order"]


def in_read_order(
    model: dict[str, Any],
    parse: Callable[[str], dict[str, Any]],
    write: Callable[[dict[str, Any]], str],
) -> dict[str, Any]:
    read = parse(write(model))
    if "model" not in read:
        return model
    return {
        **model,
        "nodes": _by_order(model["nodes"], read["model"]["nodes"]),
        "containers": _by_order(model["containers"], read["model"]["containers"]),
    }


def _by_order(items: list[dict[str, Any]], order: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`items` sorted by where their id first comes in `order`; ids it lacks go last, in their own order."""
    rank: dict[str, int] = {}
    for i, element in enumerate(order):
        rank.setdefault(element["id"], i)
    keyed = [(rank.get(item["id"], len(order) + i), i, item) for i, item in enumerate(items)]
    return [item for _, _, item in sorted(keyed, key=lambda k: (k[0], k[1]))]
