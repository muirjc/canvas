"""Helpers for the route tests: a clean database, seeded rows, signed-in users, and a client that holds
every response to the API contract (apps/api/contract/openapi.json, written by the TypeScript tests).

Routes that haven't moved to Python yet (creating diagrams, sharing) aren't callable here, so tests
seed those rows directly -- the cases come from apps/api/tests/contract, the setup doesn't.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from sqlalchemy import Engine, text

from canvas_api.auth.cookie_signer import sign
from canvas_api.timestamps import to_db
from tests.conftest import TEST_SESSION_SECRET

CONTRACT_DIR = Path(__file__).resolve().parents[2] / "api" / "contract"
CONTRACT: dict[str, Any] = json.loads((CONTRACT_DIR / "openapi.json").read_text(encoding="utf-8"))
ALL_PERSONAS = ["Business", "Enterprise", "Solution", "Technical"]
MISSING_ID = "00000000-0000-0000-0000-000000000000"
HOUR_MS = 60 * 60 * 1000

# --- the contract -----------------------------------------------------------------------------------

#: A JavaScript Date's toJSON(), or the TypeScript service's normalized SQLite CURRENT_TIMESTAMP.
JS_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$")
_formats = FormatChecker()


@_formats.checks("date-time")
def _is_js_date_time(value: object) -> bool:
    return not isinstance(value, str) or bool(JS_ISO.match(value))


def _operations() -> list[tuple[str, re.Pattern[str], str, dict[str, Any]]]:
    ops = []
    for path, methods in CONTRACT["paths"].items():
        pattern = re.compile("^" + re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(path)) + "$")
        for method, operation in methods.items():
            ops.append((method.upper(), pattern, path, operation))
    return ops


OPERATIONS = _operations()


def contract_operation(method: str, path: str) -> tuple[str, dict[str, Any]] | None:
    """The contract's operation for a request, preferring a literal path over a templated one."""
    matches = [(p, op) for m, pattern, p, op in OPERATIONS if m == method and pattern.match(path)]
    matches.sort(key=lambda match: match[0].count("{"))
    return matches[0] if matches else None


def check_contract(response: httpx.Response) -> None:
    """Fails unless the response is one the contract describes, in the shape it describes."""
    request = response.request
    found = contract_operation(request.method, urlsplit(str(request.url)).path)
    if found is None:
        return  # not a moved route (e.g. /py/me)
    path, operation = found
    responses = operation["responses"]
    status = str(response.status_code)
    documented = responses.get(status) or responses.get(f"{status[0]}XX")
    where = f"{request.method} {path} -> {status}"
    assert documented is not None, f"{where} is not in the contract: {response.text}"
    schema = (documented.get("content") or {}).get("application/json", {}).get("schema")
    if schema is None:
        assert response.content == b"", f"{where} should have no body"
        return
    root = {**schema, "components": CONTRACT["components"]}
    errors = sorted(Draft202012Validator(root, format_checker=_formats).iter_errors(response.json()), key=str)
    assert not errors, f"{where} breaks the contract: " + "; ".join(
        f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}" for e in errors[:5]
    )


# --- the database -----------------------------------------------------------------------------------

#: Children before parents, for both engines (no TRUNCATE in SQLite).
_TABLES = (
    "audit_events",
    "sessions",
    "share_grants",
    "diagram_versions",
    "diagrams",
    "templates",
    "standards",
    "icon_keywords",
    "icons",
    "icon_libraries",
    "diagram_type_palette_libraries",
    "diagram_types_personas",
    "diagram_types",
    "projects",
    "users_personas",
    "local_credentials",
    "users",
)


def reset(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("UPDATE diagrams SET current_version_id = NULL"))
        for table in _TABLES:
            conn.execute(text(f"DELETE FROM {table}"))  # noqa: S608 - fixed names
        conn.execute(text("UPDATE app_settings SET sharing_enabled = :no"), {"no": False})


@dataclass(frozen=True)
class User:
    id: str
    email: str
    role: str
    cookie: str


def _js_date(ms: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + f".{ms % 1000:03d}Z"


class Api:
    """A test client plus seeding helpers over one clean database."""

    def __init__(self, client: TestClient, engine: Engine) -> None:
        self.client = client
        self.engine = engine
        self.dialect = engine.dialect.name

    # -- requests ---------------------------------------------------------------------------------

    def call(self, method: str, url: str, who: User | None = None, json: Any = None, **kwargs: Any) -> httpx.Response:
        """One request as `who` (signed out when None), checked against the contract."""
        self.client.cookies.clear()
        if who is not None:
            self.client.cookies.set("cid", who.cookie)
        if json is not None:
            kwargs["json"] = json
        response = self.client.request(method, url, **kwargs)
        check_contract(response)
        return response

    # -- seeding ----------------------------------------------------------------------------------

    def user(self, email: str, role: str = "architect", name: str | None = None) -> User:
        """A user, signed in: a session row the way apps/api's DbSessionStore writes one."""
        user_id = str(uuid4())
        now = int(time.time() * 1000)
        session_id = uuid4().hex
        session = {
            "cookie": {
                "expires": _js_date(now + 8 * HOUR_MS),
                "originalMaxAge": 8 * HOUR_MS,
                "sameSite": "lax",
                "secure": False,
                "path": "/",
                "httpOnly": True,
                "domain": None,
            },
            "user": {"id": user_id, "email": email, "name": name or email, "role": role, "personas": []},
            "authenticatedAt": now,
        }
        with self.engine.begin() as conn:
            conn.execute(
                text("INSERT INTO users (id, name, email, role) VALUES (:id, :name, :email, :role)"),
                {"id": user_id, "name": name or email, "email": email, "role": role},
            )
            conn.execute(
                text("INSERT INTO sessions (id, data, expires_at, user_id, revoked) VALUES (:id, :d, :e, :u, :r)"),
                {"id": session_id, "d": json.dumps(session), "e": now + 8 * HOUR_MS, "u": user_id, "r": False},
            )
        return User(user_id, email, role, quote(sign(session_id, TEST_SESSION_SECRET), safe=""))

    def project(
        self, owner: User, name: str = "Test Project", parent: str | None = None, deleted_at: datetime | None = None
    ) -> str:
        project_id = str(uuid4())
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO projects (id, name, parent_project_id, owner_id, deleted_at)"
                    " VALUES (:id, :name, :parent, :owner, :deleted)"
                ),
                {
                    "id": project_id,
                    "name": name,
                    "parent": parent,
                    "owner": owner.id,
                    "deleted": None if deleted_at is None else to_db(deleted_at, self.dialect),
                },
            )
        return project_id

    def diagram(
        self,
        project_id: str,
        owner: User,
        name: str = "D",
        diagram_type_id: str = "flowchart",
        *,
        deleted: bool = False,
        draft: bool = False,
    ) -> str:
        diagram_id = str(uuid4())
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO diagrams (id, name, diagram_type_id, project_id, owner_id, draft, deleted_at)"
                    " VALUES (:id, :name, :type, :project, :owner, :draft, :deleted)"
                ),
                {
                    "id": diagram_id,
                    "name": name,
                    "type": diagram_type_id,
                    "project": project_id,
                    "owner": owner.id,
                    "draft": draft,
                    "deleted": to_db(datetime.now().astimezone(), self.dialect) if deleted else None,
                },
            )
        return diagram_id

    def grant(self, subject_type: str, subject_id: str, grantee: User, level: str, by: User) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO share_grants (id, subject_type, subject_id, grantee_user_id, access_level,"
                    " granted_by_user_id) VALUES (:id, :type, :subject, :grantee, :level, :by)"
                ),
                {
                    "id": str(uuid4()),
                    "type": subject_type,
                    "subject": subject_id,
                    "grantee": grantee.id,
                    "level": level,
                    "by": by.id,
                },
            )

    def diagram_type(
        self,
        type_id: str,
        family: str = "flowchart",
        *,
        name: str | None = None,
        origin: str = "builtin",
        personas: list[str] | None = None,
        palette: list[str] | None = None,
    ) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO diagram_types (id, name, abstraction_level, dsl_family, origin)"
                    " VALUES (:id, :name, 'N/A', :family, :origin)"
                ),
                {"id": type_id, "name": name or type_id, "family": family, "origin": origin},
            )
            for position, persona in enumerate(ALL_PERSONAS if personas is None else personas):
                conn.execute(
                    text("INSERT INTO diagram_types_personas (diagram_type_id, persona, position) VALUES (:t, :p, :i)"),
                    {"t": type_id, "p": persona, "i": position},
                )
            for position, library in enumerate(["generic"] if palette is None else palette):
                conn.execute(
                    text(
                        "INSERT INTO diagram_type_palette_libraries (diagram_type_id, library_id, position)"
                        " VALUES (:t, :l, :i)"
                    ),
                    {"t": type_id, "l": library, "i": position},
                )

    def library(self, library_id: str, version: str, icons: list[dict[str, Any]], license: str | None = None) -> None:
        """icons: {"id", "displayName", "category", "keywords"?, "retired"?}."""
        with self.engine.begin() as conn:
            conn.execute(
                text("INSERT INTO icon_libraries (id, version, license) VALUES (:id, :v, :l)"),
                {"id": library_id, "v": version, "l": license},
            )
            for icon in icons:
                conn.execute(
                    text(
                        "INSERT INTO icons (library_id, library_version, id, display_name, category, asset_ref,"
                        " retired_at) VALUES (:lib, :v, :id, :name, :cat, :asset, :retired)"
                    ),
                    {
                        "lib": library_id,
                        "v": version,
                        "id": icon["id"],
                        "name": icon["displayName"],
                        "cat": icon.get("category", "General"),
                        "asset": f"<svg id='{icon['id']}'/>",
                        "retired": to_db(datetime.now().astimezone(), self.dialect) if icon.get("retired") else None,
                    },
                )
                for position, keyword in enumerate(icon.get("keywords", [])):
                    conn.execute(
                        text(
                            "INSERT INTO icon_keywords (library_id, library_version, icon_id, keyword, position)"
                            " VALUES (:lib, :v, :id, :k, :i)"
                        ),
                        {"lib": library_id, "v": version, "id": icon["id"], "k": keyword, "i": position},
                    )

    def scalar(self, sql: str, **params: Any) -> Any:
        with self.engine.connect() as conn:
            return conn.execute(text(sql), params).scalar()

    def execute(self, sql: str, **params: Any) -> None:
        with self.engine.begin() as conn:
            conn.execute(text(sql), params)
