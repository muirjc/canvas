"""canvas-1bty.15.1: jsyaml (YAML like the `yaml` npm package) against fixed vectors.

tests/data/yaml_vectors.json holds values and the text `yaml`@2 wrote for each (regenerate with
`node apps/api-py/tests/data/make_yaml_vectors.mjs`). No Node needed to run these.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import jsyaml

VECTORS: list[dict[str, Any]] = json.loads((Path(__file__).parent / "data" / "yaml_vectors.json").read_text("utf-8"))


def test_there_are_enough_vectors() -> None:
    assert len(VECTORS) >= 500


def test_dump_matches_the_npm_package_on_every_vector() -> None:
    wrong = [v for v in VECTORS if jsyaml.dump(v["value"]) != v["yaml"]]
    assert not wrong, f"{len(wrong)} differ; first: value={wrong[0]['value']!r} want={wrong[0]['yaml']!r}"


def test_load_reads_back_every_map_rooted_document() -> None:
    maps = [v for v in VECTORS if isinstance(v["value"], dict)]
    assert len(maps) >= 400
    wrong = [v for v in maps if jsyaml.load(v["yaml"]) != v["value"]]
    assert not wrong, f"{len(wrong)} differ; first: want={wrong[0]['value']!r} yaml={wrong[0]['yaml']!r}"


def test_array_index_keys_are_written_first_in_ascending_order() -> None:
    # JS objects order integer-like keys first, ascending, whatever the insertion order.
    assert jsyaml.dump({"b": 1, "10": 2, "2": 3, "a": 4, "1": 5}) == '"1": 5\n"2": 3\n"10": 2\nb: 1\na: 4\n'


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("a: yes\nb: no\nc: on\nd: ~\ne:\n", {"a": "yes", "b": "no", "c": "on", "d": None, "e": None}),
        ("a: 012\nb: 0o17\nc: 0x1F\nd: 1e3\ne: .5\n", {"a": 12, "b": 15, "c": 31, "d": 1000, "e": 0.5}),
        ("1: x\n2: y\ntrue: z\n", {"1": "x", "2": "y", "true": "z"}),
        ("a: 'it''s'\nb: \"\\u00e9\\n\"\n", {"a": "it's", "b": "é\n"}),
        ("a: tab\tinside\n", {"a": "tab\tinside"}),
    ],
)
def test_load_follows_yaml_1_2_core_schema(text: str, expected: dict[str, Any]) -> None:
    assert jsyaml.load(text) == expected


@pytest.mark.parametrize("text", ["a: 1\na: 2\n", "a: [1\n", "a: 'unterminated\n", "a: b: c\n"])
def test_load_rejects_what_the_npm_package_rejects(text: str) -> None:
    with pytest.raises(jsyaml.YamlError):
        jsyaml.load(text)
