"""canvas-1bty.15.3: parity fuzz for standards. Seeded random standards checked against random hand-built models
and every parsed model in the golden corpus, by the native Python validator and the TypeScript one (the bridge);
the definition check too. Results must be identical.

Needs Node and the bridge bundle (skips without, like the other bridge tests). A failure shows the seed and index.
Values TypeScript would throw on (a null where it calls a method) are not generated.
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import canonical_json
from canvas_api.diagram_core.jsvalues import to_js_json
from canvas_api.diagram_core.standards import check_standard_definition, validate
from tests.diagram_bridge import DiagramBridge

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus" / "cases"
CORPUS_MODELS = [json.loads(p.read_text("utf-8")) for p in sorted(CORPUS.glob("*/expected/model.json"))]
FAMILIES = ["flowchart", "c4", "architecture", "sequence", "erd", "uml", "gantt"]
SHAPES = [
    "rectangle",
    "rounded-rectangle",
    "circle",
    "diamond",
    "cylinder",
    "stadium",
    "person",
    "icon",
    "hexagon",
    "subroutine",
]
ROLES = ["system", "person", "container", "component", "junction", "a", "b", "c", "primary_activity", "", "free"]
KIND_IDS = ["a", "b", "c", "system", "person", "container", "end", "Bad", "x-y", "junction", "_u", "a1"]
COLORS = ["#fff", "#FFFFFF", "#1168bd", "#1168BD", "#333333", "#08427b", "red", "#abcd", "", "#999999"]
LABELS = ["A", "Thing", "  ", "", "Système", None]
CONTAINER_ROLES = ["boundary", "system-boundary", "note", "group", None, ""]
LIBRARIES = ["generic", "aws-icons", "azure-icons", "mermaid-architecture", "iconify"]


#: canvas-8uh1.5: linked diagrams, and the types validation is told for some of them.
LINK_TARGETS = ["d-container", "d-flow", "d-unknown"]
LINK_TYPES = {"d-container": "c4-container", "d-flow": "flowchart"}


def _maybe(rnd: random.Random, p: float = 0.5) -> bool:
    return rnd.random() < p


def _subset(rnd: random.Random, pool: list[Any], most: int = 3) -> list[Any]:
    return [rnd.choice(pool) for _ in range(rnd.randint(0, most))]


def _count(rnd: random.Random) -> Any:
    return rnd.choice([0, 1, 2, 3, -1, None, 1.5])


def random_rules(rnd: random.Random) -> dict[str, Any]:
    rules: dict[str, Any] = {
        "allowedShapeIds": _subset(rnd, SHAPES) if _maybe(rnd, 0.3) else [],
        "mandatoryShapeIds": _subset(rnd, SHAPES, 2) if _maybe(rnd, 0.2) else [],
        "allowedIconLibraryRefs": [
            {"libraryId": lib, "libraryVersion": "1"}
            for lib in (_subset(rnd, LIBRARIES, 2) if _maybe(rnd, 0.3) else [])
        ],
        "colorPalette": [{"role": rnd.choice(ROLES), "colorHex": rnd.choice(COLORS)} for _ in range(rnd.randint(0, 2))],
    }
    if _maybe(rnd, 0.2):
        rules["fontConstraints"] = {
            k: v
            for k, v in (
                ("family", rnd.choice(["Inter", "", None])),
                ("minSize", _count(rnd)),
                ("maxSize", _count(rnd)),
            )
            if _maybe(rnd, 0.7)
        }
    if _maybe(rnd, 0.8):
        kinds = []
        for _ in range(rnd.randint(0, 5)):
            kind: dict[str, Any] = {
                "id": rnd.choice(KIND_IDS),
                "label": rnd.choice(["Kind", "System", " ", ""]),
                "shapes": _subset(rnd, SHAPES, 2),
                "approvedFills": _subset(rnd, COLORS, 2),
            }
            if _maybe(rnd, 0.4):
                kind["approvedStrokes"] = _subset(rnd, COLORS, 2)
            if _maybe(rnd, 0.4):
                match: dict[str, Any] = {"role": rnd.choice(ROLES)}
                if _maybe(rnd):
                    match["external"] = rnd.choice([True, False, None])
                kind["match"] = match
            for key in ("minCount", "maxCount"):
                if _maybe(rnd, 0.3):
                    kind[key] = _count(rnd)
            if _maybe(rnd, 0.3):
                kind["requireConnection"] = rnd.choice([True, False])
            if _maybe(rnd, 0.3):  # canvas-8uh1.5
                kind["linkTo"] = rnd.choice(
                    [[], ["c4-container"], ["c4-container", "flowchart"], ["Bad Type"], ["x", "x"]]
                )
            kinds.append(kind)
        rules["elementKinds"] = kinds
    if _maybe(rnd, 0.4):
        rules["kindGroups"] = [
            {
                "id": rnd.choice(KIND_IDS),
                "label": rnd.choice(["Group", "", " "]),
                "kindIds": _subset(rnd, KIND_IDS, 3),
                **({"minCount": _count(rnd)} if _maybe(rnd) else {}),
                **({"maxCount": _count(rnd)} if _maybe(rnd) else {}),
            }
            for _ in range(rnd.randint(0, 3))
        ]
    if _maybe(rnd, 0.5):
        rules["connectorRules"] = []
        for i in range(rnd.randint(0, 4)):
            rule: dict[str, Any] = {
                "id": rnd.choice([f"r{i}", "r0"]),
                "label": rnd.choice(["Uses", "", "Flow"]),
                "from": rnd.choice(["*", *KIND_IDS]),
                "to": rnd.choice(["*", *KIND_IDS]),
            }
            if _maybe(rnd):
                rule["lineStyles"] = _subset(rnd, ["solid", "dotted", "thick", "invisible"], 2)
            if _maybe(rnd):
                rule["arrows"] = _subset(rnd, ["target", "source", "both", "none"], 2)
            if _maybe(rnd, 0.3):
                rule["approvedStrokes"] = _subset(rnd, COLORS, 2)
            if _maybe(rnd, 0.3):
                rule["requireLabel"] = True
            if _maybe(rnd, 0.3):
                rule["maxPerSource"] = rnd.choice([0, 1, 2])
            rules["connectorRules"].append(rule)
    if _maybe(rnd, 0.3):
        rules["connectorPolicy"] = rnd.choice(["listed-only", "any"])
    if _maybe(rnd, 0.3):
        containers: dict[str, Any] = {"allowed": rnd.choice([True, False])}
        if _maybe(rnd):
            containers["allowedRoles"] = [r for r in _subset(rnd, CONTAINER_ROLES, 2) if r is not None]
        rules["containers"] = containers
    if _maybe(rnd, 0.3):
        rules["requireKnownKinds"] = rnd.choice([True, False])
    if _maybe(rnd, 0.3):
        rules["authoring"] = {k: rnd.choice(["all", "listed", "none"]) for k in ("shapes", "icons") if _maybe(rnd, 0.7)}
    if _maybe(rnd, 0.3):
        rules["severityOverrides"] = {
            rnd.choice(["kind-fill", "unknown-kind", "allowed-shapes", "connector-style"]): rnd.choice(
                ["error", "warning", "info"]
            )
        }
    return rules


def random_model(rnd: random.Random) -> dict[str, Any]:
    nodes = []
    ids = [f"n{i}" for i in range(rnd.randint(0, 7))]
    for node_id in ids:
        node: dict[str, Any] = {
            "id": node_id,
            "label": rnd.choice(LABELS),
            "shape": rnd.choice(SHAPES),
            "position": {"x": 0, "y": 0},
        }
        if _maybe(rnd, 0.7):
            node["role"] = rnd.choice(ROLES)
        if _maybe(rnd, 0.3):
            node["external"] = rnd.choice([True, False])
        if _maybe(rnd, 0.3):
            node["tags"] = _subset(rnd, KIND_IDS, 2)
        if _maybe(rnd, 0.4):
            style: dict[str, Any] = {}
            for key, pool in (
                ("fillColor", [*COLORS, None]),
                ("strokeColor", [*COLORS, None]),
                ("fontFamily", ["Inter", "Arial", ""]),
                ("fontSize", [8, 12, 24, None]),
            ):
                if _maybe(rnd):
                    style[key] = rnd.choice(pool)
            node["style"] = style
        if _maybe(rnd, 0.2):
            node["icon"] = {"libraryId": rnd.choice(LIBRARIES), "libraryVersion": "1", "iconId": "x"}
        if _maybe(rnd, 0.3):  # canvas-8uh1.5
            node["diagramRef"] = {"diagramId": rnd.choice(LINK_TARGETS)}
        nodes.append(node)
    edges = []
    for i in range(rnd.randint(0, 8) if ids else 0):
        edge: dict[str, Any] = {
            "id": f"e{i}",
            "sourceId": rnd.choice([*ids, "ghost"]),
            "targetId": rnd.choice([*ids, "ghost"]),
        }
        if _maybe(rnd):
            edge["label"] = rnd.choice(["Uses", "", "  ", None])
        if _maybe(rnd, 0.4):
            edge["arrow"] = rnd.choice(["target", "source", "both", "none"])
        if _maybe(rnd, 0.4):
            edge["lineStyle"] = rnd.choice(["solid", "dotted", "thick", "invisible"])
        if _maybe(rnd, 0.3):
            edge["style"] = {"strokeColor": rnd.choice([c for c in COLORS if c])} if _maybe(rnd) else {}
        edges.append(edge)
    containers = []
    for i in range(rnd.randint(0, 3)):
        container: dict[str, Any] = {"id": f"c{i}", "label": rnd.choice(LABELS), "position": {"x": 0, "y": 0}}
        role = rnd.choice(CONTAINER_ROLES)
        if role is not None:
            container["role"] = role
        containers.append(container)
    model: dict[str, Any] = {"nodes": nodes, "edges": edges, "containers": containers}
    if _maybe(rnd, 0.9):
        model["diagramTypeId"] = rnd.choice(["flowchart", "c4-context", "c4-container", "architecture", "erd"])
    return model


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _same(mine: Any, theirs: Any) -> bool:
    return canonical_json(to_js_json(mine)) == canonical_json(theirs)


@pytest.mark.parametrize("seed", [3, 14, 15, 92])
def test_native_validate_matches_the_bridge(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures: list[str] = []
    for index in range(150):
        rules = random_rules(rnd)
        model = rnd.choice(CORPUS_MODELS) if _maybe(rnd, 0.4) else random_model(rnd)
        types = rnd.choice([None, {}, LINK_TYPES])
        if not _same(validate(model, rules, types), bridge.validate(model, rules, types)):
            failures.append(f"validate seed={seed} index={index}\nrules={json.dumps(rules)}\nmodel={json.dumps(model)}")
        family = rnd.choice(FAMILIES)
        if not _same(check_standard_definition(rules, family), bridge.check_standard(rules, family)):
            failures.append(f"check-standard seed={seed} index={index} family={family}\nrules={json.dumps(rules)}")
    assert not failures, "\n\n".join(failures[:3])


def test_every_corpus_model_against_every_corpus_standard(bridge: DiagramBridge) -> None:
    standards = [json.loads(p.read_text("utf-8")) for p in sorted((CORPUS.parent / "standards").glob("*.json"))]
    for model in CORPUS_MODELS:
        for rules in standards:
            assert _same(validate(model, rules), bridge.validate(model, rules))
