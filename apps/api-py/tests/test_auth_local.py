"""canvas-1bty.13: Canvas email + password sign-in (ports apps/api tests/contract/lockout-and-audit.test.ts and
session-cookie.test.ts, plus the sign-in basics): three-strikes lockout, the audit log, the per-address rate
limit, and the session cookie's attributes."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from urllib.parse import quote

import pytest
from sqlalchemy import text

from tests.auth_helpers import Site, seed_user, set_cookie_header

PW = "Granite-meadow-lantern-81"
WRONG = "definitely-not-it-9"
NEW_PW = "Velvet-orchard-signal-33"


class Env:
    def __init__(self, site: Site, admin_cookie: str) -> None:
        self.site = site
        self.admin_cookie = admin_cookie

    def wrong_times(self, email: str, n: int) -> list[int]:
        return [self.site.login(email, WRONG)[0].status_code for _ in range(n)]

    def audit(self, query: str = "") -> list[dict[str, Any]]:
        return self.site.audit(self.admin_cookie, query)

    def users(self) -> list[dict[str, Any]]:
        users: list[dict[str, Any]] = self.site.get("/admin/users", self.admin_cookie).json()["users"]
        return users

    def patch_user(self, email: str, body: dict[str, Any]) -> None:
        response = self.site.request("PATCH", f"/admin/users/{self.site.user_id(email)}", self.admin_cookie, body)
        assert response.status_code == 200, response.text


@pytest.fixture()
def env(make_site: Any) -> Iterator[Env]:
    site: Site = make_site(allow_local_auth_setting="true")
    seed_user(site.engine, "admin@example.com", "admin-pass", "admin")
    seed_user(site.engine, "victim@example.com", PW, "architect")
    seed_user(site.engine, "viewer@example.com", "viewer-pass", "viewer")
    _, admin_cookie = site.login("admin@example.com", "admin-pass")
    yield Env(site, admin_cookie)


# --- sign-in -------------------------------------------------------------------------------------------


def test_signing_in_returns_the_user_and_a_session_that_works(env: Env) -> None:
    response, cookie = env.site.login("victim@example.com", PW)
    assert response.status_code == 200
    user = response.json()["user"]
    assert user["email"] == "victim@example.com"
    assert user["role"] == "architect"
    assert user["localAccount"] is True
    assert user["mfaEnabled"] is False
    assert env.site.get("/auth/me", cookie).json()["user"]["email"] == "victim@example.com"


def test_email_and_password_are_required(env: Env) -> None:
    for body in ({}, {"email": "victim@example.com"}, {"password": PW}, {"email": "", "password": PW}):
        assert env.site.post("/auth/local/login", body).status_code == 400, body


def test_an_unknown_email_and_a_wrong_password_get_the_same_answer(env: Env) -> None:
    unknown = env.site.login("nobody@example.com", WRONG)[0]
    wrong = env.site.login("victim@example.com", WRONG)[0]
    assert (
        (unknown.status_code, unknown.json())
        == (wrong.status_code, wrong.json())
        == (401, {"error": "Invalid email or password"})
    )


def test_logout_ends_the_session_leaving_a_scrubbed_revoked_row(env: Env) -> None:
    """canvas-bj7: no live row, a revoked one with no data."""
    _, cookie = env.site.login("victim@example.com", PW)
    assert env.site.post("/auth/logout", cookie=cookie).status_code == 204
    assert env.site.get("/auth/me", cookie).status_code == 401
    user_id = env.site.user_id("victim@example.com")
    live = env.site.api.scalar(
        "SELECT COUNT(*) FROM sessions WHERE user_id = :u AND revoked = :no", u=user_id, no=False
    )
    assert live == 0
    revoked = env.site.api.scalar(
        "SELECT data FROM sessions WHERE user_id = :u AND revoked = :yes", u=user_id, yes=True
    )
    assert revoked == "{}"


# --- lockout ------------------------------------------------------------------------------------------------


def test_two_wrong_then_correct_succeeds_and_resets_the_counter(env: Env) -> None:
    assert env.wrong_times("victim@example.com", 2) == [401, 401]
    assert env.site.login("victim@example.com", PW)[0].status_code == 200
    assert env.wrong_times("victim@example.com", 2) == [401, 401]
    assert env.site.login("victim@example.com", PW)[0].status_code == 200


def test_the_third_consecutive_wrong_password_locks_then_even_the_correct_one_gets_423(env: Env) -> None:
    assert env.wrong_times("victim@example.com", 3) == [401, 401, 423]
    correct, cookie = env.site.login("victim@example.com", PW)
    assert correct.status_code == 423
    assert "locked" in correct.json()["error"].lower()
    assert cookie == ""


def test_locking_ends_the_users_existing_sessions(env: Env) -> None:
    _, existing = env.site.login("victim@example.com", PW)
    assert env.site.get("/auth/me", existing).status_code == 200
    env.wrong_times("victim@example.com", 3)
    assert env.site.get("/auth/me", existing).status_code == 401


def test_the_user_list_reports_locked(env: Env) -> None:
    env.wrong_times("victim@example.com", 3)
    by_email = {u["email"]: u["locked"] for u in env.users()}
    assert by_email["victim@example.com"] is True
    assert by_email["viewer@example.com"] is False


def test_an_inactive_user_with_the_correct_password_is_deactivated_not_a_lockout_strike(env: Env) -> None:
    env.patch_user("victim@example.com", {"active": False})
    for _ in range(5):
        response, _ = env.site.login("victim@example.com", PW)
        assert response.status_code == 403
        assert "deactivated" in response.json()["error"]
    # A wrong password on a deactivated account still gets the generic answer.
    assert env.site.login("victim@example.com", "Not-the-password-123")[0].status_code == 401
    assert {u["email"]: u["locked"] for u in env.users()}["victim@example.com"] is False
    env.patch_user("victim@example.com", {"active": True})
    assert env.site.login("victim@example.com", PW)[0].status_code == 200


def test_a_wrong_current_password_on_change_password_counts_and_ends_the_session(env: Env) -> None:
    env.wrong_times("victim@example.com", 1)
    _, cookie = env.site.login("victim@example.com", PW)  # success resets the counter
    env.wrong_times("victim@example.com", 1)

    def change(current: str) -> Any:
        return env.site.post("/auth/password", {"currentPassword": current, "newPassword": NEW_PW}, cookie)

    # 1 failed sign-in + 1 wrong current = 2; the next wrong current is the third.
    assert change(WRONG).status_code == 400
    locked = change(WRONG)
    assert locked.status_code == 423
    assert "locked" in locked.json()["error"].lower()
    assert env.site.get("/auth/me", cookie).status_code == 401
    assert env.site.login("victim@example.com", PW)[0].status_code == 423


def test_a_successful_password_change_clears_the_failed_attempt_counter(env: Env) -> None:
    _, cookie = env.site.login("victim@example.com", PW)

    def change(current: str, new: str) -> int:
        return env.site.post("/auth/password", {"currentPassword": current, "newPassword": new}, cookie).status_code

    assert change(WRONG, NEW_PW) == 400
    assert change(WRONG, NEW_PW) == 400
    assert change(PW, NEW_PW) == 200
    assert change(NEW_PW, "Marble-harbour-violin-77") == 200


# --- audit log ----------------------------------------------------------------------------------------------


def test_records_the_sign_in_events_with_actor_target_and_ip(env: Env) -> None:
    env.site.login("victim@example.com", PW)
    env.site.login("nobody@example.com", WRONG)
    env.site.login("victim@example.com", WRONG)
    events = env.audit()
    sign_in = next(e for e in events if e["event"] == "sign_in" and e["targetEmail"] == "victim@example.com")
    assert sign_in["actorEmail"] == "victim@example.com"
    assert sign_in["detail"] == {"method": "password"}
    assert sign_in["ip"]
    unknown = next(e for e in events if (e["detail"] or {}).get("reason") == "unknown_email")
    assert unknown["event"] == "sign_in_failed"
    assert unknown["actorEmail"] is None
    assert unknown["targetEmail"] is None
    assert unknown["detail"]["email"] == "nobody@example.com"
    wrong = next(e for e in events if (e["detail"] or {}).get("reason") == "wrong_password")
    assert wrong["event"] == "sign_in_failed"
    assert wrong["targetEmail"] == "victim@example.com"


def test_records_locked_inactive_account_locked_and_account_unlocked(env: Env) -> None:
    env.wrong_times("victim@example.com", 3)
    env.site.login("victim@example.com", PW)  # locked
    user_id = env.site.user_id("victim@example.com")
    env.site.post(f"/admin/users/{user_id}/unlock", cookie=env.admin_cookie)
    env.patch_user("victim@example.com", {"active": False})
    env.site.login("victim@example.com", PW)  # inactive

    events = env.audit("?limit=200")
    reasons = {(e["detail"] or {}).get("reason") for e in events if e["event"] == "sign_in_failed"}
    assert {"wrong_password", "locked", "inactive"} <= reasons
    assert len([e for e in events if e["event"] == "account_locked"]) == 1
    unlocked = next(e for e in events if e["event"] == "account_unlocked")
    assert unlocked["actorEmail"] == "admin@example.com"
    assert unlocked["targetEmail"] == "victim@example.com"


def test_records_password_changes_resets_and_user_admin_events(env: Env) -> None:
    created = env.site.post(
        "/admin/users", {"email": "new.person@example.com", "name": "N", "role": "viewer"}, env.admin_cookie
    ).json()
    env.patch_user("victim@example.com", {"role": "viewer", "active": True})
    env.site.post(f"/admin/users/{env.site.user_id('victim@example.com')}/reset-password", cookie=env.admin_cookie)
    _, viewer = env.site.login("viewer@example.com", "viewer-pass")
    env.site.post("/auth/password", {"currentPassword": WRONG, "newPassword": NEW_PW}, viewer)
    env.site.post("/auth/password", {"currentPassword": "viewer-pass", "newPassword": NEW_PW}, viewer)

    events = env.audit("?limit=200")

    def by(name: str) -> dict[str, Any]:
        return next(e for e in events if e["event"] == name)

    assert by("user_created")["actorEmail"] == "admin@example.com"
    assert by("user_created")["targetEmail"] == "new.person@example.com"
    assert by("user_created")["detail"] == {"role": "viewer"}
    assert by("user_updated")["targetEmail"] == "victim@example.com"
    assert by("user_updated")["detail"] == {"role": "viewer", "active": True}
    assert by("password_reset")["actorEmail"] == "admin@example.com"
    assert by("password_reset")["targetEmail"] == "victim@example.com"
    assert by("password_change_failed")["actorEmail"] == "viewer@example.com"
    assert by("password_change_failed")["detail"] == {"reason": "wrong_password"}
    assert by("password_changed")["actorEmail"] == "viewer@example.com"
    assert by("password_changed")["targetEmail"] == "viewer@example.com"
    assert created["user"]["email"] == "new.person@example.com"


def test_never_stores_a_password_anywhere_in_an_audit_row(env: Env) -> None:
    created = env.site.post(
        "/admin/users", {"email": "new.person@example.com", "name": "N", "role": "viewer"}, env.admin_cookie
    ).json()
    reset = env.site.post(
        f"/admin/users/{env.site.user_id('victim@example.com')}/reset-password", cookie=env.admin_cookie
    ).json()
    env.site.login("victim@example.com", WRONG)
    env.site.login("nobody@example.com", "typed-into-wrong-field-1")
    _, viewer = env.site.login("viewer@example.com", "viewer-pass")
    env.site.post("/auth/password", {"currentPassword": WRONG, "newPassword": NEW_PW}, viewer)
    env.site.post("/auth/password", {"currentPassword": "viewer-pass", "newPassword": NEW_PW}, viewer)

    with env.site.engine.connect() as conn:
        rows = [dict(r._mapping) for r in conn.execute(text("SELECT * FROM audit_events"))]
    assert len(rows) > 5
    dump = json.dumps(rows, default=str)
    for secret in (
        PW,
        WRONG,
        "admin-pass",
        "viewer-pass",
        "typed-into-wrong-field-1",
        NEW_PW,
        created["temporaryPassword"],
        reset["temporaryPassword"],
    ):
        assert secret not in dump


def test_the_audit_log_is_admin_only(env: Env) -> None:
    _, viewer = env.site.login("viewer@example.com", "viewer-pass")
    assert env.site.get("/admin/audit", viewer).status_code == 403
    assert env.site.get("/admin/audit").status_code == 401


def test_the_audit_log_lists_newest_first(env: Env) -> None:
    env.site.login("first@example.com", WRONG)
    env.site.login("second@example.com", WRONG)
    events = env.audit()
    assert events[0]["detail"]["email"] == "second@example.com"
    assert events[1]["detail"]["email"] == "first@example.com"


def test_the_audit_limit_is_honoured_and_out_of_range_values_are_400(env: Env) -> None:
    for i in range(4):
        env.site.login(f"u{i}@example.com", WRONG)
    assert len(env.audit("?limit=2")) == 2
    assert env.site.get("/admin/audit?limit=0", env.admin_cookie).status_code == 400
    assert env.site.get("/admin/audit?limit=201", env.admin_cookie).status_code == 400


def test_the_audit_log_pages_backwards_with_before(env: Env) -> None:
    for name in "abc":
        env.site.login(f"{name}@example.com", WRONG)
    page1 = env.audit("?limit=1")
    assert page1[0]["detail"]["email"] == "c@example.com"
    page2 = env.audit(f"?limit=1&before={quote(page1[0]['occurredAt'])}")
    assert page2[0]["detail"]["email"] == "b@example.com"
    page3 = env.audit(f"?limit=200&before={quote(page2[0]['occurredAt'])}")
    ids = [e["id"] for e in page3]
    assert page1[0]["id"] not in ids
    assert page2[0]["id"] not in ids
    assert any((e["detail"] or {}).get("email") == "a@example.com" for e in page3)


def test_the_audit_log_filters_by_user_on_either_side_of_the_event(env: Env) -> None:
    env.wrong_times("victim@example.com", 1)
    env.site.login("viewer@example.com", "viewer-pass")
    victim = env.site.user_id("victim@example.com")
    events = env.audit(f"?userId={victim}&limit=200")
    assert events
    assert all("victim@example.com" in (e["targetEmail"], e["actorEmail"]) for e in events)
    # Admin-side events targeting the user are included too.
    env.site.post(f"/admin/users/{victim}/reset-password", cookie=env.admin_cookie)
    assert any(e["event"] == "password_reset" for e in env.audit(f"?userId={victim}&limit=200"))


# --- the sign-in rate limit ---------------------------------------------------------------------------------


class TestRateLimit:
    @pytest.fixture()
    def limited(self, make_site: Any) -> Site:
        site: Site = make_site(allow_local_auth_setting="true", login_rate_limit_setting="3")
        seed_user(site.engine, "viewer@example.com", "viewer-pass", "viewer")
        return site

    @staticmethod
    def xff(value: str) -> dict[str, str]:
        return {"x-forwarded-for": value}

    def test_refuses_the_fourth_attempt_from_one_address_even_with_the_right_password(self, limited: Site) -> None:
        codes = [limited.login("nobody@example.com", WRONG, self.xff("10.0.1.1"))[0].status_code for _ in range(3)]
        assert codes == [401, 401, 401]
        blocked = limited.login("viewer@example.com", "viewer-pass", self.xff("10.0.1.1"))[0]
        assert blocked.status_code == 429

    def test_allows_a_different_last_forwarded_for_entry(self, limited: Site) -> None:
        for _ in range(4):
            limited.login("nobody@example.com", WRONG, self.xff("10.0.2.1"))
        assert limited.login("viewer@example.com", "viewer-pass", self.xff("10.0.2.2"))[0].status_code == 200

    def test_is_not_evaded_by_spoofing_only_the_first_forwarded_for_entry(self, limited: Site) -> None:
        codes = [
            limited.login("nobody@example.com", WRONG, self.xff(f"spoof-{i}, 10.0.3.1"))[0].status_code
            for i in range(4)
        ]
        assert codes == [401, 401, 401, 429]

    def test_the_default_entra_mode_config_is_unlimited(self, make_site: Any) -> None:
        site: Site = make_site(allow_local_auth_setting="true")
        for _ in range(30):
            assert site.login("nobody@example.com", WRONG)[0].status_code == 401

    def test_local_mode_defaults_to_twenty_a_minute(self, make_site: Any) -> None:
        site: Site = make_site(auth_mode_setting="local")
        codes = [site.login("nobody@example.com", WRONG, self.xff("10.0.4.1"))[0].status_code for _ in range(21)]
        assert codes == [401] * 20 + [429]


# --- the session cookie's attributes (session-cookie.test.ts) -----------------------------------------------


def signed_in_cookie_header(site: Site) -> tuple[str, str]:
    seed_user(site.engine, "cookie-test@example.com", "cookie-test-pass")
    response, cookie = site.login("cookie-test@example.com", "cookie-test-pass")
    assert response.status_code == 200
    header = set_cookie_header(response)
    assert header is not None
    return header, cookie


def test_the_default_cookie_is_same_origin_safe(make_site: Any) -> None:
    header, _ = signed_in_cookie_header(make_site(allow_local_auth_setting="true"))
    assert "secure" not in header.lower()
    assert "samesite=lax" in header.lower()
    assert "httponly" in header.lower()
    assert "path=/" in header.lower()


def test_a_split_origin_deployment_gets_a_secure_samesite_none_cookie_that_works(make_site: Any) -> None:
    site: Site = make_site(allow_local_auth_setting="true", cookie_secure_setting=True, cookie_same_site="none")
    header, cookie = signed_in_cookie_header(site)
    assert "secure" in header.lower()
    assert "samesite=none" in header.lower()
    # The regression: a request carrying that cookie is recognised as signed in.
    me = site.get("/auth/me", cookie, headers={"x-forwarded-proto": "https"})
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "cookie-test@example.com"


def test_samesite_none_implies_secure(make_site: Any) -> None:
    header, _ = signed_in_cookie_header(make_site(allow_local_auth_setting="true", cookie_same_site="none"))
    assert "secure" in header.lower()


def test_the_cookie_lasts_as_long_as_the_idle_timeout(make_site: Any) -> None:
    header, _ = signed_in_cookie_header(make_site(allow_local_auth_setting="true", session_idle_minutes=30))
    assert "max-age=1800" in header.lower()
