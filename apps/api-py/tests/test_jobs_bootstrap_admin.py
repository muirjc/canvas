"""The bootstrap-admin job (jobs/bootstrap_admin.py), a port of apps/api/src/seed/bootstrap-admin.ts and its tests
(apps/api/tests/contract/bootstrap-admin.test.ts): the first admin of a local-mode environment, and the lone admin's
recovery. Each test gets an empty database of its own (tests/job_helpers.py)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from sqlalchemy import text

from canvas_api.auth.passwords import verify_password
from canvas_api.jobs import bootstrap_admin as job
from canvas_api.migrations import run_migrations
from tests.job_helpers import JobDb, job_db_fixture  # noqa: F401 - fixture

EMAIL = "first.admin@example.com"
PASSWORD = "a-long-bootstrap-password-1"


def _run(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    **env: str | None,
) -> tuple[int, str, str]:
    """Runs the job as the Container Apps job does, with BOOTSTRAP_* from `env` (None = unset)."""
    job_db.use(monkeypatch)
    defaults: dict[str, str | None] = {
        "BOOTSTRAP_ADMIN_EMAIL": EMAIL,
        "BOOTSTRAP_ADMIN_PASSWORD": PASSWORD,
        "BOOTSTRAP_ADMIN_NAME": None,
        "BOOTSTRAP_MODE": None,
    }
    for name, value in {**defaults, **env}.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    code = job.main()
    out, err = capsys.readouterr()
    assert PASSWORD not in out + err
    return code, out, err


def _user(job_db: JobDb, email: str = EMAIL) -> Any:
    with job_db.engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT u.id, u.name, u.role, u.active, c.password_hash, c.password_salt, c.must_change_password,"
                " c.failed_attempts, c.locked_at FROM users u LEFT JOIN local_credentials c ON c.user_id = u.id"
                " WHERE u.email = :email"
            ),
            {"email": email},
        ).first()


def _audit(job_db: JobDb) -> list[tuple[str, Any]]:
    with job_db.engine.connect() as conn:
        rows = conn.execute(text("SELECT event, detail FROM audit_events ORDER BY occurred_at")).all()
    return [(r.event, json.loads(r.detail) if isinstance(r.detail, str) else r.detail) for r in rows]


def _add_user(job_db: JobDb, email: str, role: str = "viewer", active: bool = True) -> str:
    user_id = "00000000-0000-4000-8000-0000000000a1"
    with job_db.engine.begin() as conn:
        conn.execute(
            text("INSERT INTO users (id, name, email, role, active) VALUES (:id, 'Someone', :email, :role, :active)"),
            {"id": user_id, "email": email, "role": role, "active": active},
        )
    return user_id


def _add_session(job_db: JobDb, user_id: str) -> None:
    with job_db.engine.begin() as conn:
        conn.execute(
            text("INSERT INTO sessions (id, data, expires_at, user_id) VALUES ('s1', :data, :exp, :uid)"),
            {"data": json.dumps({"userId": user_id}), "exp": 9_999_999_999_999, "uid": user_id},
        )


def _session_revoked(job_db: JobDb) -> bool:
    with job_db.engine.connect() as conn:
        return bool(conn.execute(text("SELECT revoked FROM sessions WHERE id = 's1'")).scalar_one())


def test_creates_the_admin_with_a_one_time_password(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    code, out, _err = _run(job_db, monkeypatch, capsys, BOOTSTRAP_ADMIN_EMAIL="  First.Admin@Example.COM ")
    assert code == 0
    assert out == f"bootstrap-admin: created admin {EMAIL}; the one-time password must be changed at first sign-in.\n"
    user = _user(job_db)
    assert (user.name, user.role, bool(user.active), bool(user.must_change_password)) == (
        "Administrator",
        "admin",
        True,
        True,
    )
    assert verify_password(PASSWORD, user.password_hash, user.password_salt)
    assert _audit(job_db) == [("user_created", {"role": "admin", "via": "bootstrap-admin"})]


def test_uses_the_given_name(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert _run(job_db, monkeypatch, capsys, BOOTSTRAP_ADMIN_NAME="Ops Admin")[0] == 0
    assert _user(job_db).name == "Ops Admin"


def test_an_existing_account_with_a_password_is_left_unchanged(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _run(job_db, monkeypatch, capsys)
    before = _user(job_db)
    code, out, _err = _run(job_db, monkeypatch, capsys, BOOTSTRAP_ADMIN_PASSWORD="a-different-long-password-2")
    assert code == 0
    assert out == f"bootstrap-admin: {EMAIL} already exists -- left unchanged.\n"
    assert _user(job_db) == before
    assert len(_audit(job_db)) == 1


def test_an_entra_account_without_a_password_becomes_the_admin(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    run_migrations(job_db.engine)
    user_id = _add_user(job_db, EMAIL, role="viewer", active=False)
    _add_session(job_db, user_id)
    code, out, _err = _run(job_db, monkeypatch, capsys)
    assert code == 0
    assert out == (
        f"bootstrap-admin: {EMAIL} existed without a Canvas password (an Entra account) -- now an admin with the"
        " one-time password.\n"
    )
    user = _user(job_db)
    assert (user.role, bool(user.active), bool(user.must_change_password), user.name) == (
        "admin",
        True,
        True,
        "Someone",
    )
    assert verify_password(PASSWORD, user.password_hash, user.password_salt)
    assert _session_revoked(job_db)
    assert _audit(job_db) == [("password_reset", {"via": "bootstrap-admin", "reason": "no_canvas_password"})]


def test_reset_makes_the_account_an_active_unlocked_admin_without_two_step_verification(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _run(job_db, monkeypatch, capsys)
    user_id = str(_user(job_db).id)
    with job_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE users SET role = 'viewer', active = :no WHERE id = :id"), {"no": False, "id": user_id}
        )
        conn.execute(
            text(
                "UPDATE local_credentials SET must_change_password = :no, failed_attempts = 3,"
                " locked_at = CURRENT_TIMESTAMP WHERE user_id = :id"
            ),
            {"no": False, "id": user_id},
        )
        conn.execute(
            text("INSERT INTO user_mfa (user_id, secret_encrypted) VALUES (:id, 'x')"),
            {"id": user_id},
        )
        conn.execute(
            text("INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES (:rid, :id, 'h')"),
            {"rid": "00000000-0000-4000-8000-0000000000b1", "id": user_id},
        )
    _add_session(job_db, user_id)

    new_password = "another-long-recovery-password"
    code, out, _err = _run(job_db, monkeypatch, capsys, BOOTSTRAP_MODE="reset", BOOTSTRAP_ADMIN_PASSWORD=new_password)
    assert code == 0
    assert out == (
        f"bootstrap-admin: {EMAIL} is an active, unlocked admin again with a new one-time password and no two-step"
        " verification (set up again at sign-in); signed out everywhere.\n"
    )
    user = _user(job_db)
    assert (user.role, bool(user.active), bool(user.must_change_password)) == ("admin", True, True)
    assert (user.failed_attempts, user.locked_at) == (0, None)
    assert verify_password(new_password, user.password_hash, user.password_salt)
    with job_db.engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM user_mfa")).scalar_one() == 0
        assert conn.execute(text("SELECT COUNT(*) FROM mfa_recovery_codes")).scalar_one() == 0
    assert _session_revoked(job_db)
    assert _audit(job_db)[-1] == (
        "password_reset",
        {"via": "bootstrap-admin", "unlocked": True, "mfaReset": True},
    )


def test_reset_of_a_missing_account_fails(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    code, out, err = _run(job_db, monkeypatch, capsys, BOOTSTRAP_MODE="reset")
    assert (code, out) == (1, "")
    assert err == f"No account with the email {EMAIL} -- nothing to reset.\n"


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({"BOOTSTRAP_MODE": "upsert"}, "BOOTSTRAP_MODE must be create or reset (got: upsert)"),
        ({"BOOTSTRAP_MODE": ""}, "BOOTSTRAP_MODE must be create or reset (got: )"),
        ({"BOOTSTRAP_ADMIN_EMAIL": None}, "BOOTSTRAP_ADMIN_EMAIL is required."),
        ({"BOOTSTRAP_ADMIN_EMAIL": ""}, "BOOTSTRAP_ADMIN_EMAIL is required."),
        (
            {"BOOTSTRAP_ADMIN_PASSWORD": None},
            "BOOTSTRAP_ADMIN_PASSWORD doesn't meet the password policy: Passwords must be at least 12 characters.",
        ),
        (
            {"BOOTSTRAP_ADMIN_PASSWORD": "first.admin-123456"},
            "BOOTSTRAP_ADMIN_PASSWORD doesn't meet the password policy: Passwords can't contain your email address.",
        ),
    ],
)
def test_bad_settings_fail_before_touching_the_database(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    env: dict[str, str | None],
    message: str,
) -> None:
    code, out, err = _run(job_db, monkeypatch, capsys, **env)
    assert (code, out, err) == (1, "", message + "\n")
    with job_db.engine.connect() as conn:
        assert conn.dialect.has_table(conn, "users") is False


def test_the_admin_signs_in_and_must_change_the_password(make_site: Any) -> None:
    """Through the app, as the TypeScript test: the account behaves like one an admin created."""
    site = make_site(allow_local_auth_setting="true")
    message = job.bootstrap_admin(
        site.api.engine, {"BOOTSTRAP_ADMIN_EMAIL": EMAIL, "BOOTSTRAP_ADMIN_PASSWORD": PASSWORD}
    )
    assert "created admin" in message
    response, cookie = site.login(EMAIL, PASSWORD)
    assert response.status_code == 200
    user = response.json()["user"]
    assert (user["role"], user["mustChangePassword"], user["localAccount"]) == ("admin", True, True)
    assert site.get("/projects", cookie).json()["code"] == "PASSWORD_CHANGE_REQUIRED"
