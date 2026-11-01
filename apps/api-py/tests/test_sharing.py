"""Sharing and project members (phase 3, canvas-1bty.7), the cases of apps/api/tests/contract/sharing,
sharing-authz, share-grants-list, shared-diagrams, project-members and the moved-route parts of
effective-access. Every response is also checked against the API contract (tests/api.py).

Left out:
- GET /diagrams/:id (its accessLevel, and saving with PATCH) hasn't moved. A diagram's effective access is
  read through routes that have: `diagram_level` below asks POST /diagrams/:id/shares for a grantee who
  doesn't exist, which answers 403 with the user's level when it is below Edit and 400 once it is Edit or more.
  Manage is a project level, read from GET /projects/:id/members (`yourAccess`).
- Creating projects/diagrams and deleting a diagram are seeded in the database (those routes haven't moved).
- effective-access.test.ts's "GET /projects lists every project with the caller's level" and the viewer's
  project-level cap: both are in tests/test_projects.py (phase 2). "A viewer cannot create projects/diagrams":
  likewise there, and POST /projects/:id/diagrams hasn't moved.
- shared-diagrams / sharing-authz setup that creates a project through POST /projects: seeded instead.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

import pytest
from sqlalchemy import text

from canvas_api.timestamps import to_db
from tests.api import JS_ISO, MISSING_ID, T0, Api, User, minutes_after


@dataclass
class World:
    api: Api
    project: str
    diagram: str
    owner: User
    admin: User
    editor: User
    commenter: User
    viewer: User
    stranger: User

    def share(self, subject: str, subject_id: str, who: User, grantee: User | str, level: str) -> int:
        grantee_id = grantee if isinstance(grantee, str) else grantee.id
        response = self.api.call(
            "POST", f"/{subject}/{subject_id}/shares", who, json={"granteeUserId": grantee_id, "accessLevel": level}
        )
        return response.status_code

    def grant_rows(self, subject_id: str) -> list[dict[str, Any]]:
        return grant_rows(self.api, subject_id)

    def diagram_level(self, who: User, diagram: str | None = None) -> str:
        """'view', 'comment', or 'edit+' (Edit or Manage), read without changing anything."""
        response = self.api.call(
            "POST",
            f"/diagrams/{diagram or self.diagram}/shares",
            who,
            json={"granteeUserId": MISSING_ID, "accessLevel": "view"},
        )
        if response.status_code == 400:
            return "edit+"
        assert response.status_code == 403, response.text
        found = re.search(r'you only have "(\w+)" access', response.json()["error"])
        assert found, response.text
        return found.group(1)

    def project_level(self, who: User, project: str | None = None) -> str:
        level: str = self.api.call("GET", f"/projects/{project or self.project}/members", who).json()["yourAccess"]
        return level


def grant_rows(api: Api, subject_id: str) -> list[dict[str, Any]]:
    with api.engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT id, grantee_user_id, access_level, granted_by_user_id FROM share_grants"
                " WHERE subject_id = :id ORDER BY id"
            ),
            {"id": subject_id},
        ).all()
    return [
        {"id": str(r.id), "grantee": str(r.grantee_user_id), "level": r.access_level, "by": str(r.granted_by_user_id)}
        for r in rows
    ]


@pytest.fixture()
def w(api: Api) -> World:
    api.diagram_type("flowchart")
    users = {
        "owner": api.user("owner@example.com", name="Owner"),
        "admin": api.user("admin@example.com", role="admin", name="Admin"),
        "editor": api.user("editor@example.com", name="Editor"),
        "commenter": api.user("commenter@example.com", name="Commenter"),
        "viewer": api.user("viewer@example.com", name="Viewer"),
        "stranger": api.user("stranger@example.com", name="Stranger"),
    }
    project = api.project(users["owner"], "Owned")
    diagram = api.diagram(project, users["owner"], "Diagram")
    return World(api, project, diagram, **users)


@pytest.fixture()
def shared(w: World) -> World:
    """w, with the diagram shared at Edit, Comment and View (sharing-authz's beforeEach)."""
    for who, level in ((w.editor, "edit"), (w.commenter, "comment"), (w.viewer, "view")):
        assert w.share("diagrams", w.diagram, w.owner, who, level) == 201
    return w


# --- sharing.test.ts ----------------------------------------------------------------------------------


def test_a_user_with_no_grant_can_view_the_diagram_but_not_edit_it(w: World) -> None:
    assert w.diagram_level(w.stranger) == "view"
    refused = w.api.call(
        "POST",
        f"/diagrams/{w.diagram}/shares",
        w.stranger,
        json={"granteeUserId": w.stranger.id, "accessLevel": "view"},
    )
    assert refused.status_code == 403
    assert refused.json() == {
        "error": 'This action requires "edit" access, but you only have "view" access to this diagram.'
    }


def test_grants_view_access_and_returns_the_grant(w: World) -> None:
    response = w.api.call(
        "POST", f"/diagrams/{w.diagram}/shares", w.owner, json={"granteeUserId": w.stranger.id, "accessLevel": "view"}
    )
    assert response.status_code == 201
    grant = response.json()["grant"]
    assert (
        grant
        | {
            "subjectType": "diagram",
            "subjectId": w.diagram,
            "granteeUserId": w.stranger.id,
            "accessLevel": "view",
            "grantedByUserId": w.owner.id,
        }
        == grant
    )
    assert w.diagram_level(w.stranger) == "view"  # view is what everyone has; edit is still refused


def test_upgrading_the_grant_to_edit_updates_it_in_place_and_allows_what_was_blocked(w: World) -> None:
    assert w.share("diagrams", w.diagram, w.owner, w.stranger, "view") == 201
    assert w.share("diagrams", w.diagram, w.owner, w.stranger, "edit") == 201
    rows = [r for r in w.grant_rows(w.diagram) if r["grantee"] == w.stranger.id]
    assert [r["level"] for r in rows] == ["edit"]
    assert w.diagram_level(w.stranger) == "edit+"


def test_a_lower_diagram_grant_does_not_hide_a_higher_project_grant(w: World) -> None:
    assert w.share("projects", w.project, w.owner, w.stranger, "edit") == 201
    assert w.share("diagrams", w.diagram, w.owner, w.stranger, "view") == 201
    assert w.diagram_level(w.stranger) == "edit+"  # project-level edit beats diagram-level view


def test_revoking_a_grant_removes_access_again_back_to_view(w: World) -> None:
    created = w.api.call(
        "POST", f"/diagrams/{w.diagram}/shares", w.owner, json={"granteeUserId": w.stranger.id, "accessLevel": "edit"}
    )
    grant_id = created.json()["grant"]["id"]
    assert w.diagram_level(w.stranger) == "edit+"

    revoked = w.api.call("DELETE", f"/shares/{grant_id}", w.owner)
    assert revoked.status_code == 204
    assert revoked.content == b""
    assert w.diagram_level(w.stranger) == "view"


def test_rejects_sharing_to_a_non_existent_user(w: World) -> None:
    response = w.api.call(
        "POST", f"/diagrams/{w.diagram}/shares", w.owner, json={"granteeUserId": MISSING_ID, "accessLevel": "view"}
    )
    assert response.status_code == 400
    assert response.json() == {"error": f"No active user with id {MISSING_ID}"}


def test_rejects_sharing_to_a_deactivated_user(w: World) -> None:
    w.api.execute("UPDATE users SET active = :no WHERE id = :id", no=False, id=w.stranger.id)
    assert w.share("diagrams", w.diagram, w.owner, w.stranger, "view") == 400
    assert w.grant_rows(w.diagram) == []


@pytest.mark.parametrize(
    "payload", [{}, {"granteeUserId": "", "accessLevel": "view"}, {"granteeUserId": "x", "accessLevel": "owner"}]
)
def test_rejects_a_malformed_share(w: World, payload: dict[str, str]) -> None:
    assert w.api.call("POST", f"/diagrams/{w.diagram}/shares", w.owner, json=payload).status_code == 400


def test_a_nonexistent_diagram_404s_rather_than_403ing_through_the_access_layer(w: World) -> None:
    response = w.api.call("GET", f"/diagrams/{MISSING_ID}/shares", w.owner)
    assert response.status_code == 404
    assert response.json() == {"error": f"No diagram with id {MISSING_ID}"}


# --- sharing-authz.test.ts --------------------------------------------------------------------------


def test_someone_without_edit_access_cannot_grant_anyone_themselves_included_access(shared: World) -> None:
    for who in (shared.stranger, shared.viewer, shared.commenter):
        assert shared.share("diagrams", shared.diagram, who, who, "edit") == 403, who.email
    rows = shared.grant_rows(shared.diagram)
    assert not [r for r in rows if r["grantee"] == shared.stranger.id]
    assert [r["level"] for r in rows if r["grantee"] == shared.viewer.id] == ["view"]
    assert [r["level"] for r in rows if r["grantee"] == shared.commenter.id] == ["comment"]


@pytest.mark.parametrize("who", ["owner", "admin", "editor"])
def test_the_owner_an_admin_and_an_editor_can_share_a_diagram(shared: World, who: str) -> None:
    assert shared.share("diagrams", shared.diagram, getattr(shared, who), shared.stranger, "view") == 201


def test_anyone_signed_in_can_see_a_diagrams_share_list(shared: World) -> None:
    for who in (shared.stranger, shared.viewer, shared.commenter, shared.editor, shared.owner, shared.admin):
        assert shared.api.call("GET", f"/diagrams/{shared.diagram}/shares", who).status_code == 200, who.email


def test_revoking_a_diagram_share_needs_edit_access_to_the_diagram(shared: World) -> None:
    viewer_grant = next(r for r in shared.grant_rows(shared.diagram) if r["grantee"] == shared.viewer.id)
    for who in (shared.stranger, shared.viewer, shared.commenter):
        refused = shared.api.call("DELETE", f"/shares/{viewer_grant['id']}", who)
        assert refused.status_code == 403, who.email
        assert refused.json() == {"error": "Only someone with edit access can remove a share."}
    assert any(r["id"] == viewer_grant["id"] for r in shared.grant_rows(shared.diagram))
    assert shared.api.call("DELETE", f"/shares/{viewer_grant['id']}", shared.editor).status_code == 204
    assert not any(r["id"] == viewer_grant["id"] for r in shared.grant_rows(shared.diagram))


def test_a_missing_diagram_or_grant_is_404_and_no_grant_is_created_on_it(shared: World) -> None:
    missing = "00000000-0000-4000-8000-000000000000"
    assert shared.share("diagrams", missing, shared.admin, shared.stranger, "view") == 404
    assert shared.api.call("GET", f"/diagrams/{missing}/shares", shared.admin).status_code == 404
    assert shared.grant_rows(missing) == []
    revoked = shared.api.call("DELETE", f"/shares/{missing}", shared.admin)
    assert revoked.status_code == 404
    assert revoked.json() == {"error": f"No share grant with id {missing}"}


def test_a_deleted_diagram_cannot_be_shared(shared: World) -> None:
    shared.api.execute("UPDATE diagrams SET deleted_at = CURRENT_TIMESTAMP WHERE id = :id", id=shared.diagram)
    assert shared.share("diagrams", shared.diagram, shared.owner, shared.stranger, "view") == 404
    assert shared.api.call("GET", f"/diagrams/{shared.diagram}/shares", shared.owner).status_code == 404


def test_signed_out_requests_to_the_share_routes_are_401(shared: World) -> None:
    body = {"granteeUserId": shared.stranger.id, "accessLevel": "edit"}
    assert shared.api.call("POST", f"/diagrams/{shared.diagram}/shares", json=body).status_code == 401
    assert shared.api.call("GET", f"/diagrams/{shared.diagram}/shares").status_code == 401
    assert shared.api.call("DELETE", f"/shares/{MISSING_ID}").status_code == 401


def test_only_someone_with_manage_access_to_the_project_can_share_it_or_revoke_anyone_can_list(shared: World) -> None:
    # A stranger has no grant: open read lets them list, not share.
    assert shared.share("projects", shared.project, shared.stranger, shared.stranger, "edit") == 403
    assert shared.api.call("GET", f"/projects/{shared.project}/shares", shared.stranger).status_code == 200
    assert shared.share("projects", shared.project, shared.owner, shared.viewer, "view") == 201
    # A project viewer can list but not share or revoke.
    assert shared.api.call("GET", f"/projects/{shared.project}/shares", shared.viewer).status_code == 200
    assert shared.share("projects", shared.project, shared.viewer, shared.stranger, "view") == 403
    grant = next(r for r in shared.grant_rows(shared.project) if r["grantee"] == shared.viewer.id)
    refused = shared.api.call("DELETE", f"/shares/{grant['id']}", shared.viewer)
    assert refused.status_code == 403
    assert refused.json() == {"error": "Only the owner or someone with Manage access can remove a member."}
    assert shared.api.call("DELETE", f"/shares/{grant['id']}", shared.admin).status_code == 204


def test_sharing_a_missing_project_is_404(shared: World) -> None:
    missing = "00000000-0000-4000-8000-000000000000"
    response = shared.api.call(
        "POST",
        f"/projects/{missing}/shares",
        shared.admin,
        json={"granteeUserId": shared.stranger.id, "accessLevel": "view"},
    )
    assert response.status_code == 404
    assert response.json() == {"error": f"No project with id {missing}"}
    assert shared.grant_rows(missing) == []


# --- share-grants-list.test.ts ------------------------------------------------------------------------


def test_the_share_list_names_each_grantee_in_grant_creation_order(w: World) -> None:
    first = w.api.user("first@example.com", name="First Grantee")
    second = w.api.user("second@example.com", name="Second Grantee")
    # Seeded with explicit times: two grants made in one request burst can share a timestamp.
    w.api.grant("diagram", w.diagram, second, "edit", w.owner)
    w.api.grant("diagram", w.diagram, first, "view", w.owner)
    w.api.execute("UPDATE share_grants SET created_at = :at WHERE grantee_user_id = :id", at=_at(w.api, 0), id=first.id)
    w.api.execute(
        "UPDATE share_grants SET created_at = :at WHERE grantee_user_id = :id", at=_at(w.api, 1), id=second.id
    )

    grants = w.api.call("GET", f"/diagrams/{w.diagram}/shares", w.owner).json()["grants"]
    assert len(grants) == 2
    assert (
        grants[0]
        | {
            "granteeUserId": first.id,
            "accessLevel": "view",
            "granteeName": "First Grantee",
            "granteeEmail": "first@example.com",
        }
        == grants[0]
    )
    assert (
        grants[1]
        | {
            "granteeUserId": second.id,
            "accessLevel": "edit",
            "granteeName": "Second Grantee",
            "granteeEmail": "second@example.com",
        }
        == grants[1]
    )


def test_the_share_list_drops_a_grant_when_its_grantee_is_deleted(w: World) -> None:
    first = w.api.user("first@example.com", name="First Grantee")
    second = w.api.user("second@example.com", name="Second Grantee")
    w.api.grant("diagram", w.diagram, first, "view", w.owner)
    w.api.grant("diagram", w.diagram, second, "edit", w.owner)
    assert w.api.call("DELETE", f"/admin/users/{first.id}", w.admin).status_code == 200
    grants = w.api.call("GET", f"/diagrams/{w.diagram}/shares", w.owner).json()["grants"]
    assert [g["granteeUserId"] for g in grants] == [second.id]
    assert grants[0]["granteeName"] == "Second Grantee"


def _at(api: Api, minutes: int) -> object:
    return to_db(minutes_after(T0, minutes), api.dialect)


# --- shared-diagrams.test.ts ------------------------------------------------------------------------


def test_shows_a_diagram_shared_directly_with_a_user_who_has_no_project_access_at_all(w: World) -> None:
    project = w.api.project(w.owner, "Confidential Merger")
    diagram = w.api.diagram(project, w.owner, "Payment Flow")
    assert w.share("diagrams", diagram, w.owner, w.stranger, "view") == 201

    response = w.api.call("GET", "/shared-diagrams", w.stranger)
    assert response.status_code == 200
    [entry] = response.json()["diagrams"]
    assert entry["diagramId"] == diagram
    assert entry["diagramName"] == "Payment Flow"
    assert entry["diagramTypeId"] == "flowchart"
    assert entry["accessLevel"] == "view"
    assert entry["projectName"] == "Confidential Merger"
    assert entry["sharedByName"] == "Owner"
    assert entry["sharedByEmail"] == "owner@example.com"
    assert entry["sharedAt"]


def test_includes_a_diagram_even_when_the_user_also_has_a_lower_project_grant(w: World) -> None:
    assert w.share("projects", w.project, w.owner, w.stranger, "view") == 201
    assert w.share("diagrams", w.diagram, w.owner, w.stranger, "edit") == 201
    [entry] = w.api.call("GET", "/shared-diagrams", w.stranger).json()["diagrams"]
    assert entry["accessLevel"] == "edit"


def test_stops_naming_a_diagram_once_its_grant_is_revoked(w: World) -> None:
    created = w.api.call(
        "POST", f"/diagrams/{w.diagram}/shares", w.owner, json={"granteeUserId": w.stranger.id, "accessLevel": "view"}
    )
    assert len(w.api.call("GET", "/shared-diagrams", w.stranger).json()["diagrams"]) == 1
    w.api.call("DELETE", f"/shares/{created.json()['grant']['id']}", w.owner)
    assert w.api.call("GET", "/shared-diagrams", w.stranger).json()["diagrams"] == []


def test_stops_naming_a_diagram_once_it_is_soft_deleted(w: World) -> None:
    assert w.share("diagrams", w.diagram, w.owner, w.stranger, "view") == 201
    w.api.execute("UPDATE diagrams SET deleted_at = CURRENT_TIMESTAMP WHERE id = :id", id=w.diagram)
    assert w.api.call("GET", "/shared-diagrams", w.stranger).json()["diagrams"] == []


def test_never_names_an_ancestor_project_only_the_immediate_one(w: World) -> None:
    parent = w.api.project(w.owner, "Parent Project")
    child = w.api.project(w.owner, "Child Project", parent=parent)
    diagram = w.api.diagram(child, w.owner, "Nested Diagram")
    assert w.share("diagrams", diagram, w.owner, w.stranger, "view") == 201
    response = w.api.call("GET", "/shared-diagrams", w.stranger)
    assert response.json()["diagrams"][0]["projectName"] == "Child Project"
    assert "Parent Project" not in response.text


def test_an_unsaved_draft_is_not_listed_as_shared(w: World) -> None:
    draft = w.api.diagram(w.project, w.owner, "Draft", draft=True)
    w.api.grant("diagram", draft, w.stranger, "view", w.owner)
    assert w.api.call("GET", "/shared-diagrams", w.stranger).json()["diagrams"] == []


def test_lists_shared_diagrams_by_name(w: World) -> None:
    for name in ("Zulu", "Alpha", "Mike"):
        w.api.grant("diagram", w.api.diagram(w.project, w.owner, name), w.stranger, "view", w.owner)
    listed = w.api.call("GET", "/shared-diagrams", w.stranger).json()["diagrams"]
    assert [d["diagramName"] for d in listed] == ["Alpha", "Mike", "Zulu"]


def test_an_empty_shared_list_is_an_empty_list_not_an_error(w: World) -> None:
    response = w.api.call("GET", "/shared-diagrams", w.stranger)
    assert response.status_code == 200
    assert response.json() == {"diagrams": []}


def test_the_shared_list_requires_authentication(w: World) -> None:
    assert w.api.call("GET", "/shared-diagrams").status_code == 401


# --- project-members.test.ts -------------------------------------------------------------------------


@pytest.fixture()
def team(api: Api) -> World:
    """project-members' cast: owner, a Manage member, an Edit member, a newcomer, a viewer-role reader, an admin."""
    api.diagram_type("flowchart")
    users = {
        "owner": api.user("owner@example.com", name="Owner"),
        "admin": api.user("admin@example.com", role="admin", name="Admin"),
        "editor": api.user("editor@example.com", name="Editor"),
        "commenter": api.user("manager@example.com", name="Manager"),  # the Manage member
        "viewer": api.user("reader@example.com", role="viewer", name="Reader"),
        "stranger": api.user("newbie@example.com", name="Newbie"),
    }
    project = api.project(users["owner"], "Payments")
    team = World(api, project, api.diagram(project, users["owner"], "Flow"), **users)
    assert team.share("projects", project, team.owner, team.commenter, "manage") == 201
    assert team.share("projects", project, team.owner, team.editor, "edit") == 201
    return team


def members(team: World, who: User | None = None) -> dict[str, Any]:
    body: dict[str, Any] = team.api.call("GET", f"/projects/{team.project}/members", who or team.owner).json()
    return body


def project_audit(team: World) -> list[dict[str, Any]]:
    with team.api.engine.connect() as conn:
        rows = conn.execute(
            text("SELECT event, target_user_id, detail FROM audit_events WHERE event LIKE 'project\\_%' ESCAPE '\\'")
        ).all()
    return [{"event": r.event, "target": str(r.target_user_id), "detail": json.loads(r.detail)} for r in rows]


def test_lists_the_owner_and_members_with_names_to_anyone_who_can_read_the_project(team: World) -> None:
    listed = members(team, team.stranger)
    assert listed["owner"] == {"id": team.owner.id, "name": "Owner", "email": "owner@example.com"}
    assert [(m["name"], m["accessLevel"]) for m in listed["members"]] == [("Editor", "edit"), ("Manager", "manage")]
    assert listed["members"][0]["userId"] == team.editor.id
    assert listed["members"][0]["email"] == "editor@example.com"
    assert listed["members"][0]["grantId"]
    assert listed["yourAccess"] == "view"
    assert members(team, team.commenter)["yourAccess"] == "manage"


def test_the_member_list_of_a_missing_project_is_404(team: World) -> None:
    response = team.api.call("GET", f"/projects/{MISSING_ID}/members", team.owner)
    assert response.status_code == 404


def test_owner_manage_members_and_admins_add_change_and_remove_members_editors_cannot(team: World) -> None:
    newbie = team.stranger
    assert team.share("projects", team.project, team.editor, newbie, "view") == 403
    assert team.share("projects", team.project, team.commenter, newbie, "view") == 201
    assert team.share("projects", team.project, team.admin, newbie, "comment") == 201
    grant = next(m for m in members(team)["members"] if m["userId"] == newbie.id)
    assert grant["accessLevel"] == "comment"
    assert team.api.call("DELETE", f"/shares/{grant['grantId']}", team.editor).status_code == 403
    assert team.api.call("DELETE", f"/shares/{grant['grantId']}", team.commenter).status_code == 204
    assert not [m for m in members(team)["members"] if m["userId"] == newbie.id]


def test_audits_each_change_added_changed_with_the_old_level_removed(team: World) -> None:
    newbie = team.stranger
    team.share("projects", team.project, team.owner, newbie, "view")
    team.share("projects", team.project, team.owner, newbie, "edit")
    team.share("projects", team.project, team.owner, newbie, "edit")  # no change, no entry
    grant = next(m for m in members(team)["members"] if m["userId"] == newbie.id)
    team.api.call("DELETE", f"/shares/{grant['grantId']}", team.owner)

    events = [e for e in project_audit(team) if e["target"] == newbie.id]
    assert sorted(e["event"] for e in events) == [
        "project_member_added",
        "project_member_changed",
        "project_member_removed",
    ]
    changed = next(e for e in events if e["event"] == "project_member_changed")
    assert changed["detail"] == {"projectId": team.project, "level": "edit", "from": "view"}
    removed = next(e for e in events if e["event"] == "project_member_removed")
    assert removed["detail"] == {"projectId": team.project, "from": "edit"}


def test_the_owner_hands_over_the_new_owner_leaves_the_member_list_and_the_old_one_stays_as_manage(team: World) -> None:
    response = team.api.call("POST", f"/projects/{team.project}/owner", team.owner, json={"newOwnerId": team.editor.id})
    assert response.status_code == 200
    listed = response.json()
    assert listed["owner"]["id"] == team.editor.id
    assert not [m for m in listed["members"] if m["userId"] == team.editor.id]
    old = next(m for m in listed["members"] if m["userId"] == team.owner.id)
    assert old["accessLevel"] == "manage"
    [project] = team.api.call("GET", "/projects", team.editor).json()["projects"]
    assert (project["accessLevel"], project["membership"]) == ("manage", "owner")
    transferred = [e for e in project_audit(team) if e["event"] == "project_owner_transferred"]
    assert [(e["target"], e["detail"]) for e in transferred] == [
        (team.editor.id, {"projectId": team.project, "from": team.owner.id})
    ]


def test_handing_a_project_to_its_current_owner_changes_nothing(team: World) -> None:
    response = team.api.call("POST", f"/projects/{team.project}/owner", team.owner, json={"newOwnerId": team.owner.id})
    assert response.status_code == 200
    assert response.json()["owner"]["id"] == team.owner.id
    assert [e for e in project_audit(team) if e["event"] == "project_owner_transferred"] == []


def test_only_the_owner_or_an_admin_can_transfer_ownership_manage_members_cannot(team: World) -> None:
    refused = team.api.call(
        "POST", f"/projects/{team.project}/owner", team.commenter, json={"newOwnerId": team.commenter.id}
    )
    assert refused.status_code == 403
    assert refused.json() == {"error": "Only this project's owner or an admin can do that."}
    assert (
        team.api.call(
            "POST", f"/projects/{team.project}/owner", team.admin, json={"newOwnerId": team.stranger.id}
        ).status_code
        == 200
    )
    assert members(team)["owner"]["id"] == team.stranger.id


def test_refuses_a_viewer_or_an_unknown_user_as_the_new_owner(team: World) -> None:
    viewer = team.api.call("POST", f"/projects/{team.project}/owner", team.owner, json={"newOwnerId": team.viewer.id})
    assert viewer.status_code == 400
    assert viewer.json() == {"error": "A viewer can only read and comment, so they cannot own a project."}
    unknown = team.api.call(
        "POST",
        f"/projects/{team.project}/owner",
        team.owner,
        json={"newOwnerId": "00000000-0000-4000-8000-000000000000"},
    )
    assert unknown.status_code == 400
    assert members(team)["owner"]["id"] == team.owner.id


def test_transferring_a_missing_project_is_404(team: World) -> None:
    response = team.api.call("POST", f"/projects/{MISSING_ID}/owner", team.admin, json={"newOwnerId": team.editor.id})
    assert response.status_code == 404


def test_a_diagram_shared_with_a_project_member_at_that_level_is_not_listed_again_under_shared_with_me(
    team: World,
) -> None:
    assert team.share("diagrams", team.diagram, team.owner, team.editor, "comment") == 201
    assert team.share("diagrams", team.diagram, team.owner, team.stranger, "comment") == 201
    assert team.api.call("GET", "/shared-diagrams", team.editor).json()["diagrams"] == []  # covered by project Edit
    assert len(team.api.call("GET", "/shared-diagrams", team.stranger).json()["diagrams"]) == 1  # not a member


def test_a_diagram_shared_above_a_members_project_level_is_still_listed(team: World) -> None:
    assert team.share("projects", team.project, team.owner, team.stranger, "view") == 201
    assert team.share("diagrams", team.diagram, team.owner, team.stranger, "edit") == 201
    [entry] = team.api.call("GET", "/shared-diagrams", team.stranger).json()["diagrams"]
    assert entry["accessLevel"] == "edit"


# --- effective-access.test.ts (the routes that have moved) ---------------------------------------------


@pytest.fixture()
def eff(api: Api) -> World:
    """effective-access's cast: owner, 'author' (Edit on the project, owns the diagram), member, stranger,
    a viewer-role reader, an admin. World's editor is the author, commenter the member, viewer the reader."""
    api.diagram_type("flowchart")
    users = {
        "owner": api.user("owner@example.com"),
        "admin": api.user("admin@example.com", role="admin"),
        "editor": api.user("author@example.com"),
        "commenter": api.user("member@example.com"),
        "viewer": api.user("reader@example.com", role="viewer"),
        "stranger": api.user("stranger@example.com"),
    }
    project = api.project(users["owner"], "Payments")
    api.grant("project", project, users["editor"], "edit", users["owner"])
    diagram = api.diagram(project, users["editor"], "Flow")
    return World(api, project, diagram, **users)


def test_everyone_signed_in_can_read_everything_at_view_and_view_cannot_comment(eff: World) -> None:
    assert eff.diagram_level(eff.stranger) == "view"
    assert eff.api.call("GET", f"/projects/{eff.project}/tree", eff.stranger).status_code == 200
    assert (
        eff.api.call("POST", f"/diagrams/{eff.diagram}/comments", eff.stranger, json={"body": "hi"}).status_code == 403
    )


def test_owning_the_diagram_owning_its_project_and_being_an_admin_each_give_manage(eff: World) -> None:
    assert eff.diagram_level(eff.editor) == "edit+"  # owns the diagram
    assert eff.diagram_level(eff.owner) == "edit+"  # owns the project
    assert eff.diagram_level(eff.admin) == "edit+"
    assert eff.project_level(eff.owner) == "manage"
    assert eff.project_level(eff.admin) == "manage"
    assert eff.project_level(eff.editor) == "edit"  # but the author's own grant is only Edit on the project


def test_a_project_grant_covers_its_diagrams_and_its_child_projects(eff: World) -> None:
    child = eff.api.project(eff.owner, "Payments child", parent=eff.project)
    assert eff.share("projects", eff.project, eff.owner, eff.commenter, "comment") == 201
    assert eff.diagram_level(eff.commenter) == "comment"
    assert (
        eff.api.call(
            "POST", f"/diagrams/{eff.diagram}/comments", eff.commenter, json={"body": "looks good"}
        ).status_code
        == 201
    )
    child_diagram = eff.api.diagram(child, eff.owner, "Child flow")
    assert eff.diagram_level(eff.commenter, child_diagram) == "comment"
    assert eff.project_level(eff.commenter, child) == "comment"


def test_a_child_project_grant_gives_nothing_on_the_parent_beyond_view(eff: World) -> None:
    child = eff.api.project(eff.owner, "Payments child", parent=eff.project)
    assert eff.share("projects", child, eff.owner, eff.commenter, "edit") == 201
    assert eff.diagram_level(eff.commenter) == "view"
    assert eff.project_level(eff.commenter) == "view"
    assert eff.project_level(eff.commenter, child) == "edit"


def test_the_highest_source_wins_whichever_of_project_or_diagram_grant_is_higher(eff: World) -> None:
    eff.share("projects", eff.project, eff.owner, eff.commenter, "edit")
    eff.share("diagrams", eff.diagram, eff.owner, eff.commenter, "view")
    assert eff.diagram_level(eff.commenter) == "edit+"

    eff.share("projects", eff.project, eff.owner, eff.commenter, "view")
    eff.share("diagrams", eff.diagram, eff.owner, eff.commenter, "edit")
    assert eff.diagram_level(eff.commenter) == "edit+"


def test_a_viewer_given_edit_gets_comment_they_can_comment_but_not_share(eff: World) -> None:
    eff.share("diagrams", eff.diagram, eff.owner, eff.viewer, "edit")
    assert eff.diagram_level(eff.viewer) == "comment"
    assert (
        eff.api.call("POST", f"/diagrams/{eff.diagram}/comments", eff.viewer, json={"body": "a note"}).status_code
        == 201
    )
    assert eff.share("diagrams", eff.diagram, eff.viewer, eff.stranger, "view") == 403


def test_the_viewer_role_caps_project_access_too(eff: World) -> None:
    eff.share("projects", eff.project, eff.owner, eff.viewer, "manage")
    assert eff.project_level(eff.viewer) == "comment"
    assert eff.share("projects", eff.project, eff.viewer, eff.stranger, "view") == 403


def test_manage_is_a_project_level_only(eff: World) -> None:
    assert eff.share("projects", eff.project, eff.owner, eff.commenter, "manage") == 201
    assert eff.share("diagrams", eff.diagram, eff.owner, eff.commenter, "manage") == 400
    assert eff.project_level(eff.commenter) == "manage"
    assert eff.diagram_level(eff.commenter) == "edit+"


def test_an_editor_cannot_give_manage_promote_themselves_or_demote_a_manager(eff: World) -> None:
    eff.share("projects", eff.project, eff.owner, eff.commenter, "manage")
    # The author has Edit on the project (the fixture).
    assert eff.share("projects", eff.project, eff.editor, eff.stranger, "manage") == 403
    assert eff.share("projects", eff.project, eff.editor, eff.editor, "manage") == 403
    assert eff.share("projects", eff.project, eff.editor, eff.commenter, "view") == 403
    manager_grant = next(
        g
        for g in eff.api.call("GET", f"/projects/{eff.project}/shares", eff.editor).json()["grants"]
        if g["granteeUserId"] == eff.commenter.id
    )
    assert eff.api.call("DELETE", f"/shares/{manager_grant['id']}", eff.editor).status_code == 403
    # Managing a project's members at all needs Manage; an editor can still share a single diagram.
    assert eff.share("projects", eff.project, eff.editor, eff.stranger, "comment") == 403
    assert eff.share("diagrams", eff.diagram, eff.editor, eff.stranger, "comment") == 201


def test_someone_with_manage_can_give_and_remove_manage(eff: World) -> None:
    eff.share("projects", eff.project, eff.owner, eff.commenter, "manage")
    assert eff.share("projects", eff.project, eff.commenter, eff.stranger, "manage") == 201
    grant = next(
        g
        for g in eff.api.call("GET", f"/projects/{eff.project}/shares", eff.commenter).json()["grants"]
        if g["granteeUserId"] == eff.stranger.id
    )
    assert eff.api.call("DELETE", f"/shares/{grant['id']}", eff.commenter).status_code == 204


def test_an_editor_giving_manage_is_told_the_project_needs_manage(eff: World) -> None:
    response = eff.api.call(
        "POST",
        f"/projects/{eff.project}/shares",
        eff.editor,
        json={"granteeUserId": eff.stranger.id, "accessLevel": "manage"},
    )
    assert response.status_code == 403
    assert response.json() == {
        "error": 'This action requires "manage" access, but you only have "edit" access to this project.'
    }


def test_share_timestamps_come_back_as_javascript_iso(eff: World) -> None:
    grant = eff.api.call(
        "POST",
        f"/diagrams/{eff.diagram}/shares",
        eff.owner,
        json={"granteeUserId": eff.stranger.id, "accessLevel": "view"},
    ).json()["grant"]
    assert JS_ISO.match(grant["createdAt"])
