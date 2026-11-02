"""canvas-1bty.13: admin-managed Canvas-password accounts (ports apps/api tests/contract/local-user-management.test.ts
and the admin-side parts of lockout-and-audit.test.ts and mfa.test.ts): create with a one-time password, forced
password change, self-service change, admin reset / unlock, and session teardown on reset and deactivation."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import pytest

from tests.auth_helpers import OTP_FORMAT, Site, seed_user

MISSING_ID = "00000000-0000-4000-8000-000000000000"


class Env:
    def __init__(self, site: Site, admin_cookie: str, admin_id: str) -> None:
        self.site = site
        self.admin_cookie = admin_cookie
        self.admin_id = admin_id

    def create_user(self, email: str, role: str = "architect") -> dict[str, Any]:
        response = self.site.post(
            "/admin/users", {"email": email, "name": "New Person", "role": role}, self.admin_cookie
        )
        assert response.status_code == 201, response.text
        body: dict[str, Any] = response.json()
        return body

    def activated_user(self, email: str, password: str) -> tuple[str, str]:
        """Create a user and complete the forced password change; returns (id, settled cookie)."""
        created = self.create_user(email)
        _, cookie = self.site.login(email, created["temporaryPassword"])
        change = self.site.post(
            "/auth/password", {"currentPassword": created["temporaryPassword"], "newPassword": password}, cookie
        )
        assert change.status_code == 200, change.text
        return created["user"]["id"], cookie


@pytest.fixture()
def env(make_site: Any) -> Iterator[Env]:
    site: Site = make_site(allow_local_auth_setting="true")
    admin_id = seed_user(site.engine, "admin@example.com", "admin-pass", "admin")
    seed_user(site.engine, "architect@example.com", "architect-pass", "architect")
    seed_user(site.engine, "viewer@example.com", "viewer-pass", "viewer")
    _, admin_cookie = site.login("admin@example.com", "admin-pass")
    yield Env(site, admin_cookie, admin_id)


# --- POST /admin/users ----------------------------------------------------------------------------


def test_creates_a_user_and_returns_a_one_time_password(env: Env) -> None:
    response = env.site.post(
        "/admin/users", {"email": "new@example.com", "name": "New Person", "role": "viewer"}, env.admin_cookie
    )
    assert response.status_code == 201
    body = response.json()
    assert OTP_FORMAT.match(body["temporaryPassword"])
    assert body["user"]["email"] == "new@example.com"
    assert body["user"]["name"] == "New Person"
    assert body["user"]["role"] == "viewer"
    assert body["user"]["active"] is True
    assert body["user"]["id"]


def test_creating_a_user_with_personas_keeps_their_order(env: Env) -> None:
    response = env.site.post(
        "/admin/users",
        {"email": "p@example.com", "name": "P", "role": "viewer", "personas": ["Technical", "Business"]},
        env.admin_cookie,
    )
    assert response.status_code == 201
    assert response.json()["user"]["personas"] == ["Technical", "Business"]
    users = env.site.get("/admin/users", env.admin_cookie).json()["users"]
    assert next(u for u in users if u["email"] == "p@example.com")["personas"] == ["Technical", "Business"]


def test_creating_a_user_lowercases_and_trims_the_email(env: Env) -> None:
    response = env.site.post(
        "/admin/users", {"email": "  Mixed.Case@Example.COM ", "name": "M", "role": "viewer"}, env.admin_cookie
    )
    assert response.status_code == 201
    assert response.json()["user"]["email"] == "mixed.case@example.com"


def test_a_duplicate_email_is_409_case_insensitively(env: Env) -> None:
    def create(email: str) -> int:
        return env.site.post(
            "/admin/users", {"email": email, "name": "A", "role": "viewer"}, env.admin_cookie
        ).status_code

    assert create("dup@example.com") == 201
    assert create("DUP@example.com") == 409
    assert create("architect@example.com") == 409


@pytest.mark.parametrize("email", ["not-an-email", "a@b", ""])
def test_an_invalid_email_is_400(env: Env, email: str) -> None:
    response = env.site.post("/admin/users", {"email": email, "name": "X", "role": "viewer"}, env.admin_cookie)
    assert response.status_code == 400


def test_an_unknown_role_is_400(env: Env) -> None:
    response = env.site.post(
        "/admin/users", {"email": "r@example.com", "name": "X", "role": "superuser"}, env.admin_cookie
    )
    assert response.status_code == 400


def test_creating_a_user_is_forbidden_to_architects_and_viewers_and_needs_authentication(env: Env) -> None:
    payload = {"email": "x@example.com", "name": "X", "role": "viewer"}
    _, architect = env.site.login("architect@example.com", "architect-pass")
    _, viewer = env.site.login("viewer@example.com", "viewer-pass")
    assert env.site.post("/admin/users", payload, architect).status_code == 403
    assert env.site.post("/admin/users", payload, viewer).status_code == 403
    assert env.site.post("/admin/users", payload).status_code == 401


def test_the_local_account_routes_do_not_exist_when_local_auth_is_disabled(make_site: Any) -> None:
    site: Site = make_site()  # Entra mode, no ALLOW_LOCAL_AUTH
    payload = {"email": "x@example.com", "name": "X", "role": "viewer"}
    assert site.post("/admin/users", payload, absent=True).status_code == 404
    for action in ("reset-password", "reset-mfa", "unlock"):
        assert site.post(f"/admin/users/{MISSING_ID}/{action}", absent=True).status_code == 404
    # The routes that exist regardless are untouched.
    assert site.get("/admin/users").status_code == 401


# --- first sign-in with a one-time password -----------------------------------------------------------


def test_a_one_time_password_flags_must_change_and_blocks_every_non_auth_route(env: Env) -> None:
    created = env.create_user("first@example.com")
    response, cookie = env.site.login("first@example.com", created["temporaryPassword"])
    assert response.status_code == 200
    assert response.json()["user"]["mustChangePassword"] is True
    assert response.json()["user"]["localAccount"] is True

    blocked = env.site.get("/projects", cookie)
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "PASSWORD_CHANGE_REQUIRED"

    me = env.site.get("/auth/me", cookie)
    assert me.status_code == 200
    assert me.json()["user"]["mustChangePassword"] is True


def test_signs_in_case_insensitively_on_email(env: Env) -> None:
    created = env.create_user("casey@example.com")
    assert env.site.login("CASEY@Example.com", created["temporaryPassword"])[0].status_code == 200


def test_accounts_that_never_had_a_one_time_password_are_not_flagged(env: Env) -> None:
    response, cookie = env.site.login("architect@example.com", "architect-pass")
    assert response.json()["user"]["mustChangePassword"] is False
    assert env.site.get("/projects", cookie).status_code == 200


# --- POST /auth/password --------------------------------------------------------------------------------


class TestChangePassword:
    EMAIL = "changer@example.com"

    @pytest.fixture()
    def account(self, env: Env) -> tuple[str, str]:
        created = env.create_user(self.EMAIL)
        _, cookie = env.site.login(self.EMAIL, created["temporaryPassword"])
        return created["temporaryPassword"], cookie

    def change(self, env: Env, current: str, new: str, cookie: str) -> Any:
        return env.site.post("/auth/password", {"currentPassword": current, "newPassword": new}, cookie or None)

    def test_requires_authentication(self, env: Env, account: tuple[str, str]) -> None:
        assert self.change(env, account[0], "a-fine-new-password", "").status_code == 401

    def test_rejects_a_wrong_current_password(self, env: Env, account: tuple[str, str]) -> None:
        response = self.change(env, "wrong-current-pass", "a-fine-new-password", account[1])
        assert response.status_code == 400
        assert "current password" in response.json()["error"].lower()

    @pytest.mark.parametrize(
        ("new", "message"),
        [
            ("short1", "at least 12"),
            ("password12345", "too common"),
            ("my-Changer-secret-1", "email"),
        ],
    )
    def test_rejects_a_password_the_policy_refuses(
        self, env: Env, account: tuple[str, str], new: str, message: str
    ) -> None:
        response = self.change(env, account[0], new, account[1])
        assert response.status_code == 400
        assert message in response.json()["error"]

    def test_rejects_a_new_password_equal_to_the_current_one(self, env: Env, account: tuple[str, str]) -> None:
        response = self.change(env, account[0], account[0], account[1])
        assert response.status_code == 400
        assert "different" in response.json()["error"]

    def test_a_rejected_change_leaves_the_gate_and_the_old_password_in_place(
        self, env: Env, account: tuple[str, str]
    ) -> None:
        temporary, cookie = account
        self.change(env, temporary, "short1", cookie)
        assert env.site.get("/projects", cookie).status_code == 403
        assert env.site.login(self.EMAIL, temporary)[0].status_code == 200

    def test_succeeds_clears_must_change_and_unblocks_the_session(self, env: Env, account: tuple[str, str]) -> None:
        temporary, cookie = account
        response = self.change(env, temporary, "a-fine-new-password", cookie)
        assert response.status_code == 200
        assert response.json()["user"]["mustChangePassword"] is False
        assert env.site.get("/projects", cookie).status_code == 200
        assert env.site.get("/auth/me", cookie).json()["user"]["mustChangePassword"] is False

    def test_swaps_which_password_signs_in(self, env: Env, account: tuple[str, str]) -> None:
        temporary, cookie = account
        self.change(env, temporary, "a-fine-new-password", cookie)
        assert env.site.login(self.EMAIL, temporary)[0].status_code == 401
        fresh, _ = env.site.login(self.EMAIL, "a-fine-new-password")
        assert fresh.status_code == 200
        assert fresh.json()["user"]["mustChangePassword"] is False

    def test_ends_the_users_other_sessions_but_keeps_the_current_one(self, env: Env, account: tuple[str, str]) -> None:
        temporary, cookie = account
        _, other = env.site.login(self.EMAIL, temporary)
        assert other != cookie
        assert env.site.get("/auth/me", other).status_code == 200

        assert self.change(env, temporary, "a-fine-new-password", cookie).status_code == 200

        assert env.site.get("/auth/me", other).status_code == 401
        assert env.site.get("/auth/me", cookie).status_code == 200

    def test_does_not_end_other_users_sessions(self, env: Env, account: tuple[str, str]) -> None:
        assert env.site.get("/auth/me", env.admin_cookie).status_code == 200
        self.change(env, account[0], "a-fine-new-password", account[1])
        assert env.site.get("/auth/me", env.admin_cookie).status_code == 200

    def test_an_sso_account_has_no_canvas_password_to_change(self, env: Env) -> None:
        """A session without credentials behind it (e.g. an Entra user) is told so, not given a 500."""
        sso = env.site.api.user("sso@example.com", "viewer")
        response = env.site.post(
            "/auth/password", {"currentPassword": "x", "newPassword": "a-fine-new-password"}, f"cid={sso.cookie}"
        )
        assert response.status_code == 400
        assert "single sign-on" in response.json()["error"]


# --- POST /admin/users/:id/reset-password ------------------------------------------------------------------


def test_reset_password_returns_a_one_time_password_ends_sessions_and_forces_a_change(env: Env) -> None:
    target_id, target_cookie = env.activated_user("target@example.com", "orig-secret-phrase-1")
    assert env.site.get("/projects", target_cookie).status_code == 200

    response = env.site.post(f"/admin/users/{target_id}/reset-password", cookie=env.admin_cookie)
    assert response.status_code == 200
    temporary = response.json()["temporaryPassword"]
    assert OTP_FORMAT.match(temporary)

    assert env.site.get("/projects", target_cookie).status_code == 401
    assert env.site.login("target@example.com", "orig-secret-phrase-1")[0].status_code == 401

    signed_in, cookie = env.site.login("target@example.com", temporary)
    assert signed_in.status_code == 200
    assert signed_in.json()["user"]["mustChangePassword"] is True
    assert env.site.get("/projects", cookie).status_code == 403


def test_reset_password_keeps_the_admin_signed_in(env: Env) -> None:
    target_id, _ = env.activated_user("target@example.com", "orig-secret-phrase-1")
    env.site.post(f"/admin/users/{target_id}/reset-password", cookie=env.admin_cookie)
    assert env.site.get("/auth/me", env.admin_cookie).status_code == 200


def test_reset_password_creates_credentials_for_a_user_who_had_none(env: Env) -> None:
    user_id = str(uuid4())
    env.site.api.execute(
        "INSERT INTO users (id, name, email, role) VALUES (:id, 'Sso Person', 'sso@example.com', 'viewer')", id=user_id
    )

    def has_password() -> bool:
        users = env.site.get("/admin/users", env.admin_cookie).json()["users"]
        return bool(next(u for u in users if u["email"] == "sso@example.com")["hasPassword"])

    assert has_password() is False
    response = env.site.post(f"/admin/users/{user_id}/reset-password", cookie=env.admin_cookie)
    assert response.status_code == 200
    signed_in, _ = env.site.login("sso@example.com", response.json()["temporaryPassword"])
    assert signed_in.status_code == 200
    assert signed_in.json()["user"]["mustChangePassword"] is True
    assert has_password() is True


def test_reset_password_on_your_own_account_is_400(env: Env) -> None:
    assert env.site.post(f"/admin/users/{env.admin_id}/reset-password", cookie=env.admin_cookie).status_code == 400
    assert env.site.login("admin@example.com", "admin-pass")[0].status_code == 200


def test_reset_password_for_an_unknown_id_is_404(env: Env) -> None:
    assert env.site.post(f"/admin/users/{MISSING_ID}/reset-password", cookie=env.admin_cookie).status_code == 404


def test_reset_password_is_forbidden_to_non_admins_and_needs_authentication(env: Env) -> None:
    _, architect = env.site.login("architect@example.com", "architect-pass")
    url = f"/admin/users/{env.admin_id}/reset-password"
    assert env.site.post(url, cookie=architect).status_code == 403
    assert env.site.post(url).status_code == 401
    assert env.site.login("admin@example.com", "admin-pass")[0].status_code == 200


# --- unlock ------------------------------------------------------------------------------------------------


def lock(env: Env, email: str) -> None:
    for _ in range(3):
        env.site.login(email, "definitely-not-it-9")


def test_unlock_lets_the_correct_password_in_again_and_resets_the_counter(env: Env) -> None:
    lock(env, "architect@example.com")
    user_id = env.site.user_id("architect@example.com")
    response = env.site.post(f"/admin/users/{user_id}/unlock", cookie=env.admin_cookie)
    assert response.status_code == 200
    assert response.json() == {"unlocked": True}
    # The counter is back to zero: two wrongs don't lock again.
    assert [env.site.login("architect@example.com", "definitely-not-it-9")[0].status_code for _ in range(2)] == [
        401,
        401,
    ]
    assert env.site.login("architect@example.com", "architect-pass")[0].status_code == 200


def test_unlocking_an_unlocked_account_reports_false_and_records_no_audit_row(env: Env) -> None:
    user_id = env.site.user_id("architect@example.com")
    response = env.site.post(f"/admin/users/{user_id}/unlock", cookie=env.admin_cookie)
    assert response.status_code == 200
    assert response.json() == {"unlocked": False}
    assert [e for e in env.site.audit(env.admin_cookie) if e["event"] == "account_unlocked"] == []


def test_unlock_is_403_for_non_admins_401_unauthenticated_and_404_for_an_unknown_id(env: Env) -> None:
    user_id = env.site.user_id("architect@example.com")
    _, viewer = env.site.login("viewer@example.com", "viewer-pass")
    assert env.site.post(f"/admin/users/{user_id}/unlock", cookie=viewer).status_code == 403
    assert env.site.post(f"/admin/users/{user_id}/unlock").status_code == 401
    assert env.site.post(f"/admin/users/{MISSING_ID}/unlock", cookie=env.admin_cookie).status_code == 404


def test_an_admin_password_reset_also_unlocks_the_account(env: Env) -> None:
    lock(env, "architect@example.com")
    user_id = env.site.user_id("architect@example.com")
    reset = env.site.post(f"/admin/users/{user_id}/reset-password", cookie=env.admin_cookie)
    assert reset.status_code == 200
    signed_in, _ = env.site.login("architect@example.com", reset.json()["temporaryPassword"])
    assert signed_in.status_code == 200
    assert signed_in.json()["user"]["mustChangePassword"] is True
    users = env.site.get("/admin/users", env.admin_cookie).json()["users"]
    assert next(u for u in users if u["email"] == "architect@example.com")["locked"] is False


# --- user admin side effects --------------------------------------------------------------------------------


def test_deactivating_a_user_ends_their_sessions_and_blocks_sign_in(env: Env) -> None:
    target_id, target_cookie = env.activated_user("leaver@example.com", "orig-secret-phrase-2")
    assert env.site.get("/projects", target_cookie).status_code == 200

    response = env.site.request("PATCH", f"/admin/users/{target_id}", env.admin_cookie, {"active": False})
    assert response.status_code == 200

    assert env.site.get("/projects", target_cookie).status_code == 401
    assert env.site.login("leaver@example.com", "orig-secret-phrase-2")[0].status_code == 403  # deactivated


def test_a_role_change_ends_their_sessions_and_re_saving_the_same_role_does_not(env: Env) -> None:
    """canvas-18c: the session holds the role from sign-in, so a role change ends it."""
    target_id, target_cookie = env.activated_user("stayer@example.com", "orig-secret-phrase-3")

    def patch(role: str) -> None:
        env.site.request("PATCH", f"/admin/users/{target_id}", env.admin_cookie, {"role": role})

    patch("architect")
    assert env.site.get("/auth/me", target_cookie).status_code == 200  # unchanged role
    patch("viewer")
    assert env.site.get("/auth/me", target_cookie).status_code == 401


def test_the_user_list_reports_has_password_per_user(env: Env) -> None:
    env.site.api.execute(
        "INSERT INTO users (id, name, email, role) VALUES (:id, 'No Pw', 'nopw@example.com', 'viewer')", id=str(uuid4())
    )
    env.create_user("haspw@example.com")
    users = env.site.get("/admin/users", env.admin_cookie).json()["users"]
    by_email = {u["email"]: u["hasPassword"] for u in users}
    assert by_email["admin@example.com"] is True
    assert by_email["haspw@example.com"] is True
    assert by_email["nopw@example.com"] is False
