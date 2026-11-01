"""canvas-1bty.4/.5: the golden corpus, run from Python through the diagram-core bridge.

Proves the bridge returns exactly what the TypeScript implementation produces, and is the runner a
Python port of each family will use later (swap the bridge for the port; the files stay the same).
Needs Node and the bridge bundle: `npm run build --workspace=@canvas/diagram-bridge`.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import BridgeError, DiagramBridge, canonical_json

REPO = Path(__file__).resolve().parents[3]
BUNDLE = REPO / "packages" / "diagram-bridge" / "dist" / "bridge.mjs"
CORPUS = REPO / "packages" / "diagram-core" / "corpus"
CASES = sorted(p.name for p in (CORPUS / "cases").iterdir() if p.is_dir())
STANDARDS = {p.stem: json.loads(p.read_text()) for p in (CORPUS / "standards").glob("*.json")}

_MISSING = shutil.which("node") is None or not BUNDLE.exists()
if _MISSING and os.environ.get("REQUIRE_BRIDGE") == "1":
    raise RuntimeError("REQUIRE_BRIDGE=1 but node or packages/diagram-bridge/dist/bridge.mjs is missing")
pytestmark = pytest.mark.skipif(_MISSING, reason="needs node and packages/diagram-bridge/dist/bridge.mjs")


@pytest.fixture(scope="module")
def bridge() -> Iterator[DiagramBridge]:
    proc = subprocess.Popen(  # noqa: S603 - fixed command, test only
        ["node", str(BUNDLE)],  # noqa: S607
        env={**os.environ, "BRIDGE_PORT": "0", "BRIDGE_HOST": "127.0.0.1"},
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    line = proc.stdout.readline()
    match = re.search(r":(\d+)$", line.strip())
    assert match, f"unexpected bridge output: {line!r}"
    with DiagramBridge(f"http://127.0.0.1:{match.group(1)}") as client:
        yield client
    proc.terminate()
    proc.wait(timeout=5)


def _expected(case: str) -> dict[str, str]:
    expected = CORPUS / "cases" / case / "expected"
    return {p.name: p.read_text(encoding="utf-8") for p in expected.iterdir()}


def _outputs(bridge: DiagramBridge, case: str) -> dict[str, str]:
    """What the TypeScript corpus test computes, computed through the bridge."""
    case_dir = CORPUS / "cases" / case
    source = (case_dir / "input.mmd").read_text(encoding="utf-8")
    meta: dict[str, Any] = json.loads((case_dir / "case.json").read_text()) if (case_dir / "case.json").exists() else {}
    family = bridge.detect(source)
    if family is None:
        return {"errors.json": canonical_json({"errors": [{"message": "Unrecognized diagram header"}]})}
    parsed = bridge.parse(family, source)
    if "model" not in parsed:
        return {"family.txt": f"{family}\n", "errors.json": canonical_json(parsed)}
    model = parsed["model"]
    files = {
        "family.txt": f"{family}\n",
        "model.json": canonical_json(model),
        "serialized.mmd": bridge.serialize(family, model),
        "portable.mmd": bridge.portable(source, strip_front_matter=True),
        "render.svg": bridge.render_svg(model) + "\n",
    }
    for standard in meta.get("standards", []):
        files[f"violations-{standard}.json"] = canonical_json(bridge.validate(model, STANDARDS[standard]))
    return files


@pytest.mark.parametrize("case", CASES)
def test_corpus_case_through_the_bridge(bridge: DiagramBridge, case: str) -> None:
    expected = _expected(case)
    actual = _outputs(bridge, case)
    assert sorted(actual) == sorted(expected)
    for name, content in actual.items():
        assert content == expected[name], f"{case}/expected/{name}"


def test_a_model_survives_the_trip_through_python_unchanged(bridge: DiagramBridge) -> None:
    """Python holds models as dicts between calls; parse -> dict -> serialize must not lose anything."""
    source = (CORPUS / "cases" / "c4-context" / "input.mmd").read_text()
    model = bridge.parse("c4", source)["model"]
    assert bridge.serialize("c4", json.loads(json.dumps(model))) == bridge.serialize("c4", model)


def test_bridge_errors_are_raised(bridge: DiagramBridge) -> None:
    with pytest.raises(BridgeError, match="unknown family"):
        bridge.parse("gantt", "gantt")


# canvas-1bty.4: the diagnostic route that proves the Python service reaches the bridge in Azure.
from tests.test_session import _user, make_session  # noqa: E402, F401 - fixture re-used


def test_the_diagnostic_route_reaches_the_bridge(
    bridge: DiagramBridge,
    settings: Any,
    engine: Any,
    make_session: Any,  # noqa: F811
) -> None:
    from fastapi.testclient import TestClient

    from canvas_api.app import create_app

    url = str(bridge._client.base_url)
    configured = settings.model_copy(update={"diagram_bridge_url": url})
    with TestClient(create_app(configured, engine)) as client:
        assert client.get("/py/diagram-core").status_code == 401
        client.cookies.set("cid", make_session(_user()))
        assert client.get("/py/diagram-core").json() == {"bridge": "ok"}


def test_the_diagnostic_route_without_a_bridge(settings: Any, engine: Any, make_session: Any) -> None:  # noqa: F811
    from fastapi.testclient import TestClient

    from canvas_api.app import create_app

    without = settings.model_copy(update={"diagram_bridge_url": None})
    with TestClient(create_app(without, engine)) as no_bridge:
        no_bridge.cookies.set("cid", make_session(_user()))
        assert no_bridge.get("/py/diagram-core").json() == {"bridge": "not configured"}
