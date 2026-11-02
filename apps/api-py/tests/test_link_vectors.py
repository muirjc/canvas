"""canvas-1bty.15.1: the link check (model.py) against what Node's WHATWG URL parser says.

tests/data/link_vectors.json: each href with `new URL(href, 'https://relative-path-base.invalid/').protocol`
(null when it throws); regenerate with `node apps/api-py/tests/data/make_link_vectors.mjs`. The check is
security-relevant (a `javascript:` link must never get through), so disagreements are failures either way.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from canvas_api.diagram_core.model import is_allowed_link_href, url_protocol

VECTORS: list[dict[str, str | None]] = json.loads((Path(__file__).parent / "data" / "link_vectors.json").read_text())


def test_there_are_enough_vectors() -> None:
    assert len(VECTORS) >= 180


def test_url_protocol_agrees_with_node_on_every_vector() -> None:
    wrong = [
        (v["href"], v["protocol"], url_protocol(str(v["href"])))
        for v in VECTORS
        if url_protocol(str(v["href"])) != v["protocol"]
    ]
    assert not wrong, f"{len(wrong)} disagree (href, node, python): {wrong[:10]!r}"


def test_the_allowed_check_agrees_with_node_on_every_vector() -> None:
    wrong = [v["href"] for v in VECTORS if is_allowed_link_href(str(v["href"])) != (v["protocol"] in ("http", "https"))]
    assert not wrong, f"{wrong[:10]!r}"


@pytest.mark.parametrize(
    "href", ["javascript:alert(1)", " javascript:alert(1)", "JaVaScRiPt:x", "java\tscript:x", "\x01javascript:x"]
)
def test_script_links_are_never_allowed(href: str) -> None:
    assert not is_allowed_link_href(href)
