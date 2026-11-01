"""The API contract with the TypeScript service (canvas-1bty.6): apps/api/contract/, written by
apps/api/tests/contract/openapi-snapshot.test.ts from the TypeScript routes' own schemas."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from canvas_api.catalog import BUILTIN_DIAGRAM_TYPE_IDS, DSL_FAMILIES, PERSONAS
from canvas_api.telemetry import route_template
from tests.api import CONTRACT, CONTRACT_DIR, check_contract

#: Python routes that aren't moved TypeScript routes.
OWN_ROUTES = {"GET /health", "GET /py/me", "GET /py/diagram-core"}


def test_catalog_values_match_the_typescript_service() -> None:
    constants = json.loads((CONTRACT_DIR / "constants.json").read_text(encoding="utf-8"))
    assert list(DSL_FAMILIES) == constants["dslFamilies"]
    assert list(PERSONAS) == constants["personas"]
    assert list(BUILTIN_DIAGRAM_TYPE_IDS) == constants["builtinDiagramTypeIds"]


def _python_routes(client: TestClient) -> set[str]:
    """Every route the app serves, from its own OpenAPI document (included routers are wrapped, so
    app.routes doesn't list them directly)."""
    paths: dict[str, dict[str, object]] = client.app.openapi()["paths"]  # type: ignore[attr-defined]
    return {f"{method.upper()} {path}" for path, ops in paths.items() for method in ops}


def test_python_serves_exactly_the_contracts_operations(client: TestClient) -> None:
    contract = {f"{method.upper()} {path}" for path, ops in CONTRACT["paths"].items() for method in ops}
    assert _python_routes(client) - OWN_ROUTES == contract


def test_route_names_match_the_typescript_ones(client: TestClient) -> None:
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
