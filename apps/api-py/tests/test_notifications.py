"""canvas-2h2w.4: in-app notifications. Sharing writes them (added, level changed, removed, ownership); GET
/me/notifications lists your own, POST /me/notifications/read marks them read. Every response is checked against
the contract (tests/api.py)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import text

from canvas_api.notifications import NOTIFICATION_LIST_LIMIT, NOTIFICATION_RETENTION_DAYS, purge_old_notifications
from canvas_api.retention import purge_diagrams
from canvas_api.timestamps import now_utc, to_db
from tests.api import Api, User


@pytest.fixture()
def people(api: Api) -> dict[str, User]:
    api.diagram_type("flowchart")
    return {
        "owner": api.user("owner@example.com", name="Olive Owner"),
        "bob": api.user("bob@example.com", name="Bob"),
        "carol": api.user("carol@example.com", name="Carol"),
        "admin": api.user("admin@example.com", role="admin", name="Ada Admin"),
    }


def notifications(api: Api, who: User) -> dict[str, Any]:
    response = api.call("GET", "/me/notifications", who)
    assert response.status_code == 200, response.text
    return response.json()  # type: ignore[no-any-return]


def summary(api: Api, who: User) -> list[tuple[Any, ...]]:
    """(kind, subject type, subject name, level, previous level, actor) per notification, newest first."""
    return [
        (n["kind"], n["subjectType"], n["subjectName"], n["accessLevel"], n["previousLevel"], n["actorName"])
        for n in notifications(api, who)["notifications"]
    ]


def share(api: Api, who: User, subject: str, subject_id: str, grantee: User, level: str) -> dict[str, Any]:
    response = api.call(
        "POST", f"/{subject}/{subject_id}/shares", who, json={"granteeUserId": grantee.id, "accessLevel": level}
    )
    assert response.status_code == 201, response.text
    return response.json()["grant"]  # type: ignore[no-any-return]


def test_being_added_changed_and_removed_on_a_project_notifies_you(api: Api, people: dict[str, User]) -> None:
    owner, bob = people["owner"], people["bob"]
    project = api.project(owner, "Payments")
    grant = share(api, owner, "projects", project, bob, "view")
    share(api, owner, "projects", project, bob, "view")  # the same level again: nothing new
    share(api, owner, "projects", project, bob, "edit")
    assert api.call("DELETE", f"/shares/{grant['id']}", owner).status_code == 204

    assert summary(api, bob) == [
        ("removed", "project", "Payments", None, "edit", "Olive Owner"),
        ("level_changed", "project", "Payments", "edit", "view", "Olive Owner"),
        ("added", "project", "Payments", "view", None, "Olive Owner"),
    ]
    assert notifications(api, bob)["unreadCount"] == 3
    first = notifications(api, bob)["notifications"][-1]
    assert first["subjectId"] == project and first["read"] is False
    # Nobody is told about their own changes.
    assert notifications(api, owner) == {"notifications": [], "unreadCount": 0}


def test_a_diagram_shared_with_you(api: Api, people: dict[str, User]) -> None:
    owner, bob = people["owner"], people["bob"]
    diagram = api.diagram(api.project(owner), owner, "Checkout flow")
    share(api, owner, "diagrams", diagram, bob, "comment")
    [only] = notifications(api, bob)["notifications"]
    assert (only["kind"], only["subjectType"], only["subjectId"], only["subjectName"], only["accessLevel"]) == (
        "added",
        "diagram",
        diagram,
        "Checkout flow",
        "comment",
    )


def test_the_name_is_kept_as_it_was(api: Api, people: dict[str, User]) -> None:
    """After losing access, a later rename mustn't reach someone who can't read the project any more."""
    owner, bob = people["owner"], people["bob"]
    project = api.project(owner, "Secret plan")
    grant = share(api, owner, "projects", project, bob, "view")
    api.call("DELETE", f"/shares/{grant['id']}", owner)
    api.execute("UPDATE projects SET name = 'Renamed' WHERE id = :id", id=project)
    assert [n[2] for n in summary(api, bob)] == ["Secret plan", "Secret plan"]


def test_becoming_a_projects_owner(api: Api, people: dict[str, User]) -> None:
    owner, bob, admin = people["owner"], people["bob"], people["admin"]
    project = api.project(owner, "Handover")
    response = api.call("POST", f"/projects/{project}/owner", admin, json={"newOwnerId": bob.id})
    assert response.status_code == 200, response.text
    assert summary(api, bob) == [("ownership", "project", "Handover", None, None, "Ada Admin")]


def test_refused_changes_notify_nobody(api: Api, people: dict[str, User]) -> None:
    owner, bob, carol = people["owner"], people["bob"], people["carol"]
    project = api.project(owner)
    share(api, owner, "projects", project, bob, "edit")
    # An editor can't add members to a project (that takes Manage).
    response = api.call(
        "POST", f"/projects/{project}/shares", bob, json={"granteeUserId": carol.id, "accessLevel": "view"}
    )
    assert response.status_code == 403
    assert notifications(api, carol)["notifications"] == []


def test_marking_read_one_by_one_or_all(api: Api, people: dict[str, User]) -> None:
    owner, bob, carol = people["owner"], people["bob"], people["carol"]
    for name in ("A", "B", "C"):
        share(api, owner, "projects", api.project(owner, name), bob, "view")
    share(api, owner, "projects", api.project(owner, "D"), carol, "view")
    listed = notifications(api, bob)["notifications"]
    carols = notifications(api, carol)["notifications"]

    # Someone else's id, an unknown one and a malformed one are ignored.
    response = api.call(
        "POST",
        "/me/notifications/read",
        bob,
        json={"ids": [listed[0]["id"], listed[0]["id"], carols[0]["id"], "00000000-0000-0000-0000-000000000000", "x"]},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"unreadCount": 2}
    assert [n["read"] for n in notifications(api, bob)["notifications"]] == [True, False, False]
    assert notifications(api, carol)["unreadCount"] == 1

    response = api.call("POST", "/me/notifications/read", bob)
    assert response.json() == {"unreadCount": 0}
    assert all(n["read"] for n in notifications(api, bob)["notifications"])
    assert notifications(api, carol)["unreadCount"] == 1


def test_signed_out_gets_nothing(api: Api) -> None:
    assert api.call("GET", "/me/notifications").status_code == 401
    assert api.call("POST", "/me/notifications/read").status_code == 401


def test_the_list_is_the_newest_fifty_but_the_count_is_all_unread(api: Api, people: dict[str, User]) -> None:
    owner, bob = people["owner"], people["bob"]
    project = api.project(owner, "Busy")
    levels = ["view", "comment", "edit"]
    for i in range(NOTIFICATION_LIST_LIMIT + 4):
        share(api, owner, "projects", project, bob, levels[i % 3])
    body = notifications(api, bob)
    assert len(body["notifications"]) == NOTIFICATION_LIST_LIMIT
    assert body["unreadCount"] == NOTIFICATION_LIST_LIMIT + 4


def test_purges(api: Api, people: dict[str, User]) -> None:
    owner, bob = people["owner"], people["bob"]
    project = api.project(owner)
    diagram = api.diagram(project, owner, "Gone")
    share(api, owner, "diagrams", diagram, bob, "view")
    share(api, owner, "projects", project, bob, "view")
    # A purged diagram takes its notifications with it.
    purge_diagrams(api.engine, [diagram])
    assert [n[1] for n in summary(api, bob)] == ["project"]
    # Old ones go after the retention window.
    api.execute(
        "UPDATE notifications SET created_at = :at",
        at=to_db(now_utc() - timedelta(days=NOTIFICATION_RETENTION_DAYS + 1), api.dialect),
    )
    with api.engine.begin() as conn:
        assert purge_old_notifications(conn) == 1
    assert summary(api, bob) == []


def test_deleting_a_user_removes_their_notifications(api: Api, people: dict[str, User]) -> None:
    owner, bob, admin = people["owner"], people["bob"], people["admin"]
    share(api, owner, "projects", api.project(owner), bob, "view")
    response = api.call("DELETE", f"/admin/users/{bob.id}", admin)
    assert response.status_code == 200, response.text
    with api.engine.connect() as conn:
        left = conn.execute(text("SELECT COUNT(*) FROM notifications WHERE user_id = :id"), {"id": bob.id}).scalar()
    assert left == 0
