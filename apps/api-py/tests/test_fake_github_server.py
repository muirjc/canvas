"""The standalone fake GitHub (tests/fake_github_server.py) the Playwright suite runs against: started the way
CI starts it, then driven the way apps/web/tests/e2e/github-approval.spec.ts drives it -- the real app talks
to it over HTTP (no in-process transport), and the test steers it through its /_fake/ control routes.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from canvas_api.app import create_app
from canvas_api.config import Settings, parse_github_config
from canvas_api.github.sync import REFRESH_THROTTLE
from canvas_api.github.validator_bundle import reset_cache
from canvas_api.timestamps import now_utc, to_db
from tests.api import Api, User, reset
from tests.conftest import github_settings
from tests.fake_github import FakeGitHub, FakeRepo
from tests.fake_github_server import make_server, seeded

API_PY = Path(__file__).resolve().parents[1]
DSL = "flowchart TD\n  a[Alpha] --> b[Beta]\n"
DSL_EDITED = "flowchart TD\n  a[Alpha] --> b[Beta]\n  b --> c[Gamma]\n"


def test_starts_as_ci_starts_it_writes_the_key_and_stops_on_sigterm(tmp_path: Path) -> None:
    key_file = tmp_path / "fake-github.key"
    proc = subprocess.Popen(  # noqa: S603 - fixed command, test only
        [sys.executable, "-m", "tests.fake_github_server", str(key_file)],
        cwd=API_PY,
        env={**os.environ, "FAKE_GITHUB_PORT": "0"},
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        assert proc.stdout is not None
        line = proc.stdout.readline()
        match = re.fullmatch(r"fake-github ready on (http://127\.0\.0\.1:\d+) \(app id 12345, key in (.+)\)\n", line)
        assert match, line
        url = match[1]
        assert match[2] == str(key_file)
        # One line of base64 of the PEM: what the API takes as GITHUB_APP_PRIVATE_KEY.
        key = key_file.read_text()
        assert "\n" not in key
        assert parse_github_config("12345", key, url) is not None

        assert httpx.get(f"{url}/_fake/pulls").json() == {"pulls": []}
        files = httpx.get(f"{url}/_fake/files").json()["files"]
        assert files == {"README.md": "# repo\n"}
        missing = httpx.get(f"{url}/_fake/files?branch=nope")
        assert (missing.status_code, missing.json()) == (400, {"message": "no such branch"})
        unknown = httpx.post(f"{url}/_fake/whatever", json={})
        assert unknown.status_code == 400
        assert unknown.json() == {"message": "no control route for POST /_fake/whatever"}
        assert httpx.post(f"{url}/_fake/pulls/1/close").status_code == 400  # no such pull request
        # GitHub's own API is as strict as the in-process fake: no credentials, no answer.
        assert httpx.get(f"{url}/app/installations").status_code == 401

        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=10) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


@dataclass
class Served:
    api: Api
    fake: FakeGitHub
    repo: FakeRepo
    url: str
    admin: User

    def fake_get(self, path: str) -> Any:
        res = httpx.get(f"{self.url}{path}")
        assert res.status_code == 200, res.text
        return res.json()

    def fake_post(self, path: str, body: Any = None) -> None:
        res = httpx.post(f"{self.url}{path}", json=body or {})
        assert res.status_code == 200, res.text

    def call(self, method: str, url: str, json: Any = None) -> httpx.Response:
        return self.api.call(method, url, self.admin, json=json)

    def refresh(self, diagram_id: str) -> dict[str, Any]:
        """Refresh past the 30s throttle (the spec clicks Refresh until it isn't throttled any more)."""
        self.api.execute(
            "UPDATE diagram_submissions SET last_synced_at = :t WHERE diagram_id = :id",
            t=to_db(now_utc() - REFRESH_THROTTLE - timedelta(seconds=5), self.api.dialect),
            id=diagram_id,
        )
        res = self.call("POST", f"/diagrams/{diagram_id}/submission/refresh")
        assert res.status_code == 200, res.text
        body: dict[str, Any] = res.json()
        return body


@pytest.fixture()
def served(settings: Settings, github_engine: Engine, tmp_path: Path) -> Iterator[Served]:
    fake, repo = seeded()
    server = make_server(fake, repo, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    empty = tmp_path / "validator-none"
    empty.mkdir()
    reset(github_engine)
    reset_cache()
    # No github_transport: the app's GitHub client goes over HTTP to the server, as in the e2e run.
    app = create_app(github_settings(settings, fake, empty), github_engine)
    try:
        with TestClient(app) as client:
            api = Api(client, github_engine)
            api.diagram_type("flowchart")
            yield Served(api, fake, repo, fake.url, api.user("admin@example.com", "admin"))
    finally:
        reset_cache()
        server.shutdown()
        server.server_close()


def test_the_approval_flow_the_e2e_spec_runs(served: Served) -> None:
    s = served
    status = s.call("GET", "/admin/github/status").json()
    assert status["enabled"] is True
    assert status["apiUrl"] == s.url
    assert [i["account"] for i in status["installations"]] == ["canvas-e2e"]

    # An admin links a project to the repository folder; the link test passes.
    project = s.call("POST", "/projects", json={"name": "GitHub approval"}).json()["project"]["id"]
    repos = s.call("GET", "/admin/github/repositories").json()["repositories"]
    repo = next(r for r in repos if r["fullName"] == "canvas-e2e/architecture")
    assert repo["private"] is True
    linked = s.call("PUT", f"/projects/{project}/github-link", json={"repoId": repo["id"], "folder": "e2e-1"})
    assert linked.status_code == 200, linked.text
    checked = s.call("POST", f"/admin/github/links/{project}/test").json()
    assert checked["ok"] is True, checked

    # Submit -> a pull request on the fake, with the files on its branch.
    created = s.call(
        "POST", f"/projects/{project}/diagrams", json={"name": "Approval flow", "diagramTypeId": "flowchart"}
    )
    diagram_id = created.json()["diagram"]["id"]
    assert s.api.save_diagram(s.admin, diagram_id, DSL).status_code == 200
    submitted = s.call("POST", f"/diagrams/{diagram_id}/submissions")
    assert submitted.status_code == 201, submitted.text
    number = submitted.json()["submission"]["prNumber"]
    pulls = s.fake_get("/_fake/pulls")["pulls"]
    assert [(p["number"], p["state"], p["merged"]) for p in pulls] == [(number, "open", False)]
    head = pulls[0]["head"]
    files = s.fake_get(f"/_fake/files?branch={head}")["files"]
    source = next(p for p in files if p.startswith("e2e-1/") and p.endswith(".canvas.mmd"))
    assert any(p.startswith("e2e-1/") and p.endswith("/README.md") for p in files)
    assert "Alpha" in files[source]
    assert "Gamma" not in files[source]

    # Edit + save + push the update -> the same pull request, a new commit.
    assert s.api.save_diagram(s.admin, diagram_id, DSL_EDITED).status_code == 200
    updated = s.call("POST", f"/diagrams/{diagram_id}/submissions")
    assert updated.status_code in (200, 201), updated.text
    assert updated.json()["submission"]["prNumber"] == number
    assert [p["number"] for p in s.fake_get("/_fake/pulls")["pulls"] if p["state"] == "open"] == [number]
    assert "Gamma" in s.fake_get(f"/_fake/files?branch={head}")["files"][source]

    # A review and a passing check on GitHub show up after a refresh.
    s.fake_post(f"/_fake/pulls/{number}/reviews", {"login": "reviewer-one", "state": "APPROVED"})
    s.fake_post(f"/_fake/pulls/{number}/check-runs", {"name": "validate-diagram", "conclusion": "success"})
    s.fake_post(f"/_fake/pulls/{number}/check-runs", {"name": "validate-diagram", "conclusion": "failure"})
    s.fake_post(f"/_fake/pulls/{number}/check-runs", {"name": "validate-diagram"})  # replaces it again
    assert s.fake_get("/_fake/pulls")["pulls"][0]["reviews"] == [{"login": "reviewer-one", "state": "APPROVED"}]
    current = s.refresh(diagram_id)["current"]
    assert current["state"] == "open"
    assert current["reviewState"] == "approved"
    assert current["checksState"] == "success"

    # Merge on GitHub -> approved.
    s.fake_post(f"/_fake/pulls/{number}/merge", {"by": "reviewer-one"})
    body = s.refresh(diagram_id)
    assert body["current"]["state"] == "merged"
    assert body["current"]["mergedBy"] == "reviewer-one"
    assert body["approved"]["prNumber"] == number


def test_withdrawing_a_submission_closes_the_pull_request(served: Served) -> None:
    s = served
    project = s.call("POST", "/projects", json={"name": "Withdraw"}).json()["project"]["id"]
    repo_id = s.call("GET", "/admin/github/repositories").json()["repositories"][0]["id"]
    assert s.call("PUT", f"/projects/{project}/github-link", json={"repoId": repo_id, "folder": "w"}).status_code == 200
    created = s.call("POST", f"/projects/{project}/diagrams", json={"name": "Withdraw", "diagramTypeId": "flowchart"})
    diagram_id = created.json()["diagram"]["id"]
    assert s.api.save_diagram(s.admin, diagram_id, DSL).status_code == 200
    number = s.call("POST", f"/diagrams/{diagram_id}/submissions").json()["submission"]["prNumber"]

    assert s.call("POST", f"/diagrams/{diagram_id}/submission/withdraw").status_code == 200
    pull = next(p for p in s.fake_get("/_fake/pulls")["pulls"] if p["number"] == number)
    assert (pull["state"], pull["merged"]) == ("closed", False)


def test_closing_through_the_control_route_rejects_the_submission(served: Served) -> None:
    s = served
    project = s.call("POST", "/projects", json={"name": "Close"}).json()["project"]["id"]
    repo_id = s.call("GET", "/admin/github/repositories").json()["repositories"][0]["id"]
    assert s.call("PUT", f"/projects/{project}/github-link", json={"repoId": repo_id, "folder": "c"}).status_code == 200
    created = s.call("POST", f"/projects/{project}/diagrams", json={"name": "Close", "diagramTypeId": "flowchart"})
    diagram_id = created.json()["diagram"]["id"]
    assert s.api.save_diagram(s.admin, diagram_id, DSL).status_code == 200
    number = s.call("POST", f"/diagrams/{diagram_id}/submissions").json()["submission"]["prNumber"]

    s.fake_post(f"/_fake/pulls/{number}/close")
    assert s.refresh(diagram_id)["current"]["state"] == "closed"
