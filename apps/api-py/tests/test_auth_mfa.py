"""canvas-1bty.13: two-step verification for Canvas-password accounts (ports apps/api tests/contract/mfa.test.ts):
authenticator-app (TOTP) enrolment, required enrolment, the two-step sign-in, recovery codes, lockout by wrong
codes, admin reset, and the audit trail.

Time is frozen to 10 seconds into a 30-second step (like the TypeScript test's fake clock), so a code one step
either side never straddles a boundary."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import text

from canvas_api.auth import accounts
from canvas_api.auth.totp import time_step, totp_code
from canvas_api.routes import auth as auth_routes
from tests.auth_helpers import Site, seed_user

PW = "Granite-meadow-lantern-81"
T0_MS = int(datetime(2026, 6, 1, 12, 0, 10, tzinfo=UTC).timestamp() * 1000)
MISSING_ID = "00000000-0000-4000-8000-000000000000"


class Clock:
    def __init__(self) -> None:
        self.ms = T0_MS


class Env:
    def __init__(self, app: Site, strict: Site, admin_cookie: str, clock: Clock) -> None:
        self.app = app  # MFA_REQUIRED off
        self.strict = strict  # MFA_REQUIRED on
        self.admin_cookie = admin_cookie
        self.clock = clock

    def code(self, secret: str, offset: int = 0) -> str:
        return totp_code(secret, time_step(self.clock.ms) + offset)

    def bad_code(self, secret: str) -> str:
        valid = {self.code(secret, o) for o in (-1, 0, 1)}
        return next(c for c in ("000000", "111111", "222222") if c not in valid)

    def verify(self, cookie: str | None, code: str, site: Site | None = None) -> Any:
        return (site or self.app).post("/auth/mfa/verify", {"code": code}, cookie or None)

    def enrol(self, email: str, site: Site | None = None) -> tuple[str, list[str], str]:
        """Enrols `email` (seeded with PW); returns the secret, the recovery codes and the signed-in cookie."""
        site = site or self.app
        _, cookie = site.login(email, PW)
        start = site.post("/auth/mfa/enroll", cookie=cookie)
        assert start.status_code == 200, start.text
        secret = start.json()["secret"]
        confirm = site.post("/auth/mfa/enroll/confirm", {"code": self.code(secret)}, cookie)
        assert confirm.status_code == 200, confirm.text
        return secret, confirm.json()["recoveryCodes"], cookie

    def password_step(self, email: str) -> str:
        """The password step for an enrolled user; returns the pending-session cookie."""
        response, cookie = self.app.login(email, PW)
        assert response.json() == {"mfaRequired": True}
        return cookie

    def audit(self) -> list[dict[str, Any]]:
        return self.app.audit(self.admin_cookie, "?limit=200")


@pytest.fixture()
def env(make_site: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[Env]:
    clock = Clock()
    monkeypatch.setattr(accounts, "_now_ms", lambda: clock.ms)
    monkeypatch.setattr(auth_routes, "_now_ms", lambda: clock.ms)
    app: Site = make_site(allow_local_auth_setting="true")
    strict: Site = make_site(allow_local_auth_setting="true", mfa_required_setting="true")
    seed_user(app.engine, "admin@example.com", "admin-pass", "admin")
    seed_user(app.engine, "ann@example.com", PW, "architect")
    seed_user(app.engine, "viewer@example.com", "viewer-pass", "viewer")
    _, admin_cookie = app.login("admin@example.com", "admin-pass")
    yield Env(app, strict, admin_cookie, clock)


# --- enrolment ----------------------------------------------------------------------------------------------


def test_enroll_returns_a_secret_and_confirm_returns_ten_recovery_codes_and_enables_mfa(env: Env) -> None:
    _, cookie = env.app.login("ann@example.com", PW)
    start = env.app.post("/auth/mfa/enroll", cookie=cookie)
    assert start.status_code == 200
    secret, uri = start.json()["secret"], start.json()["otpauthUri"]
    assert len(secret) == 32 and secret.isalnum() and secret == secret.upper()
    assert uri.startswith("otpauth://totp/")
    assert f"secret={secret}" in uri

    confirm = env.app.post("/auth/mfa/enroll/confirm", {"code": env.code(secret)}, cookie)
    assert confirm.status_code == 200
    body = confirm.json()
    assert len(body["recoveryCodes"]) == 10
    assert len(set(body["recoveryCodes"])) == 10
    for code in body["recoveryCodes"]:
        assert len(code) == 11 and code[5] == "-"
        assert all(c in "abcdefghjkmnpqrstuvwxyz23456789" for c in code.replace("-", ""))
    assert body["user"]["mfaEnabled"] is True
    assert body["user"]["mustEnrollMfa"] is False

    users = env.app.get("/admin/users", env.admin_cookie).json()["users"]
    by_email = {u["email"]: u["mfaEnabled"] for u in users}
    assert by_email["ann@example.com"] is True
    assert by_email["viewer@example.com"] is False


def test_confirming_with_a_wrong_code_is_400_and_leaves_mfa_off(env: Env) -> None:
    _, cookie = env.app.login("ann@example.com", PW)
    secret = env.app.post("/auth/mfa/enroll", cookie=cookie).json()["secret"]
    response = env.app.post("/auth/mfa/enroll/confirm", {"code": env.bad_code(secret)}, cookie)
    assert response.status_code == 400
    assert "user" in env.app.login("ann@example.com", PW)[0].json()


def test_confirming_before_enrolling_is_400(env: Env) -> None:
    _, cookie = env.app.login("ann@example.com", PW)
    assert env.app.post("/auth/mfa/enroll/confirm", {"code": "123456"}, cookie).status_code == 400


def test_enrolling_again_once_enabled_is_409_for_enroll_and_confirm(env: Env) -> None:
    secret, _, cookie = env.enrol("ann@example.com")
    assert env.app.post("/auth/mfa/enroll", cookie=cookie).status_code == 409
    assert env.app.post("/auth/mfa/enroll/confirm", {"code": env.code(secret, 1)}, cookie).status_code == 409


def test_restarting_before_confirming_issues_a_new_secret_and_the_old_one_stops_working(env: Env) -> None:
    _, cookie = env.app.login("ann@example.com", PW)
    first = env.app.post("/auth/mfa/enroll", cookie=cookie).json()["secret"]
    second = env.app.post("/auth/mfa/enroll", cookie=cookie).json()["secret"]
    assert second != first
    assert env.app.post("/auth/mfa/enroll/confirm", {"code": env.code(first)}, cookie).status_code == 400
    assert env.app.post("/auth/mfa/enroll/confirm", {"code": env.code(second)}, cookie).status_code == 200


def test_the_enrol_endpoints_require_authentication(env: Env) -> None:
    assert env.app.post("/auth/mfa/enroll").status_code == 401
    assert env.app.post("/auth/mfa/enroll/confirm", {"code": "123456"}).status_code == 401


def test_a_sso_session_cannot_enrol(env: Env) -> None:
    sso = env.app.api.user("sso@example.com", "viewer")
    assert env.app.post("/auth/mfa/enroll", cookie=f"cid={sso.cookie}").status_code == 400


def test_a_code_longer_than_64_characters_is_refused_by_the_schema(env: Env) -> None:
    _, cookie = env.app.login("ann@example.com", PW)
    assert env.app.post("/auth/mfa/enroll/confirm", {"code": "1" * 65}, cookie).status_code == 400


def test_the_secret_is_stored_encrypted_and_never_in_the_audit_log(env: Env) -> None:
    secret, recovery_codes, _ = env.enrol("ann@example.com")
    with env.app.engine.connect() as conn:
        stored = conn.execute(text("SELECT secret_encrypted FROM user_mfa")).scalar_one()
        hashes = json.dumps(
            [dict(r._mapping) for r in conn.execute(text("SELECT * FROM mfa_recovery_codes"))], default=str
        )
    assert stored.startswith("v1:")
    assert secret not in stored
    for code in recovery_codes:
        assert code not in hashes

    env.verify(env.password_step("ann@example.com"), env.code(secret, 1))
    env.verify(env.password_step("ann@example.com"), env.bad_code(secret))
    with env.app.engine.connect() as conn:
        dump = json.dumps([dict(r._mapping) for r in conn.execute(text("SELECT * FROM audit_events"))], default=str)
    assert secret not in dump
    for code in recovery_codes:
        assert code not in dump
    assert env.code(secret, 1) not in dump


# --- required enrolment -------------------------------------------------------------------------------------


def test_a_user_without_mfa_is_told_to_enrol_and_blocked_until_they_do(env: Env) -> None:
    response, cookie = env.strict.login("ann@example.com", PW)
    assert response.json()["user"]["mustEnrollMfa"] is True
    assert response.json()["user"]["mfaEnabled"] is False
    blocked = env.strict.get("/projects", cookie)
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "MFA_ENROLLMENT_REQUIRED"
    assert env.strict.get("/auth/me", cookie).status_code == 200

    secret = env.strict.post("/auth/mfa/enroll", cookie=cookie).json()["secret"]
    assert env.strict.post("/auth/mfa/enroll/confirm", {"code": env.code(secret)}, cookie).status_code == 200
    assert env.strict.get("/projects", cookie).status_code == 200


def test_password_change_required_takes_precedence_for_a_one_time_password_user(env: Env) -> None:
    created = env.app.post(
        "/admin/users", {"email": "otp@example.com", "name": "Otp", "role": "viewer"}, env.admin_cookie
    ).json()
    response, cookie = env.strict.login("otp@example.com", created["temporaryPassword"])
    assert response.json()["user"]["mustChangePassword"] is True
    assert response.json()["user"]["mustEnrollMfa"] is True
    blocked = env.strict.get("/projects", cookie)
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "PASSWORD_CHANGE_REQUIRED"

    change = env.strict.post(
        "/auth/password",
        {"currentPassword": created["temporaryPassword"], "newPassword": "Velvet-orchard-signal-33"},  # gitleaks:allow
        cookie,
    )
    assert change.status_code == 200
    after = env.strict.get("/projects", cookie)
    assert after.status_code == 403
    assert after.json()["code"] == "MFA_ENROLLMENT_REQUIRED"


def test_the_default_config_does_not_require_enrolment(env: Env) -> None:
    response, cookie = env.app.login("ann@example.com", PW)
    assert response.json()["user"]["mustEnrollMfa"] is False
    assert env.app.get("/projects", cookie).status_code == 200


def test_auth_config_reports_whether_enrolment_is_required(env: Env) -> None:
    assert env.app.get("/auth/config").json()["mfaRequired"] is False
    assert env.strict.get("/auth/config").json()["mfaRequired"] is True


# --- two-step sign-in ---------------------------------------------------------------------------------------


def test_the_password_step_returns_only_mfa_required_and_nothing_is_accessible(env: Env) -> None:
    env.enrol("ann@example.com")
    response, cookie = env.app.login("ann@example.com", PW)
    assert response.status_code == 200
    assert response.json() == {"mfaRequired": True}
    assert env.app.get("/auth/me", cookie).status_code == 401
    assert env.app.get("/projects", cookie).status_code == 401


def test_session_check_reports_pending_mfa_between_the_two_steps(env: Env) -> None:
    """canvas-ao2: the pending session (password done, code not yet) counts as a session that arrived."""
    env.enrol("ann@example.com")
    pending = env.password_step("ann@example.com")
    assert env.app.get("/auth/session-check", pending).json() == {"session": "pending-mfa"}


def test_a_current_code_completes_sign_in(env: Env) -> None:
    secret, _, _ = env.enrol("ann@example.com")
    pending = env.password_step("ann@example.com")
    response = env.verify(pending, env.code(secret, 1))
    assert response.status_code == 200
    user = response.json()["user"]
    assert user["email"] == "ann@example.com"
    assert user["mfaEnabled"] is True
    assert user["localAccount"] is True
    from tests.auth_helpers import session_cookie

    cookie = session_cookie(response)
    assert cookie and cookie != pending
    assert env.app.get("/projects", cookie).status_code == 200
    assert env.app.get("/auth/me", cookie).status_code == 200
    assert env.app.get("/auth/me", pending).status_code == 401  # the pending session is dead


def test_a_code_cannot_be_replayed_nor_the_one_used_to_confirm_enrolment(env: Env) -> None:
    secret, _, _ = env.enrol("ann@example.com")
    # Enrolment consumed the current step.
    assert env.verify(env.password_step("ann@example.com"), env.code(secret)).status_code == 401
    following = env.code(secret, 1)
    assert env.verify(env.password_step("ann@example.com"), following).status_code == 200
    assert env.verify(env.password_step("ann@example.com"), following).status_code == 401


def test_a_code_with_a_space_in_the_middle_is_accepted(env: Env) -> None:
    secret, _, _ = env.enrol("ann@example.com")
    code = env.code(secret, 1)
    assert env.verify(env.password_step("ann@example.com"), f"{code[:3]} {code[3:]}").status_code == 200


def test_a_recovery_code_works_once_then_not_again_and_the_remaining_count_drops(env: Env) -> None:
    _, recovery_codes, _ = env.enrol("ann@example.com")
    first = env.verify(env.password_step("ann@example.com"), recovery_codes[0])
    assert first.status_code == 200
    assert first.json()["recoveryCodesRemaining"] == 9
    assert env.verify(env.password_step("ann@example.com"), recovery_codes[0]).status_code == 401
    second = env.verify(env.password_step("ann@example.com"), recovery_codes[1].upper())
    assert second.status_code == 200
    assert second.json()["recoveryCodesRemaining"] == 8


def test_wrong_codes_count_toward_lockout_and_re_entering_the_password_does_not_reset_the_count(env: Env) -> None:
    secret, _, _ = env.enrol("ann@example.com")
    wrong = env.bad_code(secret)
    assert env.verify(env.password_step("ann@example.com"), wrong).status_code == 401
    pending = env.password_step("ann@example.com")
    assert env.verify(pending, wrong).status_code == 401
    # Password again (must not reset the counter), then the third wrong code.
    third = env.verify(env.password_step("ann@example.com"), wrong)
    assert third.status_code == 423
    assert env.app.login("ann@example.com", PW)[0].status_code == 423
    # Even the right code is refused once locked.
    assert env.verify(pending, env.code(secret, 1)).status_code == 423


def test_a_successful_second_step_resets_the_counter(env: Env) -> None:
    secret, _, _ = env.enrol("ann@example.com")
    wrong = env.bad_code(secret)
    env.verify(env.password_step("ann@example.com"), wrong)
    env.verify(env.password_step("ann@example.com"), wrong)
    assert env.verify(env.password_step("ann@example.com"), env.code(secret, 1)).status_code == 200
    env.verify(env.password_step("ann@example.com"), wrong)
    assert env.verify(env.password_step("ann@example.com"), wrong).status_code == 401


def test_a_wrong_password_does_not_reveal_anything_about_mfa(env: Env) -> None:
    env.enrol("ann@example.com")
    response, _ = env.app.login("ann@example.com", "wrong-password-123")
    assert response.status_code == 401
    assert response.json() == {"error": "Invalid email or password"}


def test_verifying_after_five_minutes_pending_is_401_even_with_the_right_code(env: Env) -> None:
    secret, _, _ = env.enrol("ann@example.com")
    pending = env.password_step("ann@example.com")
    env.clock.ms += 5 * 60_000 + 1000
    response = env.verify(pending, env.code(secret, 1))
    assert response.status_code == 401
    assert "timed out" in response.json()["error"].lower()
    # The timed-out pending session is ended, not left to retry.
    assert env.verify(pending, env.code(secret, 1)).status_code == 401


def test_verifying_with_no_pending_sign_in_is_401(env: Env) -> None:
    env.enrol("ann@example.com")
    assert env.verify(None, "123456").status_code == 401
    _, cookie = env.app.login("viewer@example.com", "viewer-pass")
    assert env.verify(cookie, "123456").status_code == 401


def test_a_deactivated_user_cannot_finish_the_second_step(env: Env) -> None:
    secret, _, _ = env.enrol("ann@example.com")
    pending = env.password_step("ann@example.com")
    user_id = env.app.user_id("ann@example.com")
    env.app.request("PATCH", f"/admin/users/{user_id}", env.admin_cookie, {"active": False})
    assert env.verify(pending, env.code(secret, 1)).status_code == 401


# --- admin reset --------------------------------------------------------------------------------------------


def test_reset_mfa_ends_sessions_removes_mfa_and_the_next_sign_in_needs_no_code(env: Env) -> None:
    _, _, ann_session = env.enrol("ann@example.com")
    assert env.app.get("/auth/me", ann_session).status_code == 200
    user_id = env.app.user_id("ann@example.com")

    response = env.app.post(f"/admin/users/{user_id}/reset-mfa", cookie=env.admin_cookie)
    assert response.status_code == 200
    assert response.json() == {"reset": True}
    assert env.app.get("/auth/me", ann_session).status_code == 401

    users = env.app.get("/admin/users", env.admin_cookie).json()["users"]
    assert {u["email"]: u["mfaEnabled"] for u in users}["ann@example.com"] is False
    assert env.app.api.scalar("SELECT COUNT(*) FROM mfa_recovery_codes") == 0

    signed_in, _ = env.app.login("ann@example.com", PW)
    assert signed_in.json()["user"]["email"] == "ann@example.com"
    assert signed_in.json()["user"]["mfaEnabled"] is False


def test_with_mfa_required_the_user_must_enrol_again_after_a_reset(env: Env) -> None:
    env.enrol("ann@example.com")
    env.app.post(f"/admin/users/{env.app.user_id('ann@example.com')}/reset-mfa", cookie=env.admin_cookie)
    response, cookie = env.strict.login("ann@example.com", PW)
    assert response.json()["user"]["mfaEnabled"] is False
    assert response.json()["user"]["mustEnrollMfa"] is True
    assert env.strict.get("/projects", cookie).json()["code"] == "MFA_ENROLLMENT_REQUIRED"


def test_reset_mfa_is_400_on_your_own_account_403_for_non_admins_401_unauthenticated_404_unknown(env: Env) -> None:
    admin_id = env.app.user_id("admin@example.com")
    ann_id = env.app.user_id("ann@example.com")
    assert env.app.post(f"/admin/users/{admin_id}/reset-mfa", cookie=env.admin_cookie).status_code == 400
    _, viewer = env.app.login("viewer@example.com", "viewer-pass")
    assert env.app.post(f"/admin/users/{ann_id}/reset-mfa", cookie=viewer).status_code == 403
    assert env.app.post(f"/admin/users/{ann_id}/reset-mfa").status_code == 401
    assert env.app.post(f"/admin/users/{MISSING_ID}/reset-mfa", cookie=env.admin_cookie).status_code == 404


# --- audit --------------------------------------------------------------------------------------------------


def test_records_mfa_enrolled_mfa_reset_wrong_mfa_code_and_the_sign_in_method(env: Env) -> None:
    secret, recovery_codes, _ = env.enrol("ann@example.com")
    env.verify(env.password_step("ann@example.com"), env.bad_code(secret))
    env.verify(env.password_step("ann@example.com"), env.code(secret, 1))
    env.verify(env.password_step("ann@example.com"), recovery_codes[0])
    env.app.post(f"/admin/users/{env.app.user_id('ann@example.com')}/reset-mfa", cookie=env.admin_cookie)
    env.app.login("ann@example.com", PW)

    events = env.audit()
    enrolled = next(e for e in events if e["event"] == "mfa_enrolled")
    assert (enrolled["actorEmail"], enrolled["targetEmail"]) == ("ann@example.com", "ann@example.com")
    reset = next(e for e in events if e["event"] == "mfa_reset")
    assert (reset["actorEmail"], reset["targetEmail"]) == ("admin@example.com", "ann@example.com")
    wrong = next(e for e in events if (e["detail"] or {}).get("reason") == "wrong_mfa_code")
    assert (wrong["event"], wrong["targetEmail"]) == ("sign_in_failed", "ann@example.com")
    methods = {
        (e["detail"] or {}).get("method")
        for e in events
        if e["event"] == "sign_in" and e["targetEmail"] == "ann@example.com"
    }
    assert {"password+authenticator", "password+recovery_code", "password"} <= methods
