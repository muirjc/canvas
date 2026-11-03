"""The first admin of an AUTH_MODE=local environment (apps/api/src/seed/bootstrap-admin.ts, canvas-ez1.3), which has
no seeded accounts. Run by the canvas-bootstrap-admin Container Apps job after the migrations; the password reaches
it through Key Vault. Never prints the password.

BOOTSTRAP_MODE=create (default): creates BOOTSTRAP_ADMIN_EMAIL as an admin whose password is a one-time password
  (changed at first sign-in). An existing account with a Canvas password is left unchanged, so every deploy can run
  it; one without (from Entra mode) is given the one-time password and the admin role.
BOOTSTRAP_MODE=reset: recovery for a lone admin who can't sign in (infra/azure/reset-admin.sh): makes the account an
  active, unlocked admin again with BOOTSTRAP_ADMIN_PASSWORD as a new one-time password and no two-step
  verification, signed out everywhere.

Usage: BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... [BOOTSTRAP_ADMIN_NAME=...]
       [BOOTSTRAP_MODE=create|reset] python -m canvas_api.jobs.bootstrap_admin
       (plus DATABASE_URL, DB_CLIENT, SESSION_SECRET). Prints one line; exit code 1 with the error's message.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping

from sqlalchemy import Engine, text

from canvas_api.audit import record_audit
from canvas_api.auth.accounts import create_local_user, normalize_email, reset_mfa, set_one_time_password
from canvas_api.auth.passwords import check_password_policy
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.migrations import run_migrations


class BootstrapError(Exception):
    """A refusal; its message is what the job prints."""


def checked_settings(env: Mapping[str, str]) -> tuple[str, str, str]:
    """(mode, normalized email, password), or BootstrapError. Done before anything touches the database."""
    mode = env.get("BOOTSTRAP_MODE", "create")
    if mode not in ("create", "reset"):
        raise BootstrapError(f"BOOTSTRAP_MODE must be create or reset (got: {mode})")
    if not env.get("BOOTSTRAP_ADMIN_EMAIL"):
        raise BootstrapError("BOOTSTRAP_ADMIN_EMAIL is required.")
    password = env.get("BOOTSTRAP_ADMIN_PASSWORD", "")
    email = normalize_email(env["BOOTSTRAP_ADMIN_EMAIL"])
    problem = check_password_policy(password, email)
    if problem:
        raise BootstrapError(f"BOOTSTRAP_ADMIN_PASSWORD doesn't meet the password policy: {problem}")
    return mode, email, password


def bootstrap_admin(engine: Engine, env: Mapping[str, str]) -> str:
    """Runs the migrations, does the work and returns the line to print. One transaction (TypeScript used several:
    a failure part-way, such as a soft-deleted account in reset mode, now leaves nothing half done)."""
    mode, email, password = checked_settings(env)
    run_migrations(engine)
    with engine.begin() as conn:
        existing = conn.execute(text("SELECT id FROM users WHERE email = :email"), {"email": email}).first()

        if mode == "reset":
            if existing is None:
                raise BootstrapError(f"No account with the email {email} -- nothing to reset.")
            user_id = str(existing.id)
            conn.execute(
                text("UPDATE users SET role = 'admin', active = :yes WHERE id = :id"), {"yes": True, "id": user_id}
            )
            set_one_time_password(conn, user_id, password)
            # canvas-ez1.5: a lost phone is one more way to be locked out -- set it up again on sign-in.
            reset_mfa(conn, user_id)
            record_audit(
                conn,
                "password_reset",
                target_user_id=user_id,
                detail={"via": "bootstrap-admin", "unlocked": True, "mfaReset": True},
            )
            return (
                f"bootstrap-admin: {email} is an active, unlocked admin again with a new one-time password and no"
                " two-step verification (set up again at sign-in); signed out everywhere."
            )

        if existing is not None:
            # An account from Entra mode has no Canvas password: leaving it alone would leave the designated admin
            # unable to sign in. Give it the one-time password and the admin role; one with a password is untouched.
            user_id = str(existing.id)
            credentials = conn.execute(
                text("SELECT user_id FROM local_credentials WHERE user_id = :id"), {"id": user_id}
            ).first()
            if credentials is not None:
                return f"bootstrap-admin: {email} already exists -- left unchanged."
            conn.execute(
                text("UPDATE users SET role = 'admin', active = :yes WHERE id = :id"), {"yes": True, "id": user_id}
            )
            set_one_time_password(conn, user_id, password)
            record_audit(
                conn,
                "password_reset",
                target_user_id=user_id,
                detail={"via": "bootstrap-admin", "reason": "no_canvas_password"},
            )
            return (
                f"bootstrap-admin: {email} existed without a Canvas password (an Entra account) -- now an admin with"
                " the one-time password."
            )

        user = create_local_user(conn, email, env.get("BOOTSTRAP_ADMIN_NAME", "Administrator"), "admin", [], password)
        record_audit(
            conn, "user_created", target_user_id=user["id"], detail={"role": "admin", "via": "bootstrap-admin"}
        )
        return f"bootstrap-admin: created admin {email}; the one-time password must be changed at first sign-in."


def main() -> int:
    env = dict(os.environ)
    engine = None
    try:
        checked_settings(env)
        settings = Settings()  # type: ignore[call-arg]  # read from the environment
        engine = create_db_engine(settings)
        message = bootstrap_admin(engine, env)
    except Exception as exc:
        # The message only, as TypeScript (never the password: no message includes it).
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        if engine is not None:
            engine.dispose()
    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
