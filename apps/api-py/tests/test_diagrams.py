"""Diagrams (phase 4, canvas-1bty.8): create, read, save, rename, describe, move, delete and restore, drafts,
and the diagram-route cases of other TypeScript files. Every response is also checked against the API
contract (tests/api.py). Saving parses and validates through the diagram-core bridge, so these tests need it
(`needs_bridge`).

Covers apps/api/tests/contract: diagrams, diagram-rename, diagram-description, diagram-delete-restore,
diagram-draft, and the diagram-route cases of project-management (move), project-access (creating, listing
and importing by access, incl. nesting), effective-access (access from each source, the viewer cap, saving per
level), timestamps-iso (diagrams), standards and standards-v2 (a saved diagram records its validation result).
Versions and edit conflicts are in test_diagram_versions.py, import in test_diagram_import.py, and a custom
type's locked family in test_diagram_types.py.

Left out:
- diagrams.test.ts's export cases (mermaid, svg, png, portable style lines): in test_export.py.
- diagram-draft.test.ts's "an abandoned draft is purged after a day": it calls the TypeScript service
  functions (findAbandonedDraftIds, purgeExpiredDiagrams), not a route; the purge job isn't ported yet.
- standards.test.ts / standards-v2.test.ts: publishing and retiring standards (and the revalidation they
  trigger) are in test_standards.py; here the standard is seeded as published, directly.
- diagram-delete-restore.test.ts reads restored_at/restored_by_user_id from the database, as the TS test does.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta

import pytest

from canvas_api.timestamps import to_db
from tests.api import JS_ISO, MISSING_ID, T0, Api, User

FLOWCHART_ABC = "flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n"


@dataclass
class World:
    api: Api
    owner: User
    project: str
    diagram: dict[str, str]


@pytest.fixture()
def owner(api: Api, needs_bridge: str) -> User:
    api.diagram_type("flowchart", name="Generic Flowchart")
    return api.user("owner@example.com", name="Ozzy Owner")


@pytest.fixture()
def w(api: Api, owner: User) -> World:
    project = api.project(owner, "Source")
    return World(api, owner, project, api.new_diagram(project, owner, "Original Name"))


# --- diagrams.test.ts ---------------------------------------------------------------------------------


def test_create_requires_authentication(api: Api, owner: User) -> None:
    project = api.project(owner)
    response = api.call(
        "POST", f"/projects/{project}/diagrams", json={"name": "Untitled", "diagramTypeId": "flowchart"}
    )
    assert response.status_code == 401


def test_creates_fetches_and_saves_a_diagram_end_to_end(api: Api, owner: User) -> None:
    project = api.project(owner, "Test Project")
    created = api.call(
        "POST",
        f"/projects/{project}/diagrams",
        owner,
        json={"name": "Smoke Test Diagram", "diagramTypeId": "flowchart", "initialDslContent": FLOWCHART_ABC},
    )
    assert created.status_code == 201
    diagram = created.json()["diagram"]
    assert diagram["name"] == "Smoke Test Diagram"
    assert "A[Start]" in diagram["dslContent"]

    fetched = api.call("GET", f"/diagrams/{diagram['id']}", owner)
    assert fetched.status_code == 200
    assert "A --> B" in fetched.json()["diagram"]["dslContent"]

    saved = api.save_diagram(
        owner,
        diagram,
        "flowchart TD\n  A[Start]\n  B[End]\n  C[New]\n  A --> B\n  B --> C\n",
        diagram["currentVersionId"],
    )
    assert saved.status_code == 200
    assert "C[New]" in saved.json()["diagram"]["dslContent"]


def test_a_new_diagram_with_no_content_starts_as_its_families_empty_diagram(api: Api, owner: User) -> None:
    # Regression: creating used to default to "flowchart TD" whatever the type, which won't parse for other families.
    api.diagram_type("c4-context", "c4", name="C4 Context", personas=["Technical"], palette=["c4-notation"])
    diagram = api.new_diagram(api.project(owner), owner, "Untitled C4", "c4-context")
    assert "C4Context" in diagram["dslContent"]
    assert diagram["dslFamily"] == "c4"


def test_an_unparseable_save_is_a_422_with_structured_details(api: Api, owner: User) -> None:
    diagram = api.new_diagram(api.project(owner), owner, "Bad Diagram")
    response = api.save_diagram(owner, diagram, "flowchart TD\n  ???not-valid???\n")
    assert response.status_code == 422
    details = response.json()["details"]
    assert isinstance(details, list)
    assert "line" in details[0]
    assert "message" in details[0]


def test_a_diagram_that_does_not_exist_is_a_404(api: Api, owner: User) -> None:
    assert api.call("GET", f"/diagrams/{MISSING_ID}", owner).status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"name": ""},
        {"name": "X"},
        {"name": "X", "diagramTypeId": 3},
        {"name": "X", "diagramTypeId": "flowchart", "draft": "yes"},
    ],
)
def test_rejects_a_malformed_create(api: Api, owner: User, payload: dict[str, object]) -> None:
    project = api.project(owner)
    assert api.call("POST", f"/projects/{project}/diagrams", owner, json=payload).status_code == 400


def test_creating_with_an_unknown_diagram_type_is_a_400_and_writes_nothing(api: Api, owner: User) -> None:
    project = api.project(owner)
    response = api.call("POST", f"/projects/{project}/diagrams", owner, json={"name": "X", "diagramTypeId": "nope"})
    assert response.status_code == 400
    assert response.json()["error"] == "Unknown diagram type: nope"
    assert api.scalar("SELECT COUNT(*) FROM diagrams") == 0


def test_creating_with_unparseable_initial_content_is_a_422_and_writes_nothing(api: Api, owner: User) -> None:
    project = api.project(owner)
    response = api.call(
        "POST",
        f"/projects/{project}/diagrams",
        owner,
        json={"name": "X", "diagramTypeId": "flowchart", "initialDslContent": "flowchart TD\n  ???not-valid???\n"},
    )
    assert response.status_code == 422
    assert response.json()["error"] == "DSL could not be parsed"
    assert api.scalar("SELECT COUNT(*) FROM diagrams") == 0
    assert api.scalar("SELECT COUNT(*) FROM diagram_versions") == 0


def test_search_filters_a_projects_diagrams_by_name_and_type_newest_first(api: Api, owner: User) -> None:
    api.diagram_type("sequence", "sequence", name="Sequence")
    project = api.project(owner)
    first = api.new_diagram(project, owner, "Checkout flow")
    second = api.new_diagram(project, owner, "Checkout sequence", "sequence")
    api.new_diagram(project, owner, "Billing")
    api.execute("UPDATE diagrams SET updated_at = :at WHERE id = :id", at=_db(api, T0), id=first["id"])

    def ids(query: str = "") -> list[str]:
        response = api.call("GET", f"/projects/{project}/diagrams{query}", owner)
        assert response.status_code == 200
        return [d["id"] for d in response.json()["diagrams"]]

    assert ids("?query=checkout")[-1] == first["id"]
    assert set(ids("?query=checkout")) == {first["id"], second["id"]}
    assert ids("?query=checkout&type=sequence") == [second["id"]]
    assert ids("?query=zzzznomatch") == []
    assert len(ids()) == 3


# --- diagram-rename.test.ts ---------------------------------------------------------------------------


def rename(w: World, who: User | None, name: object, diagram: str | None = None) -> int:
    return w.api.call("PATCH", f"/diagrams/{diagram or w.diagram['id']}/name", who, json={"name": name}).status_code


def stored(w: World, field: str) -> object:
    return w.api.call("GET", f"/diagrams/{w.diagram['id']}", w.owner).json()["diagram"][field]


def test_a_user_with_edit_access_renames_the_diagram_and_it_persists(w: World) -> None:
    response = w.api.call("PATCH", f"/diagrams/{w.diagram['id']}/name", w.owner, json={"name": "Renamed Diagram"})
    assert response.status_code == 200
    assert response.json()["diagram"]["name"] == "Renamed Diagram"
    assert stored(w, "name") == "Renamed Diagram"


def test_rename_is_refused_for_a_viewer(w: World) -> None:
    viewer = w.api.user("viewer@example.com")
    w.api.grant("diagram", w.diagram["id"], viewer, "view", w.owner)
    assert rename(w, viewer, "Hijacked") == 403
    assert stored(w, "name") == "Original Name"


def test_rename_is_refused_for_a_user_with_no_grant(w: World) -> None:
    assert rename(w, w.api.user("outsider@example.com"), "Hijacked") == 403


def test_rename_needs_a_name(w: World) -> None:
    assert w.api.call("PATCH", f"/diagrams/{w.diagram['id']}/name", w.owner, json={}).status_code == 400


@pytest.mark.parametrize("name", ["   ", "", 5])
def test_rename_rejects_a_blank_or_non_string_name(w: World, name: object) -> None:
    assert rename(w, w.owner, name) == 400


def test_rename_of_a_diagram_that_does_not_exist_is_a_404(w: World) -> None:
    assert rename(w, w.owner, "Anything", MISSING_ID) == 404


def test_rename_requires_authentication(w: World) -> None:
    assert rename(w, None, "X") == 401


def test_rename_touches_neither_the_content_nor_the_version_history(w: World) -> None:
    before = w.api.call("GET", f"/diagrams/{w.diagram['id']}/versions", w.owner).json()["versions"]
    response = w.api.call("PATCH", f"/diagrams/{w.diagram['id']}/name", w.owner, json={"name": "Renamed"})
    assert response.status_code == 200
    assert response.json()["diagram"]["dslContent"] == w.diagram["dslContent"]
    assert stored(w, "dslContent") == w.diagram["dslContent"]
    assert stored(w, "currentVersionId") == w.diagram["currentVersionId"]
    assert w.api.call("GET", f"/diagrams/{w.diagram['id']}/versions", w.owner).json()["versions"] == before


# --- diagram-description.test.ts ----------------------------------------------------------------------


def describe(w: World, who: User | None, description: object, diagram: str | None = None) -> int:
    return w.api.call(
        "PATCH", f"/diagrams/{diagram or w.diagram['id']}/description", who, json={"description": description}
    ).status_code


def test_a_new_diagram_has_no_description_and_its_owners_name(w: World) -> None:
    assert w.diagram["description"] is None
    assert w.diagram["ownerName"] == "Ozzy Owner"
    fetched = w.api.call("GET", f"/diagrams/{w.diagram['id']}", w.owner).json()["diagram"]
    assert fetched["description"] is None
    assert fetched["ownerName"] == "Ozzy Owner"


def test_a_user_with_edit_access_sets_the_description_and_it_persists(w: World) -> None:
    response = w.api.call(
        "PATCH",
        f"/diagrams/{w.diagram['id']}/description",
        w.owner,
        json={"description": "A diagram describing the checkout flow."},
    )
    assert response.status_code == 200
    assert response.json()["diagram"]["description"] == "A diagram describing the checkout flow."
    assert stored(w, "description") == "A diagram describing the checkout flow."


def test_describe_is_refused_for_a_viewer(w: World) -> None:
    viewer = w.api.user("viewer@example.com")
    w.api.grant("diagram", w.diagram["id"], viewer, "view", w.owner)
    assert describe(w, viewer, "Hijacked description") == 403
    assert stored(w, "description") is None


def test_describe_is_refused_for_a_user_with_no_grant(w: World) -> None:
    assert describe(w, w.api.user("outsider@example.com"), "Hijacked description") == 403


def test_an_empty_description_clears_it_back_to_null(w: World) -> None:
    first = w.api.call("PATCH", f"/diagrams/{w.diagram['id']}/description", w.owner, json={"description": "Set first"})
    assert first.json()["diagram"]["description"] == "Set first"
    cleared = w.api.call("PATCH", f"/diagrams/{w.diagram['id']}/description", w.owner, json={"description": ""})
    assert cleared.status_code == 200
    assert cleared.json()["diagram"]["description"] is None
    assert stored(w, "description") is None


def test_describe_rejects_a_non_string_description(w: World) -> None:
    assert describe(w, w.owner, 12345) == 400


def test_describe_needs_a_description(w: World) -> None:
    assert w.api.call("PATCH", f"/diagrams/{w.diagram['id']}/description", w.owner, json={}).status_code == 400


def test_describe_of_a_diagram_that_does_not_exist_is_a_404(w: World) -> None:
    assert describe(w, w.owner, "Anything", MISSING_ID) == 404


def test_describe_requires_authentication(w: World) -> None:
    assert describe(w, None, "X") == 401


# --- project-management.test.ts: move diagram ---------------------------------------------------------


@dataclass
class Moving:
    w: World
    destination: str
    no_access: str

    def move(self, who: User | None, project: str, diagram: str | None = None) -> int:
        return self.w.api.call(
            "PATCH", f"/diagrams/{diagram or self.w.diagram['id']}/project", who, json={"projectId": project}
        ).status_code


@pytest.fixture()
def moving(w: World) -> Moving:
    stranger = w.api.user("stranger@example.com")
    return Moving(w, w.api.project(w.owner, "Destination"), w.api.project(stranger, "No Access"))


def test_moves_a_diagram_to_a_project_the_user_can_edit(moving: Moving) -> None:
    w = moving.w
    response = w.api.call(
        "PATCH", f"/diagrams/{w.diagram['id']}/project", w.owner, json={"projectId": moving.destination}
    )
    assert response.status_code == 200
    assert response.json()["diagram"]["projectId"] == moving.destination
    assert w.api.call("GET", f"/projects/{w.project}/tree", w.owner).json()["tree"]["diagrams"] == []
    destination = w.api.call("GET", f"/projects/{moving.destination}/tree", w.owner).json()["tree"]["diagrams"]
    assert [d["id"] for d in destination] == [w.diagram["id"]]


def test_move_is_refused_for_a_user_with_no_grant_on_the_diagram(moving: Moving) -> None:
    assert moving.move(moving.w.api.user("outsider@example.com"), moving.destination) == 403


def test_move_into_a_project_the_user_cannot_edit_is_refused_and_applies_nothing(moving: Moving) -> None:
    assert moving.move(moving.w.owner, moving.no_access) == 403
    assert stored(moving.w, "projectId") == moving.w.project


def test_move_of_a_diagram_that_does_not_exist_is_a_404(moving: Moving) -> None:
    assert moving.move(moving.w.owner, moving.destination, MISSING_ID) == 404


def test_move_into_a_project_that_does_not_exist_is_a_404(moving: Moving) -> None:
    assert moving.move(moving.w.owner, MISSING_ID) == 404


def test_move_requires_authentication(moving: Moving) -> None:
    assert moving.move(None, moving.destination) == 401


# --- project-access.test.ts: diagram routes -----------------------------------------------------------


def test_a_user_with_no_grant_cannot_create_in_a_project_but_can_list_it(w: World) -> None:
    outsider = w.api.user("outsider@example.com")
    created = w.api.call(
        "POST", f"/projects/{w.project}/diagrams", outsider, json={"name": "Trespass", "diagramTypeId": "flowchart"}
    )
    assert created.status_code == 403
    assert w.api.call("GET", f"/projects/{w.project}/diagrams", outsider).status_code == 200
    assert w.api.scalar("SELECT COUNT(*) FROM diagrams") == 1


def test_a_user_with_edit_on_a_parent_can_create_in_a_grandchild_project(api: Api, owner: User) -> None:
    root = api.project(owner, "Owned")
    child = api.project(owner, "Child", root)
    grandchild = api.project(owner, "Grandchild", child)
    outsider = api.user("outsider@example.com")
    api.grant("project", root, outsider, "edit", owner)

    assert create_status(api, outsider, grandchild) == 201
    listed = {p["id"]: p for p in api.call("GET", "/projects", outsider).json()["projects"]}
    assert (listed[grandchild]["accessLevel"], listed[grandchild]["membership"]) == ("edit", "member")


def test_a_grant_on_a_child_project_gives_nothing_on_its_parent(api: Api, owner: User) -> None:
    root = api.project(owner, "Owned")
    child = api.project(owner, "Child", root)
    outsider = api.user("outsider@example.com")
    api.grant("project", child, outsider, "edit", owner)

    assert create_status(api, outsider, child) == 201
    assert create_status(api, outsider, root) == 403


def test_a_soft_deleted_ancestor_no_longer_passes_its_grant_to_live_descendants(api: Api, owner: User) -> None:
    root = api.project(owner, "Owned")
    child = api.project(owner, "Child", root)
    grandchild = api.project(owner, "Grandchild", child)
    outsider = api.user("outsider@example.com")
    api.grant("project", root, outsider, "edit", owner)
    assert create_status(api, outsider, grandchild) == 201

    api.execute(
        "UPDATE projects SET deleted_at = :at WHERE id = :id", at=_db(api, datetime.now().astimezone()), id=root
    )
    assert create_status(api, outsider, grandchild) == 403


def create_status(api: Api, who: User, project: str) -> int:
    return api.call(
        "POST", f"/projects/{project}/diagrams", who, json={"name": "Nested", "diagramTypeId": "flowchart"}
    ).status_code


# --- effective-access.test.ts: diagrams ---------------------------------------------------------------


@dataclass
class People:
    api: Api
    owner: User
    author: User
    member: User
    stranger: User
    reader: User
    admin: User
    project: str
    child: str
    diagram: str

    def level(self, who: User, diagram: str | None = None) -> str:
        level: str = self.api.call("GET", f"/diagrams/{diagram or self.diagram}", who).json()["diagram"]["accessLevel"]
        return level


@pytest.fixture()
def people(api: Api, owner: User) -> People:
    author = api.user("author@example.com")
    project = api.project(owner, "Payments")
    child = api.project(owner, "Payments child", project)
    # The diagram's author is not the project's owner: the author gets Edit on the project to create it.
    api.grant("project", project, author, "edit", owner)
    diagram = api.new_diagram(project, author, "Flow")["id"]
    return People(
        api,
        owner,
        author,
        api.user("member@example.com"),
        api.user("stranger@example.com"),
        api.user("reader@example.com", role="viewer"),
        api.user("admin@example.com", role="admin"),
        project,
        child,
        diagram,
    )


def test_everyone_signed_in_can_read_a_diagram_at_view_and_view_cannot_comment(people: People) -> None:
    assert people.level(people.stranger) == "view"
    assert people.api.call("GET", f"/projects/{people.project}/tree", people.stranger).status_code == 200
    comment = people.api.call("POST", f"/diagrams/{people.diagram}/comments", people.stranger, json={"body": "hi"})
    assert comment.status_code == 403


def test_owning_the_diagram_owning_its_project_and_being_an_admin_each_give_manage(people: People) -> None:
    assert people.level(people.author) == "manage"
    assert people.level(people.owner) == "manage"
    assert people.level(people.admin) == "manage"


def test_a_project_grant_covers_its_diagrams_and_its_child_projects(people: People) -> None:
    api = people.api
    api.grant("project", people.project, people.member, "comment", people.owner)
    assert people.level(people.member) == "comment"
    comment = api.call("POST", f"/diagrams/{people.diagram}/comments", people.member, json={"body": "looks good"})
    assert comment.status_code == 201
    child_diagram = api.new_diagram(people.child, people.owner, "Child flow")["id"]
    assert people.level(people.member, child_diagram) == "comment"


def test_a_child_project_grant_gives_nothing_on_the_parent_diagram_beyond_view(people: People) -> None:
    people.api.grant("project", people.child, people.member, "edit", people.owner)
    assert people.level(people.member) == "view"


def test_the_highest_source_wins_whether_project_or_diagram_grant_is_higher(people: People) -> None:
    api = people.api
    api.grant("project", people.project, people.member, "edit", people.owner)
    api.grant("diagram", people.diagram, people.member, "view", people.owner)
    assert people.level(people.member) == "edit"

    api.execute("DELETE FROM share_grants WHERE grantee_user_id = :id", id=people.member.id)
    api.grant("project", people.project, people.member, "view", people.owner)
    api.grant("diagram", people.diagram, people.member, "edit", people.owner)
    assert people.level(people.member) == "edit"


def test_a_viewer_given_edit_gets_comment_so_can_comment_but_not_save(people: People) -> None:
    api = people.api
    api.grant("diagram", people.diagram, people.reader, "edit", people.owner)
    assert people.level(people.reader) == "comment"
    assert (
        api.call("POST", f"/diagrams/{people.diagram}/comments", people.reader, json={"body": "a note"}).status_code
        == 201
    )
    assert api.save_diagram(people.reader, people.diagram, "flowchart TD\n  A[x]\n").status_code == 403


def test_a_viewer_with_a_project_grant_is_capped_at_comment_and_cannot_create_diagrams(people: People) -> None:
    people.api.grant("project", people.project, people.reader, "manage", people.owner)
    assert create_status(people.api, people.reader, people.project) == 403


@pytest.mark.parametrize(("level", "saves"), [("view", 403), ("comment", 403), ("edit", 200), ("manage", 200)])
def test_saving_needs_edit_access(people: People, level: str, saves: int) -> None:
    people.api.grant("project", people.project, people.member, level, people.owner)
    assert people.api.save_diagram(people.member, people.diagram, "flowchart TD\n  A[Two]\n").status_code == saves


def test_a_stranger_cannot_save(people: People) -> None:
    assert people.api.save_diagram(people.stranger, people.diagram, "flowchart TD\n  A[Two]\n").status_code == 403


# --- diagram-delete-restore.test.ts -------------------------------------------------------------------


def delete(w: World, who: User | None, diagram: str | None = None) -> int:
    return w.api.call("DELETE", f"/diagrams/{diagram or w.diagram['id']}", who).status_code


@pytest.fixture()
def admin(api: Api) -> User:
    return api.user("admin@example.com", role="admin")


def test_delete_is_refused_for_a_user_who_is_neither_owner_nor_admin(w: World) -> None:
    assert delete(w, w.api.user("other@example.com")) == 403


def test_the_owner_soft_deletes_their_diagram_and_it_is_immediately_not_found(w: World) -> None:
    assert delete(w, w.owner) == 204
    assert w.api.call("GET", f"/diagrams/{w.diagram['id']}", w.owner).status_code == 404
    assert w.api.scalar("SELECT COUNT(*) FROM diagrams WHERE id = :id", id=w.diagram["id"]) == 1


def test_deleting_an_already_deleted_diagram_succeeds_without_changing_when_it_was_deleted(w: World) -> None:
    assert delete(w, w.owner) == 204
    first = w.api.scalar("SELECT deleted_at FROM diagrams WHERE id = :id", id=w.diagram["id"])
    assert delete(w, w.owner) == 204
    assert w.api.scalar("SELECT deleted_at FROM diagrams WHERE id = :id", id=w.diagram["id"]) == first


def test_delete_of_a_diagram_that_does_not_exist_is_a_404(w: World) -> None:
    assert delete(w, w.owner, MISSING_ID) == 404


def test_delete_requires_authentication(w: World) -> None:
    assert delete(w, None) == 401


def test_a_deleted_diagram_leaves_project_search_and_the_project_tree(w: World) -> None:
    delete(w, w.owner)
    assert w.api.call("GET", f"/projects/{w.project}/diagrams", w.owner).json()["diagrams"] == []
    assert w.api.call("GET", f"/projects/{w.project}/tree", w.owner).json()["tree"]["diagrams"] == []


def test_an_admin_deletes_a_diagram_they_do_not_own(w: World, admin: User) -> None:
    assert delete(w, admin) == 204


def test_a_non_admin_cannot_list_or_restore_deleted_diagrams(w: World) -> None:
    delete(w, w.owner)
    assert w.api.call("GET", "/admin/deleted-diagrams", w.owner).status_code == 403
    assert w.api.call("POST", f"/diagrams/{w.diagram['id']}/restore", w.owner).status_code == 403


def test_the_deleted_list_has_metadata_only_never_the_content(w: World, admin: User) -> None:
    delete(w, w.owner)
    response = w.api.call("GET", "/admin/deleted-diagrams", admin)
    assert response.status_code == 200
    entries = response.json()["diagrams"]
    assert len(entries) == 1
    assert (
        entries[0] | {"id": w.diagram["id"], "name": "Original Name", "ownerId": w.owner.id, "projectId": w.project}
        == entries[0]
    )
    assert "dslContent" not in entries[0]
    assert "deletedAt" in entries[0]


def test_an_admin_restores_a_deleted_diagram_and_it_records_who_and_when(w: World, admin: User) -> None:
    delete(w, w.owner)
    restored = w.api.call("POST", f"/diagrams/{w.diagram['id']}/restore", admin)
    assert restored.status_code == 200
    assert restored.json()["diagram"]["id"] == w.diagram["id"]
    assert w.api.call("GET", f"/diagrams/{w.diagram['id']}", w.owner).status_code == 200

    row = w.api.scalar("SELECT restored_at FROM diagrams WHERE id = :id", id=w.diagram["id"])
    assert row is not None
    assert w.api.scalar("SELECT restored_by_user_id FROM diagrams WHERE id = :id", id=w.diagram["id"]) is not None
    assert str(w.api.scalar("SELECT restored_by_user_id FROM diagrams WHERE id = :id", id=w.diagram["id"])) == admin.id
    assert w.api.scalar("SELECT deleted_at FROM diagrams WHERE id = :id", id=w.diagram["id"]) is None


def test_restoring_past_the_retention_window_is_a_409(w: World, admin: User) -> None:
    delete(w, w.owner)
    w.api.execute(
        "UPDATE diagrams SET deleted_at = :at WHERE id = :id",
        at=_db(w.api, datetime.now().astimezone() - timedelta(days=31)),
        id=w.diagram["id"],
    )
    response = w.api.call("POST", f"/diagrams/{w.diagram['id']}/restore", admin)
    assert response.status_code == 409
    assert "no longer available" in response.json()["error"].lower()


def test_a_diagram_past_the_retention_window_is_no_longer_listed(w: World, admin: User) -> None:
    delete(w, w.owner)
    w.api.execute(
        "UPDATE diagrams SET deleted_at = :at WHERE id = :id",
        at=_db(w.api, datetime.now().astimezone() - timedelta(days=31)),
        id=w.diagram["id"],
    )
    assert w.api.call("GET", "/admin/deleted-diagrams", admin).json()["diagrams"] == []


def test_restoring_a_diagram_that_was_never_deleted_is_a_404(w: World, admin: User) -> None:
    assert w.api.call("POST", f"/diagrams/{w.diagram['id']}/restore", admin).status_code == 404


def test_restoring_a_diagram_that_does_not_exist_is_a_404(w: World, admin: User) -> None:
    assert w.api.call("POST", f"/diagrams/{MISSING_ID}/restore", admin).status_code == 404


# --- diagram-delete-restore.test.ts: the deleted-diagrams listing (canvas-23t.3) ----------------------


@dataclass
class Bin:
    api: Api
    admin: User
    alice: User
    bob: User
    apollo: str
    zeta: str

    def deleted(self, name: str, project: str, who: User, minutes_ago: int = 0) -> str:
        diagram = self.api.new_diagram(project, who, name)["id"]
        assert self.api.call("DELETE", f"/diagrams/{diagram}", who).status_code == 204
        # Spread the deletions apart so the newest-first order doesn't depend on the clock's resolution.
        at = datetime.now().astimezone() - timedelta(minutes=minutes_ago)
        self.api.execute("UPDATE diagrams SET deleted_at = :at WHERE id = :id", at=_db(self.api, at), id=diagram)
        return diagram

    def search(self, q: str) -> list[str]:
        response = self.api.call("GET", "/admin/deleted-diagrams", self.admin, params={"q": q})
        assert response.status_code == 200
        return [d["id"] for d in response.json()["diagrams"]]


@pytest.fixture()
def bin_(api: Api, owner: User, admin: User) -> Bin:
    alice = api.user("alice@example.com", name="Alice Anderson")
    bob = api.user("bob@example.com", name="Bob Baker")
    return Bin(api, admin, alice, bob, api.project(alice, "Project Apollo"), api.project(bob, "Project Zeta"))


def test_the_deleted_list_resolves_owner_and_project_names(bin_: Bin) -> None:
    diagram = bin_.deleted("Flowchart One", bin_.apollo, bin_.alice)
    entries = bin_.api.call("GET", "/admin/deleted-diagrams", bin_.admin).json()["diagrams"]
    entry = next(d for d in entries if d["id"] == diagram)
    assert (
        entry
        | {
            "ownerId": bin_.alice.id,
            "ownerName": "Alice Anderson",
            "projectId": bin_.apollo,
            "projectName": "Project Apollo",
        }
        == entry
    )


def test_the_deleted_list_searches_diagram_owner_and_project_names(bin_: Bin) -> None:
    flowchart_one = bin_.deleted("Flowchart One", bin_.apollo, bin_.alice)
    diagram_two = bin_.deleted("Diagram Two", bin_.zeta, bin_.bob)
    assert bin_.search("Flowchart") == [flowchart_one]
    assert bin_.search("Bob Baker") == [diagram_two]
    assert bin_.search("Zeta") == [diagram_two]
    # Case-insensitive substring; no match is an empty list, not an error.
    assert bin_.search("apollo") == [flowchart_one]
    assert bin_.search("zzzznomatch") == []


def test_the_deleted_list_caps_at_the_limit_newest_first_and_says_when_there_is_more(bin_: Bin) -> None:
    one = bin_.deleted("Diagram One", bin_.apollo, bin_.alice, minutes_ago=3)
    two = bin_.deleted("Diagram Two", bin_.apollo, bin_.alice, minutes_ago=2)
    three = bin_.deleted("Diagram Three", bin_.apollo, bin_.alice, minutes_ago=1)

    capped = bin_.api.call("GET", "/admin/deleted-diagrams?limit=2", bin_.admin)
    assert capped.status_code == 200
    assert [d["id"] for d in capped.json()["diagrams"]] == [three, two]
    assert capped.json()["hasMore"] is True

    uncapped = bin_.api.call("GET", "/admin/deleted-diagrams?limit=10", bin_.admin).json()
    assert [d["id"] for d in uncapped["diagrams"]] == [three, two, one]
    assert uncapped["hasMore"] is False


# --- diagram-draft.test.ts ----------------------------------------------------------------------------


@pytest.fixture()
def drafting(api: Api, owner: User) -> World:
    project = api.project(owner, "Shared")
    return World(api, owner, project, api.new_diagram(project, owner, "AI drawn", draft=True))


def test_a_draft_is_in_no_list_and_only_its_creator_can_open_it(drafting: World, admin: User) -> None:
    w, draft = drafting, drafting.diagram
    assert draft["draft"] is True
    assert w.api.call("GET", f"/diagrams/{draft['id']}", w.owner).status_code == 200
    assert w.api.call("GET", f"/diagrams/{draft['id']}", admin).status_code == 404

    tree = w.api.call("GET", f"/projects/{w.project}/tree", w.owner)
    assert draft["id"] not in tree.text
    search = w.api.call("GET", f"/projects/{w.project}/diagrams?query=AI", w.owner)
    assert draft["id"] not in search.text
    projects = w.api.call("GET", "/projects", w.owner).json()["projects"]
    assert next(p for p in projects if p["id"] == w.project)["diagramCount"] == 0


def test_a_draft_becomes_an_ordinary_diagram_on_its_first_save(drafting: World, admin: User) -> None:
    w, draft = drafting, drafting.diagram
    saved = w.api.save_diagram(w.owner, draft, "flowchart TD\n  A[Start]\n", draft["currentVersionId"])
    assert saved.status_code == 200
    assert saved.json()["diagram"]["draft"] is False
    assert w.api.call("GET", f"/diagrams/{draft['id']}", admin).status_code == 200
    assert draft["id"] in w.api.call("GET", f"/projects/{w.project}/tree", w.owner).text


def test_discarding_a_draft_deletes_it_outright_not_into_the_recycle_bin(drafting: World, admin: User) -> None:
    w, draft = drafting, drafting.diagram
    assert w.api.call("DELETE", f"/diagrams/{draft['id']}", w.owner).status_code == 204
    assert w.api.scalar("SELECT COUNT(*) FROM diagrams WHERE id = :id", id=draft["id"]) == 0
    assert w.api.scalar("SELECT COUNT(*) FROM diagram_versions WHERE diagram_id = :id", id=draft["id"]) == 0
    bin_list = w.api.call("GET", "/admin/deleted-diagrams", admin)
    assert bin_list.status_code == 200
    assert draft["id"] not in bin_list.text


def test_nobody_else_can_delete_or_change_a_draft(drafting: World, admin: User) -> None:
    w, draft = drafting, drafting.diagram
    assert w.api.call("DELETE", f"/diagrams/{draft['id']}", admin).status_code == 404
    assert w.api.save_diagram(admin, draft, "flowchart TD\n  X[Admin]\n", draft["currentVersionId"]).status_code == 404
    assert w.api.scalar("SELECT COUNT(*) FROM diagrams WHERE id = :id", id=draft["id"]) == 1


# --- timestamps-iso.test.ts ---------------------------------------------------------------------------


def test_a_new_diagram_and_its_version_history_report_timestamps_in_utc(api: Api, owner: User) -> None:
    diagram = api.new_diagram(api.project(owner, "P"), owner, "D", dsl="flowchart TD\n  A[Start]\n")

    def nowish(value: object, label: str) -> None:
        assert isinstance(value, str), label
        assert JS_ISO.match(value), f"{label}: {value}"
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        # Parsed the way a browser would: within a minute of now, whatever the machine's time zone.
        assert abs(parsed.timestamp() - time.time()) < 60, label

    nowish(diagram["createdAt"], "diagram.createdAt")
    nowish(diagram["updatedAt"], "diagram.updatedAt")
    fetched = api.call("GET", f"/diagrams/{diagram['id']}", owner).json()["diagram"]
    nowish(fetched["createdAt"], "GET diagram createdAt")
    nowish(fetched["updatedAt"], "GET diagram updatedAt")
    versions = api.call("GET", f"/diagrams/{diagram['id']}/versions", owner).json()["versions"]
    assert versions
    for version in versions:
        nowish(version["createdAt"], "version createdAt")
    nowish(
        api.save_diagram(owner, diagram, "flowchart TD\n  A[Two]\n").json()["diagram"]["updatedAt"], "saved updatedAt"
    )


# --- standards.test.ts / standards-v2.test.ts: a saved diagram records its validation ----------------------

V2_RULES = {
    "requireKnownKinds": True,
    "connectorPolicy": "listed-only",
    "elementKinds": [
        {"id": "step", "label": "Step", "shapes": ["rectangle"], "approvedFills": ["#dbeafe"], "minCount": 2},
        {"id": "decision", "label": "Decision", "shapes": ["diamond"], "approvedFills": [], "maxCount": 3},
    ],
    "connectorRules": [
        {"id": "flow", "label": "Flow", "from": "step", "to": "*", "lineStyles": ["solid"], "maxPerSource": 2}
    ],
    "severityOverrides": {"kind-min-count": "error", "unknown-kind": "error"},
    "guidance": "Every step flows onward.",
}


def test_a_diagram_that_violates_the_published_standard_is_flagged_but_still_saved(api: Api, owner: User) -> None:
    api.published_standard("flowchart", allowed_shapes=["rectangle"], version=3)
    diagram = api.new_diagram(
        api.project(owner, "Test Project"), owner, "Violating Diagram", dsl="flowchart TD\n  A((Circle Not Allowed))\n"
    )
    flagged = [v for v in diagram["lastValidationResult"] if v["elementId"] == "A" and v["rule"] == "allowed-shapes"]
    assert flagged
    assert diagram["standardVersionAtLastCheck"] == 3
    assert (
        api.call("GET", f"/diagrams/{diagram['id']}", owner).json()["diagram"]["lastValidationResult"]
        == (diagram["lastValidationResult"])
    )


def test_saving_records_the_validation_against_the_current_standard(api: Api, owner: User) -> None:
    api.published_standard("flowchart", allowed_shapes=["rectangle"], version=2)
    diagram = api.new_diagram(api.project(owner), owner, "D", dsl="flowchart TD\n  A[Fine]\n")
    assert diagram["lastValidationResult"] == []
    assert diagram["standardVersionAtLastCheck"] == 2

    saved = api.save_diagram(owner, diagram, "flowchart TD\n  A((Round))\n", diagram["currentVersionId"])
    assert saved.status_code == 200
    result = saved.json()["diagram"]["lastValidationResult"]
    assert [(v["rule"], v["elementId"]) for v in result] == [("allowed-shapes", "A")]


def test_a_diagram_of_a_type_with_no_published_standard_records_no_check(api: Api, owner: User) -> None:
    api.standard("flowchart", status="draft")
    diagram = api.new_diagram(api.project(owner), owner, "D")
    assert diagram["lastValidationResult"] == []
    assert diagram["standardVersionAtLastCheck"] is None


def test_v2_violations_are_flagged_with_the_overridden_severity(api: Api, owner: User) -> None:
    api.diagram_type("value-chain", name="Value Chain")
    api.published_standard("value-chain", kind_rules=V2_RULES)
    # `class <ids> <kind>` gives a node its element kind; B has none and requireKnownKinds is on.
    diagram = api.new_diagram(
        api.project(owner), owner, "D", "value-chain", dsl="flowchart TD\n  A --> B\n  class A step\n"
    )
    result = diagram["lastValidationResult"]
    assert any(
        v["rule"] == "kind-min-count" and v["severity"] == "error" and v["elementId"] == "(diagram)" for v in result
    )
    assert any(v["rule"] == "unknown-kind" and v["severity"] == "error" and v["elementId"] == "B" for v in result)


# --- helpers ------------------------------------------------------------------------------------------


def _db(api: Api, when: datetime) -> object:
    return to_db(when, api.dialect)
