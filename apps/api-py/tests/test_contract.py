"""The API contract (canvas-1bty.6): apps/api-py/contract/. Written by the TypeScript API's tests from its routes'
own schemas (tag typescript-api-final); since canvas-1bty.16 frozen and edited by hand, together with the route
it describes. The web app relies on these shapes."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from canvas_api.catalog import BUILTIN_DIAGRAM_TYPE_IDS, DSL_FAMILIES, PERSONAS, RULE_IDS
from canvas_api.telemetry import route_template
from tests.api import CONTRACT, CONTRACT_DIR, check_contract

#: Routes outside the contract.
OWN_ROUTES = {"GET /health"}


def test_catalog_values_match_the_contract() -> None:
    constants = json.loads((CONTRACT_DIR / "constants.json").read_text(encoding="utf-8"))
    assert list(DSL_FAMILIES) == constants["dslFamilies"]
    assert list(PERSONAS) == constants["personas"]
    assert list(BUILTIN_DIAGRAM_TYPE_IDS) == constants["builtinDiagramTypeIds"]
    assert list(RULE_IDS) == constants["ruleIds"]


def _python_routes(client: TestClient) -> set[str]:
    """Every route the app serves, from its own OpenAPI document (included routers are wrapped, so
    app.routes doesn't list them directly)."""
    paths: dict[str, dict[str, object]] = client.app.openapi()["paths"]  # type: ignore[attr-defined]
    return {f"{method.upper()} {path}" for path, ops in paths.items() for method in ops}


def test_python_serves_exactly_the_contracts_operations(client: TestClient) -> None:
    contract = {f"{method.upper()} {path}" for path, ops in CONTRACT["paths"].items() for method in ops}
    assert _python_routes(client) - OWN_ROUTES == contract


def test_every_body_and_query_parameter_a_route_takes_is_in_the_contract(client: TestClient) -> None:
    """canvas-62y: the request side. A route that takes a JSON body has a requestBody in the contract (and one
    that takes none has none); the query parameters are the same names. What the bodies may hold is checked
    on every test request the API accepts (tests/api.py check_contract_request)."""
    doc: dict[str, Any] = client.app.openapi()  # type: ignore[attr-defined]
    contract = {
        (method.upper(), re.sub(r"\{[^}]+\}", "{}", path)): operation
        for path, ops in CONTRACT["paths"].items()
        for method, operation in ops.items()
    }
    problems = []
    for path, ops in doc["paths"].items():
        for method, operation in ops.items():
            if f"{method.upper()} {path}" in OWN_ROUTES:
                continue
            where = f"{method.upper()} {path}"
            documented = contract[(method.upper(), re.sub(r"\{[^}]+\}", "{}", path))]
            if ("requestBody" in operation) != ("requestBody" in documented):
                problems.append(f"{where}: body {'taken' if 'requestBody' in operation else 'not taken'} by the route")
            taken = sorted(p["name"] for p in operation.get("parameters", []) if p["in"] == "query")
            listed = sorted(p["name"] for p in documented.get("parameters", []) if p["in"] == "query")
            if taken != listed:
                problems.append(f"{where}: query parameters {taken}, contract {listed}")
    assert problems == []


def test_route_names_keep_the_typescript_form(client: TestClient) -> None:
    # The telemetry workbook keys on "PATCH /projects/:id"; Python's spans use the same names.
    names = {route_template(r) for r in _python_routes(client) - OWN_ROUTES}
    assert "PATCH /projects/:id" in names
    assert "GET /libraries/:id/versions/:version/icons" in names


def _response(method: str, url: str, status: int, body: object) -> httpx.Response:
    content = b"" if body is None else json.dumps(body).encode()
    return httpx.Response(status, content=content, request=httpx.Request(method, url))


GOOD_PROJECT = {"id": "p1", "name": "P", "parentProjectId": None, "createdAt": "2026-11-01T09:30:00.123Z"}


@pytest.mark.parametrize(
    ("status", "body", "problem"),
    [
        (200, {"project": {**GOOD_PROJECT, "extra": 1}}, "Additional properties"),
        (200, {"project": {k: v for k, v in GOOD_PROJECT.items() if k != "createdAt"}}, "'createdAt' is a required"),
        (200, {"project": {**GOOD_PROJECT, "createdAt": "2026-11-01 09:30:00"}}, "date-time"),
        (404, {"message": "nope"}, "'error' is a required"),
        (500, {"error": "Internal server error"}, "not in the contract"),
    ],
    ids=["extra field", "missing field", "zone-less timestamp", "wrong error shape", "undocumented status"],
)
def test_the_contract_check_rejects_a_response_out_of_shape(status: int, body: object, problem: str) -> None:
    check_contract(_response("GET", "http://test/projects/p1", 200, {"project": GOOD_PROJECT}))
    with pytest.raises(AssertionError, match=problem):
        check_contract(_response("GET", "http://test/projects/p1", status, body))


def test_the_contract_check_knows_a_204_has_no_body() -> None:
    check_contract(_response("DELETE", "http://test/projects/p1", 204, None))
    with pytest.raises(AssertionError, match="no body"):
        check_contract(_response("DELETE", "http://test/projects/p1", 204, {"ok": True}))


def _sent(method: str, url: str, request_body: object, status: int, response_body: object) -> httpx.Response:
    """A response to a request that carried `request_body` as JSON (None: no body)."""
    request = httpx.Request(method, url) if request_body is None else httpx.Request(method, url, json=request_body)
    content = b"" if response_body is None else json.dumps(response_body).encode()
    return httpx.Response(status, content=content, request=request)


RENAMED = {"project": GOOD_PROJECT}


@pytest.mark.parametrize(
    ("method", "url", "request_body", "problem"),
    [
        ("PATCH", "http://test/projects/p1", {"name": 7}, "request body breaks the contract"),
        ("PATCH", "http://test/projects/p1", None, "needs a body"),
        ("PATCH", "http://test/projects/p1?force=1", {"name": "P"}, "query parameter 'force' is not in the contract"),
        ("GET", "http://test/admin/audit?limit=500", None, "query parameter limit='500' breaks the contract"),
        ("DELETE", "http://test/projects/p1", {"why": "x"}, "sent a body the contract doesn't describe"),
    ],
    ids=["wrong type", "missing body", "unknown query parameter", "query value out of range", "body to no-body route"],
)
def test_the_contract_check_rejects_an_accepted_request_out_of_shape(
    method: str, url: str, request_body: object, problem: str
) -> None:
    status, response_body = (204, None) if method == "DELETE" else (200, RENAMED)
    if url.startswith("http://test/admin/audit"):
        response_body = {"events": [], "hasMore": False}
    with pytest.raises(AssertionError, match=re.escape(problem)):
        check_contract(_sent(method, url, request_body, status, response_body))


def test_the_contract_check_accepts_a_described_request_and_skips_rejected_ones() -> None:
    check_contract(_sent("PATCH", "http://test/projects/p1", {"name": "Renamed"}, 200, RENAMED))
    # Tests send malformed requests on purpose; only what the API accepted has to match.
    check_contract(_sent("PATCH", "http://test/projects/p1", {"name": 7}, 400, {"error": "name must be a string"}))
