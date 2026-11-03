"""The dev/demo seed (apps/api/src/seed/run.ts): the catalog seed, then three demo accounts with PUBLISHED local
passwords, a "Smoke Test" project owned by the admin, and the architect's edit grant on it. Idempotent.

Refuses AUTH_MODE=local, where those accounts would be real, working sign-ins: a local-mode environment gets its
first admin from jobs/bootstrap_admin.py instead.

Usage: python -m canvas_api.jobs.seed_demo   (DATABASE_URL, DB_CLIENT, SESSION_SECRET)
"""

from __future__ import annotations

import os
import sys
import traceback
from uuid import uuid4

from sqlalchemy import Connection, Engine, text

from canvas_api.auth.passwords import hash_password
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.seed import seed_catalog

LOCAL_MODE_REFUSAL = (
    "The demo seed refuses to run with AUTH_MODE=local (its accounts have published passwords). "
    "Use bootstrap-admin instead."
)


class LocalModeError(RuntimeError):
    pass


def _ensure_user(conn: Connection, name: str, email: str, role: str, password: str) -> str:
    """The user's id; an existing account (by email) is left as it is, password included."""
    existing = conn.execute(text("SELECT id FROM users WHERE email = :email"), {"email": email}).first()
    if existing is not None:
        return str(existing.id)
    user_id = str(uuid4())
    conn.execute(
        text("INSERT INTO users (id, name, email, role) VALUES (:id, :name, :email, :role)"),
        {"id": user_id, "name": name, "email": email, "role": role},
    )
    password_hash, salt = hash_password(password)
    conn.execute(
        text("INSERT INTO local_credentials (user_id, password_hash, password_salt) VALUES (:id, :hash, :salt)"),
        {"id": user_id, "hash": password_hash, "salt": salt},
    )
    return user_id


def seed_demo(engine: Engine, auth_mode: str | None = None) -> str:
    """Seeds the demo data; returns the Smoke Test project's id. `auth_mode` is AUTH_MODE as set (None = unset)."""
    if auth_mode == "local":
        raise LocalModeError(LOCAL_MODE_REFUSAL)
    seed_catalog(engine)
    with engine.begin() as conn:
        admin_id = _ensure_user(conn, "Admin", "admin@example.com", "admin", "admin-dev-password")
        architect_id = _ensure_user(conn, "Architect", "architect@example.com", "architect", "architect-dev-password")
        # Deliberately no project ownership or grant (feature 008): the "diagram grant, no project access" case.
        _ensure_user(conn, "Guest", "guest@example.com", "viewer", "guest-dev-password")

        project = conn.execute(text("SELECT id FROM projects WHERE name = :name"), {"name": "Smoke Test"}).first()
        if project is not None:
            project_id = str(project.id)
        else:
            project_id = str(uuid4())
            conn.execute(
                text("INSERT INTO projects (id, name, owner_id) VALUES (:id, :name, :owner)"),
                {"id": project_id, "name": "Smoke Test", "owner": admin_id},
            )
        # Project visibility follows ownership (feature 007), so the architect needs an explicit grant.
        conn.execute(
            text(
                "INSERT INTO share_grants"
                " (id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id)"
                " VALUES (:id, 'project', :project, :grantee, 'edit', :granted_by)"
                " ON CONFLICT (subject_type, subject_id, grantee_user_id) DO NOTHING"
            ),
            {"id": str(uuid4()), "project": project_id, "grantee": architect_id, "granted_by": admin_id},
        )
    return project_id


def main() -> int:
    auth_mode = os.environ.get("AUTH_MODE")
    if auth_mode == "local":
        # Before anything touches the database, as TypeScript.
        print(LOCAL_MODE_REFUSAL, file=sys.stderr)
        return 1
    settings = Settings()  # type: ignore[call-arg]  # read from the environment
    engine = create_db_engine(settings)
    try:
        project_id = seed_demo(engine, auth_mode)
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        engine.dispose()
    print("Seed complete.")
    print("  Admin login: admin@example.com / admin-dev-password")
    print("  Architect login: architect@example.com / architect-dev-password")
    print("  Guest login: guest@example.com / guest-dev-password (no project access)")
    print(f"  Project id: {project_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
