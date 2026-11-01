"""Projects (canvas-1bty.6), the cases of apps/api/tests/contract/projects, project-list,
project-management (rename), project-delete-restore, project-access, effective-access (the project list)
and timestamps-iso (projects). Every response is also checked against the API contract (tests/api.py).
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import pytest

from tests.api import JS_ISO, MISSING_ID, Api, User


@pytest.fixture()
def owner(api: Api) -> User:
    api.diagram_type("flowchart")
    return api.user("owner@example.com")


def create(api: Api, who: User, name: str, parent: str | None = None) -> str:
    payload = {"name": name, **({"parentProjectId": parent} if parent else {})}
    response = api.call("POST", "/projects", who, json=payload)
    assert response.status_code == 201, response.text
    project_id: str = response.json()["project"]["id"]
    return project_id


def names(api: Api, who: User) -> list[str]:
    return [p["name"] for p in api.call("GET", "/projects", who).json()["projects"]]


# --- create, read, tree (projects.test.ts) ----------------------------------------------------------


def test_creates_a_root_project_and_fetches_it(api: Api, owner: User) -> None:
    created = api.call("POST", "/projects", owner, json={"name": "Root Project"})
    assert created.status_code == 201
    project = created.json()["project"]
    assert project["parentProjectId"] is None
    assert project | {"diagramCount": 0, "ownerId": owner.id, "accessLevel": "manage", "membership": "owner"} == project

    fetched = api.call("GET", f"/projects/{project['id']}", owner)
    assert fetched.status_code == 200
    assert fetched.json()["project"]["name"] == "Root Project"


def test_rejects_a_child_project_with_a_missing_parent(api: Api, owner: User) -> None:
    response = api.call("POST", "/projects", owner, json={"name": "Orphan", "parentProjectId": MISSING_ID})
    assert response.status_code == 400


@pytest.mark.parametrize("payload", [{}, {"name": ""}, {"name": 5}, {"name": "x", "parentProjectId": 7}])
def test_rejects_a_malformed_create(api: Api, owner: User, payload: dict[str, object]) -> None:
    assert api.call("POST", "/projects", owner, json=payload).status_code == 400


def test_builds_a_nested_tree_with_diagrams_at_each_level(api: Api, owner: User) -> None:
    root = create(api, owner, "Root")
    child = create(api, owner, "Child", root)
    api.diagram(child, owner, "Nested Diagram")

    response = api.call("GET", f"/projects/{root}/tree", owner)
    assert response.status_code == 200
    tree = response.json()["tree"]
    assert tree["id"] == root
    assert [c["id"] for c in tree["children"]] == [child]
    assert [d["name"] for d in tree["children"][0]["diagrams"]] == ["Nested Diagram"]


def test_builds_a_three_level_tree_with_a_diagram_only_at_the_bottom(api: Api, owner: User) -> None:
    root = create(api, owner, "Root")
    child = create(api, owner, "Child", root)
    grandchild = create(api, owner, "Grandchild", child)
    api.diagram(grandchild, owner, "Deepest Diagram")

    tree = api.call("GET", f"/projects/{root}/tree", owner).json()["tree"]
    assert tree["diagrams"] == []
    assert tree["children"][0]["diagrams"] == []
    deepest = tree["children"][0]["children"][0]
    assert deepest["id"] == grandchild
    assert [d["name"] for d in deepest["diagrams"]] == ["Deepest Diagram"]


def test_the_tree_leaves_out_deleted_and_draft_diagrams_and_lists_newest_first(api: Api, owner: User) -> None:
    project = create(api, owner, "P")
    first = api.diagram(project, owner, "First")
    time.sleep(0.01 if api.dialect == "postgresql" else 1.1)  # SQLite's CURRENT_TIMESTAMP has whole seconds
    second = api.diagram(project, owner, "Second")
    api.diagram(project, owner, "Gone", deleted=True)
    api.diagram(project, owner, "Unsaved", draft=True)

    diagrams = api.call("GET", f"/projects/{project}/tree", owner).json()["tree"]["diagrams"]
    assert [d["id"] for d in diagrams] == [second, first]
    assert diagrams[0] == {"id": second, "name": "Second", "diagramTypeId": "flowchart"}


def test_tree_of_a_missing_project_is_404(api: Api, owner: User) -> None:
    assert api.call("GET", f"/projects/{MISSING_ID}/tree", owner).status_code == 404


# --- the list (project-list.test.ts, effective-access.test.ts) ----------------------------------------


def test_lists_a_project_the_user_owns(api: Api, owner: User) -> None:
    create(api, owner, "Alice Owned")
    response = api.call("GET", "/projects", owner)
    assert response.status_code == 200
    assert names(api, owner) == ["Alice Owned"]


def test_lists_someone_elses_project_read_only_not_as_the_users_own(api: Api, owner: User) -> None:
    bob = api.user("bob@example.com")
    create(api, bob, "Bob Open Project")
    [listed] = api.call("GET", "/projects", owner).json()["projects"]
    assert listed["name"] == "Bob Open Project"
    assert (listed["accessLevel"], listed["membership"]) == ("view", None)
    [own] = api.call("GET", "/projects", bob).json()["projects"]
    assert (own["accessLevel"], own["membership"]) == ("manage", "owner")


def test_lists_a_project_shared_with_the_user_as_a_member(api: Api, owner: User) -> None:
    bob = api.user("bob@example.com")
    project = create(api, bob, "Bob Shared")
    api.grant("project", project, owner, "view", bob)
    [listed] = api.call("GET", "/projects", owner).json()["projects"]
    assert (listed["name"], listed["accessLevel"], listed["membership"]) == ("Bob Shared", "view", "member")


def test_an_empty_installation_is_an_empty_list_not_an_error(api: Api, owner: User) -> None:
    response = api.call("GET", "/projects", owner)
    assert response.status_code == 200
    assert response.json() == {"projects": []}


def test_includes_descendants_and_orders_by_name(api: Api, owner: User) -> None:
    root = create(api, owner, "Root")
    create(api, owner, "Child", root)
    create(api, owner, "Zebra")
    create(api, owner, "Alpha")
    assert names(api, owner) == ["Alpha", "Child", "Root", "Zebra"]


def test_the_list_requires_sign_in(api: Api) -> None:
    response = api.call("GET", "/projects")
    assert response.status_code == 401
    assert response.json() == {"error": "Authentication required"}


def test_counts_each_projects_live_saved_diagrams(api: Api, owner: User) -> None:
    has = create(api, owner, "Has Diagrams")
    api.diagram(has, owner, "One")
    api.diagram(has, owner, "Two")
    api.diagram(has, owner, "Gone", deleted=True)
    api.diagram(has, owner, "Unsaved", draft=True)
    create(api, owner, "Empty Project")
    counts = {p["name"]: p["diagramCount"] for p in api.call("GET", "/projects", owner).json()["projects"]}
    assert counts == {"Has Diagrams": 2, "Empty Project": 0}


def test_list_levels_follow_grants_down_the_tree_and_cap_viewers(api: Api, owner: User) -> None:
    member = api.user("member@example.com")
    reader = api.user("reader@example.com", role="viewer")
    admin = api.user("admin@example.com", role="admin")
    root = create(api, owner, "Root")
    child = create(api, owner, "Child", root)
    grandchild = create(api, owner, "Grandchild", child)
    api.grant("project", child, member, "edit", owner)
    api.grant("project", root, reader, "manage", owner)

    by_id = {p["id"]: p for p in api.call("GET", "/projects", member).json()["projects"]}
    assert (by_id[root]["accessLevel"], by_id[root]["membership"]) == ("view", None)
    assert (by_id[child]["accessLevel"], by_id[child]["membership"]) == ("edit", "member")
    assert (by_id[grandchild]["accessLevel"], by_id[grandchild]["membership"]) == ("edit", "member")

    for p in api.call("GET", "/projects", reader).json()["projects"]:
        assert (p["accessLevel"], p["membership"]) == ("comment", "member")
    for p in api.call("GET", "/projects", admin).json()["projects"]:
        assert (p["accessLevel"], p["membership"]) == ("manage", None)


def test_a_deleted_ancestor_stops_passing_its_grant_down(api: Api, owner: User) -> None:
    outsider = api.user("outsider@example.com")
    root = create(api, owner, "Root")
    child = create(api, owner, "Child", root)
    grandchild = create(api, owner, "Grandchild", child)
    api.grant("project", root, outsider, "edit", owner)

    def level() -> str:
        listed = {p["id"]: p for p in api.call("GET", "/projects", outsider).json()["projects"]}
        return str(listed[grandchild]["accessLevel"])

    assert level() == "edit"
    api.execute("UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = :id", id=root)
    assert level() == "view"


def test_a_viewer_cannot_create_projects(api: Api, owner: User) -> None:
    reader = api.user("reader@example.com", role="viewer")
    response = api.call("POST", "/projects", reader, json={"name": "Mine"})
    assert response.status_code == 403
    assert response.json() == {"error": "This action requires one of the following roles: architect, admin"}


def test_project_timestamps_are_utc_iso(api: Api, owner: User) -> None:
    create(api, owner, "P")
    [project] = api.call("GET", "/projects", owner).json()["projects"]
    assert JS_ISO.match(project["createdAt"])
    created = datetime.fromisoformat(project["createdAt"].replace("Z", "+00:00"))
    assert abs(created - datetime.now(UTC)) < timedelta(minutes=1)


# --- access (project-access.test.ts) -----------------------------------------------------------------


def test_anyone_signed_in_can_read_a_project_and_its_tree(api: Api, owner: User) -> None:
    outsider = api.user("outsider@example.com")
    project = create(api, owner, "Owned")
    assert api.call("GET", f"/projects/{project}", outsider).status_code == 200
    assert api.call("GET", f"/projects/{project}/tree", outsider).status_code == 200


def test_a_missing_project_is_404_not_403(api: Api, owner: User) -> None:
    outsider = api.user("outsider@example.com")
    response = api.call("GET", f"/projects/{MISSING_ID}", outsider)
    assert response.status_code == 404
    assert response.json() == {"error": f"No project with id {MISSING_ID}"}


def test_reading_a_project_requires_sign_in(api: Api, owner: User) -> None:
    project = create(api, owner, "P")
    assert api.call("GET", f"/projects/{project}").status_code == 401


# --- rename (project-management.test.ts) -------------------------------------------------------------


@pytest.fixture()
def project(api: Api, owner: User) -> str:
    return api.project(owner, "Original Name")


def test_the_owner_renames_their_project(api: Api, owner: User, project: str) -> None:
    response = api.call("PATCH", f"/projects/{project}", owner, json={"name": "Renamed"})
    assert response.status_code == 200
    assert response.json()["project"]["name"] == "Renamed"
    assert api.call("GET", f"/projects/{project}", owner).json()["project"]["name"] == "Renamed"


def test_rename_is_owner_or_admin_only_even_with_an_edit_grant(api: Api, owner: User, project: str) -> None:
    other = api.user("other@example.com")
    editor = api.user("editor@example.com")
    api.grant("project", project, editor, "edit", owner)
    for who in (other, editor):
        response = api.call("PATCH", f"/projects/{project}", who, json={"name": "Hijacked"})
        assert response.status_code == 403
        assert response.json() == {"error": "Only this project's owner or an admin can do that."}
    admin = api.user("admin@example.com", role="admin")
    assert api.call("PATCH", f"/projects/{project}", admin, json={"name": "By Admin"}).status_code == 200


def test_rename_rejects_an_empty_name_a_missing_project_and_no_sign_in(api: Api, owner: User, project: str) -> None:
    assert api.call("PATCH", f"/projects/{project}", owner, json={"name": ""}).status_code == 400
    assert api.call("PATCH", f"/projects/{MISSING_ID}", owner, json={"name": "Anything"}).status_code == 404
    assert api.call("PATCH", f"/projects/{project}", json={"name": "X"}).status_code == 401


# --- delete and restore (project-delete-restore.test.ts) ---------------------------------------------


def test_delete_is_owner_or_admin_only(api: Api, owner: User, project: str) -> None:
    other = api.user("other@example.com")
    assert api.call("DELETE", f"/projects/{project}", other).status_code == 403
    admin = api.user("admin@example.com", role="admin")
    assert api.call("DELETE", f"/projects/{project}", admin).status_code == 204


def test_the_owner_soft_deletes_an_empty_project(api: Api, owner: User, project: str) -> None:
    response = api.call("DELETE", f"/projects/{project}", owner)
    assert response.status_code == 204
    assert api.call("GET", f"/projects/{project}", owner).status_code == 404
    assert api.call("GET", "/projects", owner).json() == {"projects": []}
    assert api.scalar("SELECT deleted_by_user_id FROM projects WHERE id = :id", id=project) is not None


def test_deleting_twice_is_a_no_op_success(api: Api, owner: User, project: str) -> None:
    api.call("DELETE", f"/projects/{project}", owner)
    assert api.call("DELETE", f"/projects/{project}", owner).status_code == 204


def test_a_project_with_a_diagram_or_a_child_is_not_deleted(api: Api, owner: User, project: str) -> None:
    api.diagram(project, owner, "Still Here")
    response = api.call("DELETE", f"/projects/{project}", owner)
    assert response.status_code == 409
    assert "no diagrams" in response.json()["error"].lower()
    assert api.call("GET", f"/projects/{project}", owner).status_code == 200

    other = api.project(owner, "Parent")
    create(api, owner, "Child", other)
    assert api.call("DELETE", f"/projects/{other}", owner).status_code == 409


def test_a_deleted_diagram_or_draft_does_not_block_deletion(api: Api, owner: User, project: str) -> None:
    api.diagram(project, owner, "Gone", deleted=True)
    api.diagram(project, owner, "Unsaved", draft=True)
    assert api.call("DELETE", f"/projects/{project}", owner).status_code == 204


def test_delete_missing_and_signed_out(api: Api, owner: User, project: str) -> None:
    assert api.call("DELETE", f"/projects/{MISSING_ID}", owner).status_code == 404
    assert api.call("DELETE", f"/projects/{project}").status_code == 401


def test_only_admins_list_or_restore_deleted_projects(api: Api, owner: User, project: str) -> None:
    api.call("DELETE", f"/projects/{project}", owner)
    assert api.call("GET", "/admin/deleted-projects", owner).status_code == 403
    assert api.call("POST", f"/projects/{project}/restore", owner).status_code == 403


def test_lists_deleted_projects_with_metadata_only(api: Api, owner: User, project: str) -> None:
    admin = api.user("admin@example.com", role="admin")
    api.call("DELETE", f"/projects/{project}", owner)
    old = api.project(owner, "Too Old", deleted_at=datetime.now(UTC) - timedelta(days=31))
    response = api.call("GET", "/admin/deleted-projects", admin)
    assert response.status_code == 200
    [entry] = response.json()["projects"]
    assert (entry["id"], entry["name"], entry["ownerId"]) == (project, "Original Name", owner.id)
    assert JS_ISO.match(entry["deletedAt"])
    assert old not in [p["id"] for p in response.json()["projects"]]


def test_an_admin_restores_a_deleted_project_and_who_and_when_are_recorded(api: Api, owner: User, project: str) -> None:
    admin = api.user("admin@example.com", role="admin")
    api.call("DELETE", f"/projects/{project}", owner)
    response = api.call("POST", f"/projects/{project}/restore", admin)
    assert response.status_code == 200
    assert response.json()["project"]["id"] == project
    assert api.call("GET", f"/projects/{project}", owner).status_code == 200
    assert api.scalar("SELECT restored_by_user_id FROM projects WHERE id = :id", id=project) is not None
    assert api.scalar("SELECT restored_at FROM projects WHERE id = :id", id=project) is not None


def test_restoring_past_the_retention_window_is_refused(api: Api, owner: User) -> None:
    admin = api.user("admin@example.com", role="admin")
    old = api.project(owner, "Old", deleted_at=datetime.now(UTC) - timedelta(days=31))
    response = api.call("POST", f"/projects/{old}/restore", admin)
    assert response.status_code == 409
    assert "no longer available" in response.json()["error"].lower()


def test_restoring_a_project_that_was_never_deleted_is_404(api: Api, owner: User, project: str) -> None:
    admin = api.user("admin@example.com", role="admin")
    assert api.call("POST", f"/projects/{project}/restore", admin).status_code == 404
