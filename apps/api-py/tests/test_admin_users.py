"""Admin users, the audit log, the admin overview and the user lookup (phase 3, canvas-1bty.7): the cases of
apps/api/tests/contract/admin-users, role-change, user-deletion, user-search and the parts of
lockout-and-audit, local-user-management and mfa that call GET /admin/users, PATCH /admin/users/:id,
DELETE /admin/users/:id or GET /admin/audit. Every response is also checked against the API contract
(tests/api.py).

Left out (those routes, or sign-in, haven't moved; seeded in the database instead where a case needs the effect):
- admin-users: createLocalUser with personas (POST /admin/users), the persona change reaching /auth/me.
- role-change: signing in again to see the new role (/auth/local/login, /auth/me): the session ending is
  checked through GET /projects, which has moved.
- user-deletion: "frees the email for a new account" (POST /admin/users), versions the user authored
  (GET /diagrams/:id/versions), sign-in refused after deletion, update/unlock/reset-password/reset-mfa on a
  deleted user (only PATCH and deletion-impact have moved), GET /diagrams/:id by the transfer target and grantee.
- lockout-and-audit: lockout, rate limit, unlock, every audit event that sign-in or password changes write, and
  "never stores a password" (all need sign-in or POST routes). A locked account is seeded (locked_at set).
- local-user-management / mfa: creating users, resetting passwords or two-step verification, enrolling. The
  `locked`, `hasPassword` and `mfaEnabled` flags of GET /admin/users are checked from seeded rows.
- GET /users/lookup has no TypeScript test; the cases here follow the route (apps/api/src/admin/user-lookup.routes.ts).
Audit ordering depends on timestamps, so events it depends on are seeded at explicit instants.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from tests.api import MISSING_ID, T0, Api, User, minutes_after

MISSING_USER = "00000000-0000-4000-8000-000000000000"


@pytest.fixture()
def admin(api: Api) -> User:
    api.diagram_type("flowchart")
    return api.user("admin@example.com", role="admin", name="Admin")


@pytest.fixture()
def architect(api: Api, admin: User) -> User:
    return api.user("architect@example.com", name="Architect")


def patch(api: Api, who: User, user_id: str, body: object) -> Any:
    return api.call("PATCH", f"/admin/users/{user_id}", who, json=body)


def listed(api: Api, who: User) -> list[dict[str, Any]]:
    users: list[dict[str, Any]] = api.call("GET", "/admin/users", who).json()["users"]
    return users


def signed_in(api: Api, who: User) -> bool:
    """Whether the user's session still works (GET /projects has moved; 401 once the session is revoked)."""
    status = api.call("GET", "/projects", who).status_code
    assert status in (200, 401), status
    return status == 200


# --- admin-users.test.ts -----------------------------------------------------------------------------


def test_rejects_a_non_admin_from_listing_users(api: Api, architect: User) -> None:
    response = api.call("GET", "/admin/users", architect)
    assert response.status_code == 403
    assert response.json() == {"error": "This action requires one of the following roles: admin"}


def test_the_admin_routes_need_sign_in(api: Api, admin: User) -> None:
    for method, url in (
        ("GET", "/admin/users"),
        ("PATCH", f"/admin/users/{admin.id}"),
        ("GET", f"/admin/users/{admin.id}/deletion-impact"),
        ("DELETE", f"/admin/users/{admin.id}"),
        ("GET", "/admin/audit"),
        ("GET", "/admin/overview"),
    ):
        response = api.call(method, url, json={} if method == "PATCH" else None)
        assert response.status_code == 401, f"{method} {url}"


def test_lists_users_for_an_admin_by_name_with_the_account_flags(api: Api, admin: User, architect: User) -> None:
    [first, second] = listed(api, admin)
    assert first == {
        "id": admin.id,
        "name": "Admin",
        "email": "admin@example.com",
        "role": "admin",
        "personas": [],
        "active": True,
        "hasPassword": False,
        "locked": False,
        "mfaEnabled": False,
    }
    assert second["email"] == "architect@example.com"


def test_promotes_a_user_to_admin(api: Api, admin: User, architect: User) -> None:
    response = patch(api, admin, architect.id, {"role": "admin"})
    assert response.status_code == 200
    assert response.json()["user"]["role"] == "admin"


def test_deactivates_a_user(api: Api, admin: User, architect: User) -> None:
    response = patch(api, admin, architect.id, {"active": False})
    assert response.status_code == 200
    assert response.json()["user"]["active"] is False


def test_sets_personas_without_touching_role_or_active(api: Api, admin: User, architect: User) -> None:
    response = patch(api, admin, architect.id, {"personas": ["Solution", "Technical"]})
    assert response.status_code == 200
    user = response.json()["user"]
    assert (user["role"], user["active"], user["personas"]) == ("architect", True, ["Solution", "Technical"])


def test_an_empty_update_changes_nothing_and_succeeds(api: Api, admin: User, architect: User) -> None:
    response = patch(api, admin, architect.id, {})
    assert response.status_code == 200
    assert response.json()["user"]["role"] == "architect"


def test_updating_an_unknown_user_is_404(api: Api, admin: User) -> None:
    response = patch(api, admin, MISSING_USER, {"role": "viewer"})
    assert response.status_code == 404
    assert response.json() == {"error": f"No user with id {MISSING_USER}"}


@pytest.mark.parametrize("body", [{"role": "owner"}, {"active": "yes"}, {"role": 3}])
def test_rejects_a_malformed_update(api: Api, admin: User, architect: User, body: dict[str, Any]) -> None:
    assert patch(api, admin, architect.id, body).status_code == 400


def test_sets_replaces_and_clears_personas_and_the_user_list_reflects_each_change(
    api: Api, admin: User, architect: User
) -> None:
    def personas() -> list[str]:
        return next(u for u in listed(api, admin) if u["id"] == architect.id)["personas"]  # type: ignore[no-any-return]

    assert patch(api, admin, architect.id, {"personas": ["Business", "Enterprise"]}).json()["user"]["personas"] == [
        "Business",
        "Enterprise",
    ]
    assert personas() == ["Business", "Enterprise"]
    assert patch(api, admin, architect.id, {"personas": ["Technical"]}).json()["user"]["personas"] == ["Technical"]
    assert personas() == ["Technical"]
    cleared = patch(api, admin, architect.id, {"personas": []})
    assert cleared.status_code == 200
    assert cleared.json()["user"]["personas"] == []
    assert personas() == []


def test_accepts_all_four_personas_in_the_order_given(api: Api, admin: User, architect: User) -> None:
    everyone = ["Business", "Enterprise", "Solution", "Technical"]
    assert patch(api, admin, architect.id, {"personas": everyone}).json()["user"]["personas"] == everyone
    assert patch(api, admin, architect.id, {"personas": ["Technical", "Business"]}).json()["user"]["personas"] == [
        "Technical",
        "Business",
    ]


@pytest.mark.parametrize(
    "bad",
    [
        ["Wizard"],
        ["Business", "Business"],
        ["Business", "Enterprise", "Solution", "Technical", "Business"],
        "Business",
        [1],
        ["business"],
    ],
)
def test_rejects_an_unknown_persona_a_duplicate_five_items_or_a_non_array_changing_nothing(
    api: Api, admin: User, architect: User, bad: object
) -> None:
    patch(api, admin, architect.id, {"personas": ["Solution"]})
    assert patch(api, admin, architect.id, {"personas": bad}).status_code == 400
    assert next(u for u in listed(api, admin) if u["id"] == architect.id)["personas"] == ["Solution"]


def test_returns_an_aggregated_overview_for_the_admin_console(api: Api, admin: User, architect: User) -> None:
    api.library("generic", "1", [])
    api.standard("flowchart", "published", 1)
    api.standard("flowchart", "draft", 2)
    response = api.call("GET", "/admin/overview", admin)
    assert response.status_code == 200
    assert response.json() == {
        "overview": {"userCount": 2, "standardsCount": 2, "publishedStandardsCount": 1, "libraryCount": 1}
    }


def test_the_overview_is_admin_only(api: Api, architect: User) -> None:
    assert api.call("GET", "/admin/overview", architect).status_code == 403


# --- the flags of GET /admin/users (lockout-and-audit, local-user-management, mfa) -------------------


def test_the_user_list_reports_locked(api: Api, admin: User) -> None:
    victim = api.user("victim@example.com")
    other = api.user("viewer@example.com", role="viewer")
    api.credentials(victim, locked=True)
    api.credentials(other)
    by_email = {u["email"]: u for u in listed(api, admin)}
    assert by_email["victim@example.com"]["locked"] is True
    assert by_email["viewer@example.com"]["locked"] is False


def test_the_user_list_reports_has_password_per_user(api: Api, admin: User) -> None:
    with_password = api.user("haspw@example.com")
    api.user("nopw@example.com", role="viewer")
    api.credentials(with_password)
    by_email = {u["email"]: u["hasPassword"] for u in listed(api, admin)}
    assert by_email == {"admin@example.com": False, "haspw@example.com": True, "nopw@example.com": False}


def test_the_user_list_reports_mfa_enabled_only_once_enrolment_is_confirmed(api: Api, admin: User) -> None:
    enrolled = api.user("ann@example.com")
    pending = api.user("pending@example.com")
    api.user("viewer@example.com", role="viewer")
    api.mfa(enrolled)
    api.mfa(pending, enabled=False)
    by_email = {u["email"]: u["mfaEnabled"] for u in listed(api, admin)}
    assert by_email == {
        "admin@example.com": False,
        "ann@example.com": True,
        "pending@example.com": False,
        "viewer@example.com": False,
    }


# --- role-change.test.ts -----------------------------------------------------------------------------


def test_a_demoted_admins_existing_session_loses_admin_access_at_once(api: Api) -> None:
    boss = api.user("boss@example.com", role="admin")
    second = api.user("second@example.com", role="admin")
    assert api.call("GET", "/admin/users", second).status_code == 200

    assert patch(api, boss, second.id, {"role": "viewer"}).status_code == 200
    ended = api.call("GET", "/admin/users", second)
    assert ended.status_code == 401  # the session ended; it wasn't merely downgraded
    assert ended.json() == {"error": "Authentication required"}


def test_a_promotion_also_ends_the_session(api: Api) -> None:
    boss = api.user("boss@example.com", role="admin")
    viewer = api.user("v@example.com", role="viewer")
    assert signed_in(api, viewer)
    assert patch(api, boss, viewer.id, {"role": "architect"}).status_code == 200
    assert not signed_in(api, viewer)


def test_a_personas_only_change_keeps_the_session(api: Api) -> None:
    boss = api.user("boss@example.com", role="admin")
    user = api.user("u@example.com")
    assert patch(api, boss, user.id, {"personas": ["Technical"]}).status_code == 200
    assert signed_in(api, user)


def test_a_role_change_ends_their_sessions_but_re_saving_the_same_role_does_not(api: Api, admin: User) -> None:
    stayer = api.user("stayer@example.com")
    patch(api, admin, stayer.id, {"role": "architect"})
    assert signed_in(api, stayer)  # unchanged role
    patch(api, admin, stayer.id, {"role": "viewer"})
    assert not signed_in(api, stayer)


def test_deactivating_a_user_ends_their_sessions(api: Api, admin: User) -> None:
    leaver = api.user("leaver@example.com")
    assert signed_in(api, leaver)
    assert patch(api, admin, leaver.id, {"active": False}).status_code == 200
    assert not signed_in(api, leaver)


def test_the_last_active_admin_cannot_be_demoted_or_deactivated_including_by_themselves(api: Api) -> None:
    boss = api.user("boss@example.com", role="admin")
    demote = patch(api, boss, boss.id, {"role": "architect"})
    assert demote.status_code == 409
    assert demote.json() == {"error": "This is the only active admin -- make someone else an admin first."}
    assert patch(api, boss, boss.id, {"active": False}).status_code == 409
    # Nothing changed, and the session survives.
    assert signed_in(api, boss)
    assert listed(api, boss)[0]["role"] == "admin"


def test_with_another_active_admin_an_admin_can_step_down_and_an_inactive_admin_does_not_count(api: Api) -> None:
    boss = api.user("boss@example.com", role="admin")
    other = api.user("other@example.com", role="admin")
    assert patch(api, boss, other.id, {"active": False}).status_code == 200
    # other is inactive, so boss is the last ACTIVE admin.
    assert patch(api, boss, boss.id, {"role": "viewer"}).status_code == 409
    # Reactivate other; now boss may step down (and is signed out by it).
    assert patch(api, boss, other.id, {"active": True}).status_code == 200
    assert patch(api, boss, boss.id, {"role": "viewer"}).status_code == 200
    assert not signed_in(api, boss)


def test_an_update_is_audited_with_the_fields_the_admin_sent(api: Api, admin: User, architect: User) -> None:
    patch(api, admin, architect.id, {"role": "viewer", "active": True})
    [event] = [e for e in audit(api, admin) if e["event"] == "user_updated"]
    assert event["actorEmail"] == "admin@example.com"
    assert event["targetEmail"] == "architect@example.com"
    assert event["detail"] == {"role": "viewer", "active": True}


# --- user-deletion.test.ts ---------------------------------------------------------------------------


@dataclass
class Doomed:
    user: User
    project: str
    archived_project: str
    diagram: str
    trashed: str
    admin_project: str


def build_world(api: Api, admin: User, doomed: User, grantee: User) -> Doomed:
    """The doomed user's world: projects (one soft-deleted), diagrams (one soft-deleted), shares both ways,
    two-step verification, credentials, personas."""
    project = api.project(doomed, "Doomed project")
    archived = api.project(doomed, "Doomed archived project")
    api.execute("UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = :id", id=archived)
    diagram = api.diagram(project, doomed, "Live")
    trashed = api.diagram(project, doomed, "Trashed", deleted=True)
    api.grant("diagram", diagram, grantee, "view", doomed)  # gave a share
    admin_project = api.project(admin, "Admin project")
    api.grant("project", admin_project, doomed, "view", admin)  # received a share
    api.mfa(doomed)
    api.credentials(doomed)
    api.execute("INSERT INTO users_personas (user_id, persona, position) VALUES (:id, 'Business', 0)", id=doomed.id)
    return Doomed(doomed, project, archived, diagram, trashed, admin_project)


@pytest.fixture()
def cast(api: Api, admin: User) -> dict[str, User]:
    return {
        "doomed": api.user("doomed@example.com", name="Doomed Dan"),
        "target": api.user("target@example.com", name="Target Tess"),
        "grantee": api.user("grantee@example.com", role="viewer"),
    }


def delete(api: Api, who: User, user_id: str, body: object = None) -> Any:
    return api.call("DELETE", f"/admin/users/{user_id}", who, json=body)


def project_owner(api: Api, project_id: str) -> str:
    return str(api.scalar("SELECT owner_id FROM projects WHERE id = :id", id=project_id))


def diagram_owner(api: Api, diagram_id: str) -> str:
    return str(api.scalar("SELECT owner_id FROM diagrams WHERE id = :id", id=diagram_id))


def test_deletion_impact_counts_owned_projects_and_diagrams_soft_deleted_included_and_shares_received(
    api: Api, admin: User, cast: dict[str, User]
) -> None:
    build_world(api, admin, cast["doomed"], cast["grantee"])
    response = api.call("GET", f"/admin/users/{cast['doomed'].id}/deletion-impact", admin)
    assert response.status_code == 200
    assert response.json() == {"ownedProjects": 2, "ownedDiagrams": 2, "sharesReceived": 1, "isLastActiveAdmin": False}


def test_deletion_impact_flags_the_last_active_admin_and_not_once_there_is_another(
    api: Api, admin: User, cast: dict[str, User]
) -> None:
    assert api.call("GET", f"/admin/users/{admin.id}/deletion-impact", admin).json()["isLastActiveAdmin"] is True
    patch(api, admin, cast["target"].id, {"role": "admin"})
    assert api.call("GET", f"/admin/users/{admin.id}/deletion-impact", admin).json()["isLastActiveAdmin"] is False


def test_deletion_impact_is_admin_only_and_404_for_an_unknown_user(
    api: Api, admin: User, cast: dict[str, User]
) -> None:
    url = f"/admin/users/{cast['doomed'].id}/deletion-impact"
    assert api.call("GET", url, cast["target"]).status_code == 403
    assert api.call("GET", url).status_code == 401
    assert api.call("GET", f"/admin/users/{MISSING_USER}/deletion-impact", admin).status_code == 404


def test_transfers_everything_keeps_history_and_removes_access(api: Api, admin: User, cast: dict[str, User]) -> None:
    doomed, target, grantee = cast["doomed"], cast["target"], cast["grantee"]
    w = build_world(api, admin, doomed, grantee)
    response = delete(api, admin, doomed.id, {"transferToUserId": target.id})
    assert response.status_code == 200
    assert response.json() == {"deleted": True, "transferredProjects": 2, "transferredDiagrams": 2}

    # The target owns it all, soft-deleted rows included, and can open the live ones.
    assert api.scalar("SELECT COUNT(*) FROM projects WHERE owner_id = :id", id=doomed.id) == 0
    assert api.scalar("SELECT COUNT(*) FROM diagrams WHERE owner_id = :id", id=doomed.id) == 0
    assert project_owner(api, w.archived_project) == target.id
    assert diagram_owner(api, w.trashed) == target.id
    assert api.call("GET", f"/projects/{w.project}/tree", target).status_code == 200

    # Shares they received are gone; shares they gave remain.
    assert api.scalar("SELECT COUNT(*) FROM share_grants WHERE grantee_user_id = :id", id=doomed.id) == 0
    given_by = api.scalar(
        "SELECT granted_by_user_id FROM share_grants WHERE subject_id = :id AND grantee_user_id = :g",
        id=w.diagram,
        g=grantee.id,
    )
    assert str(given_by) == doomed.id
    assert api.call("GET", f"/diagrams/{w.diagram}/shares", grantee).json()["grants"][0]["granteeUserId"] == grantee.id

    # Credentials, two-step verification and personas are gone.
    assert api.scalar("SELECT COUNT(*) FROM local_credentials WHERE user_id = :id", id=doomed.id) == 0
    assert api.scalar("SELECT COUNT(*) FROM user_mfa WHERE user_id = :id", id=doomed.id) == 0
    assert api.scalar("SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = :id", id=doomed.id) == 0
    assert api.scalar("SELECT COUNT(*) FROM users_personas WHERE user_id = :id", id=doomed.id) == 0

    # The row is an anonymised, inactive placeholder.
    assert api.scalar("SELECT name FROM users WHERE id = :id", id=doomed.id) == "Deleted user"
    assert api.scalar("SELECT email FROM users WHERE id = :id", id=doomed.id) == f"deleted-{doomed.id}@deleted.invalid"
    assert api.scalar("SELECT deleted_at FROM users WHERE id = :id", id=doomed.id) is not None
    assert not api.scalar("SELECT active FROM users WHERE id = :id", id=doomed.id)


def test_deleting_a_user_ends_their_sessions(api: Api, admin: User, cast: dict[str, User]) -> None:
    doomed = cast["doomed"]
    build_world(api, admin, doomed, cast["grantee"])
    assert signed_in(api, doomed)
    delete(api, admin, doomed.id, {"transferToUserId": cast["target"].id})
    assert not signed_in(api, doomed)


def test_a_deleted_user_disappears_from_the_users_list_and_the_overview_count_and_is_audited(
    api: Api, admin: User, cast: dict[str, User]
) -> None:
    doomed, target = cast["doomed"], cast["target"]
    before = api.call("GET", "/admin/overview", admin).json()["overview"]["userCount"]
    delete(api, admin, doomed.id, {"transferToUserId": target.id})
    users = listed(api, admin)
    assert not [u for u in users if u["id"] == doomed.id]
    assert "Deleted user" not in str(users)
    assert api.call("GET", "/admin/overview", admin).json()["overview"]["userCount"] == before - 1

    [entry] = [e for e in audit(api, admin, "?limit=100") if e["event"] == "user_deleted"]
    assert entry["actorEmail"] == "admin@example.com"
    assert entry["detail"] == {
        "email": "doomed@example.com",
        "name": "Doomed Dan",
        "transferredTo": target.id,
        "transferredToEmail": "target@example.com",
        "projects": 0,
        "diagrams": 0,
        "sharesRemoved": 0,
    }


def test_audits_a_deletion_with_no_transfer_as_transferred_to_null(
    api: Api, admin: User, cast: dict[str, User]
) -> None:
    delete(api, admin, cast["doomed"].id)
    [entry] = [e for e in audit(api, admin, "?limit=100") if e["event"] == "user_deleted"]
    assert entry["detail"]["email"] == "doomed@example.com"
    assert entry["detail"]["transferredTo"] is None
    assert entry["detail"]["transferredToEmail"] is None


def test_refuses_deleting_yourself(api: Api, admin: User, cast: dict[str, User]) -> None:
    patch(api, admin, cast["target"].id, {"role": "admin"})
    response = delete(api, admin, admin.id)
    assert response.status_code == 409
    assert response.json() == {"error": "You can't delete your own account."}


def test_refuses_the_last_active_admin_but_deleting_a_non_last_admin_works(
    api: Api, admin: User, cast: dict[str, User]
) -> None:
    target = cast["target"]
    patch(api, admin, target.id, {"role": "admin"})
    # Two admins: the first may delete the second. (A session's role is fixed at sign-in, so `target`
    # is still an architect in its own session; the delete is the admin's.)
    assert delete(api, admin, target.id).status_code == 200
    # Only `admin` is left, and an admin cannot delete themselves.
    assert delete(api, admin, admin.id).status_code == 409


def test_an_inactive_admin_does_not_count_as_an_active_one(api: Api, admin: User, cast: dict[str, User]) -> None:
    patch(api, admin, cast["target"].id, {"role": "admin", "active": False})
    assert api.call("GET", f"/admin/users/{admin.id}/deletion-impact", admin).json()["isLastActiveAdmin"] is True


def test_needs_a_transfer_target_when_they_own_content(api: Api, admin: User, cast: dict[str, User]) -> None:
    doomed = cast["doomed"]
    build_world(api, admin, doomed, cast["grantee"])
    response = delete(api, admin, doomed.id)
    assert response.status_code == 409
    assert response.json() == {"error": "Choose who receives their projects and diagrams."}
    assert api.scalar("SELECT deleted_at FROM users WHERE id = :id", id=doomed.id) is None


def test_refuses_a_transfer_to_themselves_an_inactive_a_deleted_or_an_unknown_user_and_changes_nothing(
    api: Api, admin: User, cast: dict[str, User]
) -> None:
    doomed, grantee = cast["doomed"], cast["grantee"]
    w = build_world(api, admin, doomed, grantee)
    patch(api, admin, grantee.id, {"active": False})
    ghost = api.user("ghost@example.com")
    assert delete(api, admin, ghost.id).status_code == 200
    messages = {
        doomed.id: "Their content can't be transferred to them.",
        grantee.id: "Transfer to an active user.",
        ghost.id: "Transfer to an active user.",
        MISSING_USER: "Transfer to an active user.",
    }
    for target, message in messages.items():
        response = delete(api, admin, doomed.id, {"transferToUserId": target})
        assert response.status_code == 409, target
        assert response.json() == {"error": message}
    assert project_owner(api, w.project) == doomed.id
    assert signed_in(api, doomed)


def test_deleting_a_user_is_admin_only(api: Api, admin: User, cast: dict[str, User]) -> None:
    assert delete(api, cast["target"], cast["doomed"].id).status_code == 403
    assert api.call("DELETE", f"/admin/users/{cast['doomed'].id}").status_code == 401


def test_404s_for_an_unknown_user_and_for_one_already_deleted(api: Api, admin: User, cast: dict[str, User]) -> None:
    assert delete(api, admin, MISSING_USER).status_code == 404
    assert delete(api, admin, cast["doomed"].id).status_code == 200
    assert delete(api, admin, cast["doomed"].id).status_code == 404


def test_a_user_who_owns_nothing_needs_no_transfer(api: Api, admin: User, cast: dict[str, User]) -> None:
    response = delete(api, admin, cast["doomed"].id)
    assert response.status_code == 200
    assert response.json() == {"deleted": True, "transferredProjects": 0, "transferredDiagrams": 0}


def test_a_user_with_no_local_credentials_can_be_deleted_too(api: Api, admin: User) -> None:
    sso = api.user("sso@example.com", role="viewer")
    assert api.call("GET", f"/admin/users/{sso.id}/deletion-impact", admin).status_code == 200
    assert delete(api, admin, sso.id).status_code == 200
    assert api.scalar("SELECT email FROM users WHERE id = :id", id=sso.id) == f"deleted-{sso.id}@deleted.invalid"


def test_a_deleted_user_is_not_found_by_update_or_deletion_impact(api: Api, admin: User, cast: dict[str, User]) -> None:
    doomed = cast["doomed"]
    delete(api, admin, doomed.id)
    assert patch(api, admin, doomed.id, {"role": "viewer"}).status_code == 404
    assert api.call("GET", f"/admin/users/{doomed.id}/deletion-impact", admin).status_code == 404


def test_a_deleted_user_is_not_reactivated_by_being_marked_active(api: Api, admin: User, cast: dict[str, User]) -> None:
    doomed = cast["doomed"]
    delete(api, admin, doomed.id)
    patch(api, admin, doomed.id, {"active": True})
    assert not api.scalar("SELECT active FROM users WHERE id = :id", id=doomed.id)


# --- user-search.test.ts -----------------------------------------------------------------------------


@pytest.fixture()
def searcher(api: Api) -> User:
    return api.user("viewer@example.com", role="viewer", name="Searcher Viewer")


def search(api: Api, q: str | None, who: User | None) -> Any:
    return api.call("GET", "/users/search", who, params=None if q is None else {"q": q})


def found(api: Api, q: str, who: User) -> list[str]:
    response = search(api, q, who)
    assert response.status_code == 200
    return [u["name"] for u in response.json()["users"]]


def test_search_rejects_an_anonymous_request(api: Api) -> None:
    assert search(api, "x", None).status_code == 401


def test_search_lets_a_viewer_search(api: Api, searcher: User) -> None:
    api.user("zed@example.com", name="Zed Zebra")
    response = search(api, "zebra", searcher)
    assert response.status_code == 200
    assert len(response.json()["users"]) == 1


def test_matches_by_name_substring_and_by_email_substring_case_insensitively(api: Api, searcher: User) -> None:
    api.user("one@example.com", name="Alice McDonald")
    api.user("Bob.Smith@Contoso.COM", name="Robert")
    assert found(api, "mcdon", searcher) == ["Alice McDonald"]
    assert found(api, "MCDONALD", searcher) == ["Alice McDonald"]
    assert found(api, "bob.smith@contoso", searcher) == ["Robert"]
    assert found(api, "CONTOSO.com", searcher) == ["Robert"]
    assert found(api, "nobody-matches-this", searcher) == []


def test_never_returns_a_deactivated_user(api: Api, searcher: User) -> None:
    gone = api.user("gone@example.com", name="Gone Person")
    assert found(api, "gone", searcher) == ["Gone Person"]
    api.execute("UPDATE users SET active = :no WHERE id = :id", no=False, id=gone.id)
    assert found(api, "gone", searcher) == []


def test_search_orders_by_name_then_email(api: Api, searcher: User) -> None:
    api.user("b2@ord.test", name="Bravo")
    api.user("b1@ord.test", name="Bravo")
    api.user("c@ord.test", name="Charlie")
    api.user("a@ord.test", name="Alpha")
    users = search(api, "ord.test", searcher).json()["users"]
    assert [u["email"] for u in users] == ["a@ord.test", "b1@ord.test", "b2@ord.test", "c@ord.test"]


def test_returns_at_most_20_of_25_matches_the_first_20_by_name(api: Api, searcher: User) -> None:
    for i in range(25):
        api.user(f"bulk{i:02d}@many.test", name=f"Bulk {i:02d}")
    users = search(api, "many.test", searcher).json()["users"]
    assert len(users) == 20
    assert users[0]["name"] == "Bulk 00"
    assert users[19]["name"] == "Bulk 19"


def test_treats_percent_underscore_and_backslash_in_q_literally(api: Api, searcher: User) -> None:
    api.user("u1@wild.test", name="a_b")
    api.user("u2@wild.test", name="axb")
    api.user("u3@wild.test", name="a100%b")
    api.user("u4@wild.test", name="back\\slash")
    assert found(api, "a_b", searcher) == ["a_b"]  # `_` is not "any one char" (would also match axb)
    assert found(api, "a%b", searcher) == []  # `%` is not "anything"
    assert found(api, "100%", searcher) == ["a100%b"]
    assert found(api, "%", searcher) == ["a100%b"]
    assert found(api, "k\\s", searcher) == ["back\\slash"]
    assert found(api, "\\", searcher) == ["back\\slash"]


def test_validates_q_missing_empty_and_101_chars_are_400_whitespace_only_is_an_empty_list(
    api: Api, searcher: User
) -> None:
    assert search(api, None, searcher).status_code == 400
    assert search(api, "", searcher).status_code == 400
    assert search(api, "a" * 101, searcher).status_code == 400
    assert search(api, "a" * 100, searcher).status_code == 200
    blank = search(api, "   ", searcher)
    assert blank.status_code == 200
    assert blank.json() == {"users": []}


def test_search_returns_only_id_name_and_email(api: Api, searcher: User) -> None:
    api.user("shape@example.com", name="Shape Check", role="admin")
    [user] = search(api, "shape check", searcher).json()["users"]
    assert sorted(user) == ["email", "id", "name"]


# --- GET /users/lookup (no TypeScript test; follows the route) ------------------------------------------


def test_looks_up_an_active_user_by_exact_email(api: Api, searcher: User) -> None:
    target = api.user("find.me@example.com", name="Find Me")
    response = api.call("GET", "/users/lookup", searcher, params={"email": "find.me@example.com"})
    assert response.status_code == 200
    assert response.json() == {"user": {"id": target.id, "name": "Find Me", "email": "find.me@example.com"}}


def test_a_lookup_that_finds_nobody_or_only_a_deactivated_user_answers_null(api: Api, searcher: User) -> None:
    gone = api.user("gone@example.com")
    api.execute("UPDATE users SET active = :no WHERE id = :id", no=False, id=gone.id)
    for email in ("nobody@example.com", "gone@example.com", "FIND@example.com"):
        response = api.call("GET", "/users/lookup", searcher, params={"email": email})
        assert response.json() == {"user": None}, email


def test_lookup_needs_an_email_and_a_session(api: Api, searcher: User) -> None:
    assert api.call("GET", "/users/lookup", searcher).status_code == 400
    assert api.call("GET", "/users/lookup", searcher, params={"email": ""}).status_code == 400
    assert api.call("GET", "/users/lookup", None, params={"email": "a@b.c"}).status_code == 401


# --- GET /admin/audit (lockout-and-audit.test.ts) -----------------------------------------------------


def audit(api: Api, admin: User, query: str = "") -> list[dict[str, Any]]:
    response = api.call("GET", f"/admin/audit{query}", admin)
    assert response.status_code == 200, response.text
    events: list[dict[str, Any]] = response.json()["events"]
    return events


def seed_sign_ins(api: Api, emails: list[str]) -> None:
    """One failed sign-in per email, a minute apart, oldest first."""
    for i, email in enumerate(emails):
        api.audit_event(
            "sign_in_failed",
            at=minutes_after(T0, i),
            ip="203.0.113.9",
            detail={"reason": "unknown_email", "email": email},
        )


def test_audit_is_admin_only(api: Api, admin: User, architect: User) -> None:
    refused = api.call("GET", "/admin/audit", architect)
    assert refused.status_code == 403
    assert api.call("GET", "/admin/audit").status_code == 401


def test_audit_lists_events_with_actor_and_target_emails_the_ip_and_detail(
    api: Api, admin: User, architect: User
) -> None:
    api.audit_event("account_unlocked", actor=admin, target=architect, at=T0, ip="198.51.100.4", detail={"by": "admin"})
    api.audit_event("sign_in_failed", at=minutes_after(T0, -1), detail={"reason": "unknown_email", "email": "x@y.z"})
    [unlocked, failed] = audit(api, admin)
    assert unlocked["event"] == "account_unlocked"
    assert unlocked["actorEmail"] == "admin@example.com"
    assert unlocked["targetEmail"] == "architect@example.com"
    assert unlocked["ip"] == "198.51.100.4"
    assert unlocked["detail"] == {"by": "admin"}
    assert unlocked["occurredAt"] == "2026-01-01T12:00:00.000Z"
    assert failed["actorEmail"] is None and failed["targetEmail"] is None
    assert failed["ip"] is None
    assert failed["detail"] == {"reason": "unknown_email", "email": "x@y.z"}


def test_audit_lists_newest_first(api: Api, admin: User) -> None:
    seed_sign_ins(api, ["first@example.com", "second@example.com"])
    events = audit(api, admin)
    assert [e["detail"]["email"] for e in events] == ["second@example.com", "first@example.com"]


def test_audit_honours_limit_and_rejects_out_of_range_values(api: Api, admin: User) -> None:
    seed_sign_ins(api, [f"u{i}@example.com" for i in range(4)])
    assert len(audit(api, admin, "?limit=2")) == 2
    assert len(audit(api, admin, "?limit=200")) == 4
    for bad in ("0", "201", "abc", "-1", "1.5"):
        assert api.call("GET", f"/admin/audit?limit={bad}", admin).status_code == 400, bad


def test_audit_returns_50_by_default(api: Api, admin: User) -> None:
    seed_sign_ins(api, [f"u{i}@example.com" for i in range(52)])
    assert len(audit(api, admin)) == 50


def test_audit_pages_backwards_with_before(api: Api, admin: User) -> None:
    seed_sign_ins(api, ["a@example.com", "b@example.com", "c@example.com"])
    page1 = audit(api, admin, "?limit=1")
    assert page1[0]["detail"]["email"] == "c@example.com"
    page2 = audit(api, admin, f"?limit=1&before={page1[0]['occurredAt']}")
    assert page2[0]["detail"]["email"] == "b@example.com"
    page3 = audit(api, admin, f"?limit=200&before={page2[0]['occurredAt']}")
    assert [e["detail"]["email"] for e in page3] == ["a@example.com"]


def test_audit_rejects_a_before_that_is_not_a_date_time(api: Api, admin: User) -> None:
    assert api.call("GET", "/admin/audit?before=yesterday", admin).status_code == 400


def test_audit_filters_by_user_id_on_either_side_of_the_event(api: Api, admin: User, architect: User) -> None:
    other = api.user("viewer@example.com", role="viewer")
    api.audit_event("sign_in", actor=architect, target=architect, at=minutes_after(T0, 0))
    api.audit_event("sign_in", actor=other, target=other, at=minutes_after(T0, 1))
    api.audit_event("password_reset", actor=admin, target=architect, at=minutes_after(T0, 2))
    events = audit(api, admin, f"?userId={architect.id}&limit=200")
    assert [e["event"] for e in events] == ["password_reset", "sign_in"]  # admin-side events targeting the user too
    assert all("architect@example.com" in (e["targetEmail"], e["actorEmail"]) for e in events)
    assert audit(api, admin, f"?userId={MISSING_ID}") == []
