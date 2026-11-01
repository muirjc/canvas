"""Helpers for the route tests: a clean database, seeded rows, signed-in users, and a client that holds
every response to the API contract (apps/api/contract/openapi.json, written by the TypeScript tests).

Routes that haven't moved to Python yet (standards, export, AI chat) aren't callable here, so tests
seed those rows directly -- the cases come from apps/api/tests/contract, the setup doesn't.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
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
#: A fixed past instant for seeding rows whose order matters (a row's own timestamp is never "now").
T0 = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)


def minutes_after(start: datetime, minutes: int) -> datetime:
    return start + timedelta(minutes=minutes)


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
    content = documented.get("content") or {}
    media_type = response.headers.get("content-type", "").split(";")[0].strip()
    if content and "application/json" not in content:
        # A file, not JSON (export): its type must be one the contract lists.
        assert media_type in content, f"{where} answered {media_type!r}, not one of {sorted(content)}"
        return
    schema = content.get("application/json", {}).get("schema")
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
    "diagram_comment_reads",
    "diagram_comments",
    "mfa_recovery_codes",
    "user_mfa",
    "share_grants",
    "diagram_edit_sessions",
    "diagram_submission_pushes",
    "diagram_submissions",
    "github_links",
    "diagram_versions",
    "diagrams",
    "templates",
    "standard_allowed_shapes",
    "standard_mandatory_shapes",
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

    def comment(
        self,
        diagram_id: str,
        author: User,
        body: str = "A comment",
        *,
        root: str | None = None,
        anchor: tuple[str, str] | None = None,
        at: datetime | None = None,
        deleted: bool = False,
    ) -> str:
        """A comment seeded directly, at an explicit instant (so ordering and unread counts are exact)."""
        comment_id = str(uuid4())
        when = to_db(at or T0, self.dialect)
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO diagram_comments (id, diagram_id, thread_root_id, author_id, body, anchor_type,"
                    " anchor_id, created_at, deleted_at) VALUES (:id, :diagram, :root, :author, :body, :atype,"
                    " :aid, :at, :deleted)"
                ),
                {
                    "id": comment_id,
                    "diagram": diagram_id,
                    "root": root,
                    "author": author.id,
                    "body": "" if deleted else body,
                    "atype": anchor[0] if anchor else None,
                    "aid": anchor[1] if anchor else None,
                    "at": when,
                    "deleted": when if deleted else None,
                },
            )
        return comment_id

    def credentials(self, user: User, *, locked: bool = False) -> None:
        """A local account's password row (hash and salt are placeholders: nothing here signs in)."""
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO local_credentials (user_id, password_hash, password_salt, locked_at)"
                    " VALUES (:id, :hash, :salt, :locked)"
                ),
                {
                    "id": user.id,
                    "hash": "placeholder",
                    "salt": "placeholder",
                    "locked": to_db(T0, self.dialect) if locked else None,
                },
            )

    def mfa(self, user: User, *, enabled: bool = True) -> None:
        """Two-step verification for a user, with one recovery code."""
        with self.engine.begin() as conn:
            conn.execute(
                text("INSERT INTO user_mfa (user_id, secret_encrypted, enabled_at) VALUES (:id, :secret, :at)"),
                {"id": user.id, "secret": "v1:x:y:z", "at": to_db(T0, self.dialect) if enabled else None},
            )
            conn.execute(
                text("INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES (:id, :user, :hash)"),
                {"id": str(uuid4()), "user": user.id, "hash": "abc"},
            )

    def audit_event(
        self,
        event: str,
        *,
        actor: User | None = None,
        target: User | None = None,
        at: datetime | None = None,
        ip: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> str:
        event_id = str(uuid4())
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO audit_events (id, occurred_at, event, actor_user_id, target_user_id, ip, detail)"
                    " VALUES (:id, :at, :event, :actor, :target, :ip, :detail)"
                ),
                {
                    "id": event_id,
                    "at": to_db(at or T0, self.dialect),
                    "event": event,
                    "actor": actor.id if actor else None,
                    "target": target.id if target else None,
                    "ip": ip,
                    "detail": json.dumps(detail) if detail else None,
                },
            )
        return event_id

    def standard(self, diagram_type_id: str, status: str = "published", version: int = 1) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                text("INSERT INTO standards (id, diagram_type_id, version, status) VALUES (:id, :type, :v, :status)"),
                {"id": str(uuid4()), "type": diagram_type_id, "v": version, "status": status},
            )

    def published_standard(
        self,
        diagram_type_id: str,
        *,
        allowed_shapes: list[str] | None = None,
        mandatory_shapes: list[str] | None = None,
        kind_rules: dict[str, Any] | None = None,
        version: int = 1,
    ) -> None:
        """A published standard with rules, the way apps/api's standard service stores them: shape join tables
        plus the v2 rules (element kinds, connector rules, ...) as one JSON column."""
        standard_id = str(uuid4())
        rules = json.dumps(kind_rules or {})
        insert = {
            "postgresql": (
                "INSERT INTO standards (id, diagram_type_id, version, status, kind_rules)"
                " VALUES (:id, :type, :v, 'published', CAST(:rules AS JSONB))"
            ),
            "sqlite": (
                "INSERT INTO standards (id, diagram_type_id, version, status, kind_rules)"
                " VALUES (:id, :type, :v, 'published', :rules)"
            ),
        }[self.dialect]
        with self.engine.begin() as conn:
            conn.execute(text(insert), {"id": standard_id, "type": diagram_type_id, "v": version, "rules": rules})
            for position, shape in enumerate(allowed_shapes or []):
                conn.execute(
                    text("INSERT INTO standard_allowed_shapes (standard_id, shape_id, position) VALUES (:s, :h, :i)"),
                    {"s": standard_id, "h": shape, "i": position},
                )
            for position, shape in enumerate(mandatory_shapes or []):
                conn.execute(
                    text("INSERT INTO standard_mandatory_shapes (standard_id, shape_id, position) VALUES (:s, :h, :i)"),
                    {"s": standard_id, "h": shape, "i": position},
                )

    def new_diagram(
        self,
        project_id: str,
        who: User,
        name: str = "D",
        diagram_type_id: str = "flowchart",
        dsl: str | None = None,
        *,
        draft: bool | None = None,
    ) -> dict[str, Any]:
        """A diagram made through POST /projects/:id/diagrams, so it has a real first version (needs_bridge)."""
        payload: dict[str, Any] = {"name": name, "diagramTypeId": diagram_type_id}
        if dsl is not None:
            payload["initialDslContent"] = dsl
        if draft is not None:
            payload["draft"] = draft
        response = self.call("POST", f"/projects/{project_id}/diagrams", who, json=payload)
        assert response.status_code == 201, response.text
        diagram: dict[str, Any] = response.json()["diagram"]
        return diagram

    def save_diagram(
        self, who: User, diagram: dict[str, Any] | str, dsl: str, base: str | None = None
    ) -> httpx.Response:
        """PATCH /diagrams/:id from `base` (default: the diagram's current version, read from the database)."""
        diagram_id = diagram if isinstance(diagram, str) else diagram["id"]
        return self.call(
            "PATCH",
            f"/diagrams/{diagram_id}",
            who,
            json={"dslContent": dsl, "baseVersionId": base or self.current_version(diagram_id)},
        )

    def current_version(self, diagram_id: str) -> str:
        return str(self.scalar("SELECT current_version_id FROM diagrams WHERE id = :id", id=diagram_id))

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
