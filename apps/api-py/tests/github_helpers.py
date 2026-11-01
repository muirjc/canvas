"""Shared setup for the GitHub approval tests (canvas-1bty.11): the app wired to a FakeGitHub, the five users
the TypeScript suites sign in as, and calls as each of them.

The TypeScript suites log in through /auth/local/login; here a session row is seeded (Api.user), which is the
same cookie the app reads.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from canvas_api.github.validator_bundle import reset_cache
from tests.api import Api, User, check_contract
from tests.fake_github import FakeGitHub, FakeRepo

FRONT_MATTER = "---\ncanvas:\n  positions:\n    A:\n      x: 40\n      y: 40\n    B:\n      x: 240\n      y: 40\n---\n"
DSL = f"{FRONT_MATTER}flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n"
DSL_V2 = f"{FRONT_MATTER}flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n  B --> C[Invoice]:::step\n"
ONE_STEP_DSL = "---\ncanvas:\n  positions:\n    A:\n      x: 40\n      y: 40\n---\nflowchart TD\n  A[Only one]:::step\n"
STANDARD: dict[str, Any] = {
    "name": "Order process rules",
    "description": "Steps for order flows.",
    "requireKnownKinds": True,
    "elementKinds": [{"id": "step", "label": "Step", "shapes": ["rectangle"], "approvedFills": [], "minCount": 2}],
    "severityOverrides": {"kind-min-count": "error"},
}
VALIDATOR_PATH = ".canvas/validator.mjs"
MISSING_PROJECT = "00000000-0000-4000-8000-000000000000"

#: name -> (display name, role)
USERS = {
    "admin": ("Adam Admin", "admin"),
    "owner": ("Olivia <Owner>", "architect"),
    "viewer": ("Vera Viewer", "architect"),
    "commenter": ("Cody Commenter", "architect"),
    "editor": ("Edie Editor", "architect"),
    "stranger": ("Sam Stranger", "architect"),
}


def id8(diagram_id: str) -> str:
    return diagram_id.replace("-", "")[:8]


class GH:
    """One test's world: a clean database, the app, a fake GitHub with an `acme` installation, and users."""

    def __init__(
        self, api: Api, app: FastAPI, fake: FakeGitHub, engine: Engine, validator_root: Path, bridge_url: str
    ) -> None:
        self.api = api
        self.app = app
        self.fake = fake
        self.engine = engine
        self.validator_root = validator_root
        self.bridge_url = bridge_url
        self._scratch = 0
        self.users: dict[str, User] = {}
        installation = fake.add_installation(account="acme")
        self.installation_id = installation.id
        self.repo: FakeRepo = fake.add_repo(installation.id, name="architecture")
        self.other_repo: FakeRepo = fake.add_repo(installation.id, name="other")
        for who, (name, role) in USERS.items():
            self.users[who] = api.user(f"{who}@example.com", role, name)
        self.project_id = api.project(self.users["owner"], "Orders")
        api.diagram_type("flowchart")

    # -- requests -------------------------------------------------------------------------------------

    def call(self, method: str, url: str, who: str | None = "owner", json: Any = None) -> httpx.Response:
        return self.api.call(method, url, self.users[who] if who else None, json=json)

    def parallel(self, method: str, url: str, who: str, count: int) -> list[httpx.Response]:
        """`count` identical requests at once (each its own thread), every answer checked against the contract."""
        client: TestClient = self.api.client
        client.cookies.clear()
        headers = {"cookie": f"cid={self.users[who].cookie}"}
        with ThreadPoolExecutor(count) as pool:
            responses = list(pool.map(lambda _: client.request(method, url, headers=headers), range(count)))
        for response in responses:
            check_contract(response)
        return responses

    # -- seeding through the API ----------------------------------------------------------------------

    def create_diagram(
        self, name: str = "Order Flow", dsl: str | None = DSL, project_id: str | None = None, who: str = "owner"
    ) -> str:
        payload: dict[str, Any] = {"name": name, "diagramTypeId": "flowchart"}
        if dsl is not None:
            payload["initialDslContent"] = dsl
        res = self.call("POST", f"/projects/{project_id or self.project_id}/diagrams", who, json=payload)
        assert res.status_code == 201, res.text
        return str(res.json()["diagram"]["id"])

    def save(self, diagram_id: str, dsl: str) -> None:
        res = self.api.save_diagram(self.users["owner"], diagram_id, dsl)
        assert res.status_code == 200, res.text

    def saved(self, diagram_id: str) -> str:
        return str(self.call("GET", f"/diagrams/{diagram_id}").json()["diagram"]["dslContent"])

    def submit(self, diagram_id: str, who: str | None = "owner") -> httpx.Response:
        return self.call("POST", f"/diagrams/{diagram_id}/submissions", who)

    def status(self, diagram_id: str, who: str = "owner") -> dict[str, Any]:
        body: dict[str, Any] = self.call("GET", f"/diagrams/{diagram_id}/submission", who).json()
        return body

    def refresh(self, diagram_id: str, who: str = "owner") -> httpx.Response:
        return self.call("POST", f"/diagrams/{diagram_id}/submission/refresh", who)

    def current(self, diagram_id: str, who: str = "owner") -> dict[str, Any]:
        body: dict[str, Any] = self.refresh(diagram_id, who).json()
        return body

    def withdraw(self, diagram_id: str, who: str = "owner") -> httpx.Response:
        return self.call("POST", f"/diagrams/{diagram_id}/submission/withdraw", who)

    def link_project(
        self, folder: str = "architecture", target: FakeRepo | None = None, project_id: str | None = None
    ) -> None:
        res = self.link(project_id or self.project_id, {"repoId": (target or self.repo).id, "folder": folder})
        assert res.status_code == 200, res.text

    def link(self, project_id: str, payload: dict[str, Any], who: str = "admin") -> httpx.Response:
        return self.call("PUT", f"/projects/{project_id}/github-link", who, json=payload)

    def publish_standard(self, body: dict[str, Any] | None = None) -> None:
        created = self.call("POST", "/diagram-types/flowchart/standards", "admin", json=body or STANDARD)
        assert created.status_code == 201, created.text
        published = self.call("POST", f"/standards/{created.json()['standard']['id']}/publish", "admin")
        assert published.status_code == 200, published.text

    def submitted(self, name: str = "Order Flow") -> tuple[str, str, int]:
        """A diagram submitted once (PR #n on `repo`): (diagram id, branch, PR number)."""
        diagram_id = self.create_diagram(name)
        res = self.submit(diagram_id)
        assert res.status_code == 201, res.text
        submission = res.json()["submission"]
        return diagram_id, submission["branch"], submission["prNumber"]

    # -- the database ---------------------------------------------------------------------------------

    def rows(self, sql: str, **params: Any) -> list[Any]:
        from sqlalchemy import text

        with self.engine.connect() as conn:
            return list(conn.execute(text(sql), params))

    def submission_rows(self, diagram_id: str) -> list[Any]:
        return self.rows(
            "SELECT * FROM diagram_submissions WHERE diagram_id = :id ORDER BY first_submitted_at, pr_number",
            id=diagram_id,
        )

    def events(self, event: str) -> list[Any]:
        return self.rows("SELECT event, actor_user_id, detail FROM audit_events WHERE event = :e", e=event)

    # -- the validator bundle -------------------------------------------------------------------------

    def use_validator(self, content: str | None, workflow: str | None = None) -> Path:
        """Points the app at a fresh validator directory holding these files (None = absent)."""
        self._scratch += 1
        directory = self.validator_root / f"validator-{self._scratch}"
        directory.mkdir()
        if content is not None:
            (directory / "validator.mjs").write_text(content, encoding="utf-8")
        if workflow is not None:
            (directory / "canvas-diagrams.yml").write_text(workflow, encoding="utf-8")
        self.app.state.settings.canvas_validator_dir = str(directory)
        reset_cache()
        return directory
