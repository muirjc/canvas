"""Linking a project to a GitHub repository + folder (admin only), against the in-memory fake GitHub that
verifies the App JWT and installation tokens. Port of apps/api/tests/contract/github-link.test.ts."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from canvas_api.app import create_app
from tests.api import Api
from tests.conftest import github_settings
from tests.fake_github import FakeGitHub
from tests.github_helpers import GH, MISSING_PROJECT

# --- status and repositories --------------------------------------------------------------------------


def test_status_lists_the_installations_and_authenticates_with_a_valid_app_jwt(github: GH) -> None:
    res = github.call("GET", "/admin/github/status", "admin")
    assert res.status_code == 200
    body = res.json()
    assert body["enabled"] is True
    assert body["appId"] == "12345"
    assert [(i["account"], i["repositorySelection"]) for i in body["installations"]] == [("acme", "selected")]
    assert "error" not in body
    assert next(r for r in github.fake.requests if r.path == "/app/installations").auth == "app"


def test_status_reports_a_github_problem_instead_of_failing(github: GH, settings: Any, tmp_path: Any) -> None:
    """An App key GitHub does not recognise."""
    other = FakeGitHub()  # a different keypair, answered by the same fake GitHub
    mismatched = github_settings(settings, github.fake, tmp_path).model_copy(
        update={"github_app_private_key": other.private_key_pem()}
    )
    with TestClient(create_app(mismatched, github.engine, github.fake.transport())) as client:
        res = Api(client, github.engine).call("GET", "/admin/github/status", github.users["admin"])
    assert res.status_code == 200
    assert res.json()["enabled"] is True
    assert res.json()["installations"] == []
    assert "Bad credentials" in res.json()["error"]


def test_lists_installed_repositories_only(github: GH) -> None:
    outside = github.fake.add_installation(id=9999, account="stranger")
    hidden = github.fake.add_repo(outside.id, name="hidden")
    github.fake.remove_repo_from_installation(hidden)
    res = github.call("GET", "/admin/github/repositories", "admin")
    assert res.status_code == 200
    repositories = res.json()["repositories"]
    assert [r["fullName"] for r in repositories] == ["acme/architecture", "acme/other"]
    assert repositories[0]["id"] == github.repo.id
    assert repositories[0]["defaultBranch"] == "main"
    assert isinstance(repositories[0]["installationId"], int)


def test_status_repositories_links_and_the_link_test_are_admin_only(github: GH) -> None:
    for method, url in [
        ("GET", "/admin/github/status"),
        ("GET", "/admin/github/repositories"),
        ("GET", "/admin/github/links"),
        ("POST", f"/admin/github/links/{github.project_id}/test"),
    ]:
        assert github.call(method, url, "owner").status_code == 403, url
    assert github.call("GET", "/admin/github/status", None).status_code == 401


# --- PUT /projects/:id/github-link --------------------------------------------------------------------


def test_put_is_admin_only(github: GH) -> None:
    """An architect who owns the project gets 403."""
    res = github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"}, "owner")
    assert res.status_code == 403
    assert github.call("DELETE", f"/projects/{github.project_id}/github-link", "owner").status_code == 403


def test_links_a_project_defaulting_the_base_branch_and_normalising_the_folder(github: GH) -> None:
    res = github.link(github.project_id, {"repoId": github.repo.id, "folder": "/architecture//diagrams/"})
    assert res.status_code == 200, res.text
    link = res.json()["link"]
    assert link["projectId"] == github.project_id
    assert link["repoId"] == github.repo.id
    assert link["repoFullName"] == "acme/architecture"
    assert link["folder"] == "architecture/diagrams"
    assert link["baseBranch"] == "main"
    assert isinstance(link["installationId"], int)
    assert link["lastCheckError"] is None
    # The token used to check the branch is narrowed to that one repository.
    assert github.fake.token_requests[-1].body["repository_ids"] == [github.repo.id]


def test_uses_an_explicit_base_branch_and_rejects_a_missing_one_with_400(github: GH) -> None:
    github.repo.branches["develop"] = github.fake.head_of(github.repo, "main")
    ok = github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams", "baseBranch": "develop"})
    assert ok.status_code == 200
    assert ok.json()["link"]["baseBranch"] == "develop"

    other_project = github.api.project(github.users["owner"], "Billing")
    missing = github.link(other_project, {"repoId": github.repo.id, "folder": "elsewhere", "baseBranch": "nope"})
    assert missing.status_code == 400
    assert "nope" in missing.json()["error"]


def test_only_accepts_repositories_the_app_is_installed_on(github: GH) -> None:
    outside = github.fake.add_installation(account="stranger")
    hidden = github.fake.add_repo(outside.id, name="hidden")
    github.fake.remove_repo_from_installation(hidden)
    assert github.link(github.project_id, {"repoId": hidden.id, "folder": "diagrams"}).status_code == 400
    assert github.link(github.project_id, {"repoId": 424242, "folder": "diagrams"}).status_code == 400
    assert github.call("GET", "/admin/github/links", "admin").json()["links"] == []


@pytest.mark.parametrize(
    "folder",
    [
        "..",
        "a/../b",
        "../etc",
        ".github",
        ".github/workflows",
        "docs/.git",
        ".canvas",
        "",
        "   ",
        "/",
        "a b",
        "a/\u0000b",
        "a;b",
    ],
)
def test_rejects_bad_folders_with_400(github: GH, folder: str) -> None:
    """Traversal, reserved names, empty, odd characters."""
    res = github.link(github.project_id, {"repoId": github.repo.id, "folder": folder})
    assert res.status_code == 400, repr(folder)
    assert github.call("GET", "/admin/github/links", "admin").json()["links"] == []


def test_rejects_a_missing_folder_and_a_non_numeric_repo_id_with_400(github: GH) -> None:
    assert github.link(github.project_id, {"repoId": github.repo.id}).status_code == 400
    assert github.link(github.project_id, {"repoId": "x", "folder": "a"}).status_code == 400
    assert github.call("GET", "/admin/github/links", "admin").json()["links"] == []


def test_404s_for_an_unknown_project(github: GH) -> None:
    assert github.link(MISSING_PROJECT, {"repoId": github.repo.id, "folder": "diagrams"}).status_code == 404


def test_refuses_the_same_folder_or_a_nested_one_for_another_project_in_the_same_repository(github: GH) -> None:
    other = github.api.project(github.users["owner"], "Billing")
    assert github.link(github.project_id, {"repoId": github.repo.id, "folder": "architecture"}).status_code == 200
    for folder in ["architecture", "architecture/billing", "architecture/billing/deep"]:
        assert github.link(other, {"repoId": github.repo.id, "folder": folder}).status_code == 409, folder
    # ... and the parent of an existing folder too.
    assert github.link(github.project_id, {"repoId": github.repo.id, "folder": "a/b"}).status_code == 200
    assert github.link(other, {"repoId": github.repo.id, "folder": "a"}).status_code == 409
    # A sibling that merely shares a prefix is fine.
    assert github.link(other, {"repoId": github.repo.id, "folder": "a-b"}).status_code == 200
    assert github.link(other, {"repoId": github.repo.id, "folder": "billing"}).status_code == 200


def test_allows_the_same_folder_name_in_a_different_repository(github: GH) -> None:
    other = github.api.project(github.users["owner"], "Billing")
    assert github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"}).status_code == 200
    assert github.link(other, {"repoId": github.other_repo.id, "folder": "diagrams"}).status_code == 200


def test_re_put_updates_the_same_link_in_place(github: GH) -> None:
    """Including moving it to a nested folder of its own."""
    first = github.link(github.project_id, {"repoId": github.repo.id, "folder": "one"}).json()["link"]
    second = github.link(github.project_id, {"repoId": github.repo.id, "folder": "one/two"})
    assert second.status_code == 200
    assert second.json()["link"]["id"] == first["id"]
    assert second.json()["link"]["folder"] == "one/two"
    assert len(github.rows("SELECT id FROM github_links")) == 1


def test_records_an_audit_event(github: GH) -> None:
    github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"})
    events = github.events("github_link_set")
    assert len(events) == 1
    assert "acme/architecture" in str(events[0].detail)


# --- listing, reading, deleting and testing -----------------------------------------------------------


def test_lists_links_shows_a_project_member_the_link_and_delete_removes_it(github: GH) -> None:
    github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"})
    links = github.call("GET", "/admin/github/links", "admin").json()["links"]
    assert len(links) == 1
    assert links[0]["projectId"] == github.project_id
    assert links[0]["projectName"] == "Orders"
    assert links[0]["repoFullName"] == "acme/architecture"
    assert links[0]["folder"] == "diagrams"

    member = github.call("GET", f"/projects/{github.project_id}/github-link", "owner")
    assert member.status_code == 200
    assert member.json() == {
        "enabled": True,
        "link": {"repoFullName": "acme/architecture", "folder": "diagrams", "baseBranch": "main"},
    }

    assert github.call("DELETE", f"/projects/{github.project_id}/github-link", "admin").status_code == 204
    assert github.call("GET", f"/projects/{github.project_id}/github-link", "owner").json() == {
        "enabled": True,
        "link": None,
    }
    assert github.call("DELETE", f"/projects/{github.project_id}/github-link", "admin").status_code == 404
    assert github.call("GET", "/admin/github/links", "admin").json()["links"] == []
    assert len(github.events("github_link_removed")) == 1


def test_a_user_with_no_grant_on_the_project_can_still_read_its_link(github: GH) -> None:
    """canvas-2h2w.1: every project is readable by everyone signed in, so its link is too."""
    assert github.call("GET", f"/projects/{github.project_id}/github-link", "stranger").status_code == 200


def test_the_link_test_passes_every_check_then_fails_once_the_repository_leaves_the_installation(github: GH) -> None:
    github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"})
    ok = github.call("POST", f"/admin/github/links/{github.project_id}/test", "admin")
    assert ok.status_code == 200
    assert ok.json()["ok"] is True
    assert [(c["id"], c["ok"]) for c in ok.json()["checks"]] == [
        ("installation", True),
        ("contents", True),
        ("pull_requests", True),
        ("repository", True),
        ("branch", True),
    ]
    assert github.call("GET", "/admin/github/links", "admin").json()["links"][0]["lastCheckError"] is None

    github.fake.remove_repo_from_installation(github.repo)
    bad = github.call("POST", f"/admin/github/links/{github.project_id}/test", "admin")
    assert bad.status_code == 200
    assert bad.json()["ok"] is False
    failed = next(c for c in bad.json()["checks"] if not c["ok"])
    assert failed["id"] == "repository"
    assert "Repository" in github.call("GET", "/admin/github/links", "admin").json()["links"][0]["lastCheckError"]


def test_the_link_test_reports_missing_permissions_and_a_deleted_base_branch(github: GH) -> None:
    github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"})
    installation = github.fake.installations[github.installation_id]
    installation.permissions = {"contents": "read", "pull_requests": "read", "metadata": "read"}
    read_only = github.call("POST", f"/admin/github/links/{github.project_id}/test", "admin").json()
    assert read_only["ok"] is False
    assert [c["id"] for c in read_only["checks"] if not c["ok"]] == ["contents", "pull_requests"]

    installation.permissions = {"contents": "write", "pull_requests": "write", "metadata": "read"}
    github.fake.delete_branch(github.repo, "main")
    no_branch = github.call("POST", f"/admin/github/links/{github.project_id}/test", "admin").json()
    assert next(c for c in no_branch["checks"] if c["id"] == "branch")["ok"] is False


def test_the_link_test_reports_an_uninstalled_app(github: GH) -> None:
    github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"})
    github.fake.remove_installation(github.installation_id)
    res = github.call("POST", f"/admin/github/links/{github.project_id}/test", "admin").json()
    assert res["ok"] is False
    assert (res["checks"][0]["id"], res["checks"][0]["ok"]) == ("installation", False)


def test_the_link_test_404s_when_the_project_is_not_linked(github: GH) -> None:
    assert github.call("POST", f"/admin/github/links/{github.project_id}/test", "admin").status_code == 404


def test_follows_a_repository_that_was_renamed_on_github(github: GH) -> None:
    github.link(github.project_id, {"repoId": github.repo.id, "folder": "diagrams"})
    github.fake.rename_repo(github.repo, "architecture-v2")
    assert github.call("POST", f"/admin/github/links/{github.project_id}/test", "admin").json()["ok"] is True
    assert (
        github.call("GET", "/admin/github/links", "admin").json()["links"][0]["repoFullName"] == "acme/architecture-v2"
    )


# --- when the integration is not configured -----------------------------------------------------------


@pytest.fixture()
def off(api: Any, needs_bridge: str) -> tuple[Api, Any, str, str]:
    """A signed-in admin with a project and a diagram, on an app with no GitHub App configured."""
    admin = api.user("admin@example.com", "admin", "Adam Admin")
    api.diagram_type("flowchart")
    project_id = api.project(admin, "P")
    diagram_id = api.new_diagram(project_id, admin)["id"]
    return api, admin, project_id, diagram_id


def test_not_configured_reports_enabled_false_and_never_throws(off: tuple[Api, Any, str, str]) -> None:
    api, admin, project_id, diagram_id = off
    assert api.call("GET", "/admin/github/status", admin).json() == {"enabled": False, "installations": []}
    assert api.call("GET", f"/projects/{project_id}/github-link", admin).json() == {"enabled": False, "link": None}

    submission = api.call("GET", f"/diagrams/{diagram_id}/submission", admin)
    assert submission.status_code == 200
    body = submission.json()
    assert body["enabled"] is False
    assert body["link"] is None
    assert body["current"] is None
    assert body["changesSinceSubmitting"] is False
    assert body["canSubmit"]["allowed"] is False
    assert body["canSubmit"]["reason"] == "github_disabled"


def test_not_configured_answers_github_disabled_409_for_every_route_that_needs_github(
    off: tuple[Api, Any, str, str],
) -> None:
    api, admin, project_id, diagram_id = off
    calls: list[tuple[str, str, Any]] = [
        ("GET", "/admin/github/repositories", None),
        ("POST", f"/admin/github/links/{project_id}/test", None),
        ("PUT", f"/projects/{project_id}/github-link", {"repoId": 1, "folder": "diagrams"}),
        ("POST", f"/diagrams/{diagram_id}/submissions", None),
    ]
    for method, url, payload in calls:
        res = api.call(method, url, admin, json=payload)
        assert res.status_code == 409, f"{method} {url}"
        assert res.json()["code"] == "github_disabled"
    assert api.call("GET", "/admin/github/links", admin).json() == {"links": []}
    assert api.call("DELETE", f"/projects/{project_id}/github-link", admin).status_code == 404
