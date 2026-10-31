"""canvas-1bty.2: sessions made by the TypeScript service (apps/api) work in the Python service.

The signature vectors below were made by the real @fastify/cookie Signer with the TypeScript tests'
secret:
  node -e "const {Signer}=require('@fastify/cookie');
           console.log(new Signer('test-secret-at-least-32-characters-long').sign('abc'))"
The session JSON has the shape @fastify/session stores (checked against a real row, 2026-10-31).
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from canvas_api.auth.cookie_signer import sign, unsign
from canvas_api.auth.session import load_session, signed_in_user
from canvas_api.config import Settings
from tests.conftest import TEST_SESSION_SECRET

VECTORS = [
    ("Zx8kq3c2b1a0-session-id", "Zx8kq3c2b1a0-session-id.H2Z4y7SsiKxnKASezASjrHUIB1TF8tzUjidulU18t/0"),
    ("a+b/c=d", "a+b/c=d.Ru9RaMv9iBy9h1GxSJatuFs6qjAINsLwuJwB7u8LRxo"),
    ("abc", "abc.XSos8emNwx7iExh7RZdldI6Pi5So63/EtT9F/PNkLN4"),
]
HOUR_MS = 60 * 60 * 1000


@pytest.mark.parametrize(("value", "signed"), VECTORS)
def test_signatures_match_fastify_cookie(value: str, signed: str) -> None:
    assert sign(value, TEST_SESSION_SECRET) == signed
    assert unsign(signed, TEST_SESSION_SECRET) == value


@pytest.mark.parametrize(
    "tampered",
    [
        "abd.XSos8emNwx7iExh7RZdldI6Pi5So63/EtT9F/PNkLN4",  # other id, same signature
        "abc.XSos8emNwx7iExh7RZdldI6Pi5So63/EtT9F/PNkLN5",  # signature changed
        "abc.XSos8emNwx7iExh7RZdldI6Pi5So63/EtT9F/PNkLN4=",  # padding added
        "abc",  # no signature
        ".XSos8emNwx7iExh7RZdldI6Pi5So63/EtT9F/PNkLN4",  # no id
        "",
    ],
)
def test_a_tampered_or_unsigned_cookie_is_rejected(tampered: str) -> None:
    assert unsign(tampered, TEST_SESSION_SECRET) is None


def test_a_different_secret_is_rejected() -> None:
    assert unsign(VECTORS[2][1], "another-secret-that-is-at-least-32-chars") is None


def _js_date(ms: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + f".{ms % 1000:03d}Z"


def _user(**over: Any) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "email": "olivia@example.com",
        "name": "Olivia Owner",
        "role": "architect",
        "personas": ["solution"],
        "localAccount": True,
        "mustChangePassword": False,
        "mfaEnabled": False,
        "mustEnrollMfa": False,
        **over,
    }


@pytest.fixture()
def make_session(engine: Engine) -> Iterator[Any]:
    """Writes a session row the way apps/api's DbSessionStore does; returns the cookie to send."""
    ids: list[str] = []

    def make(
        user: dict[str, Any] | None,
        *,
        authenticated_ago_ms: int = 0,
        expires_in_ms: int = 8 * HOUR_MS,
        row_expires_in_ms: int | None = None,
        revoked: bool = False,
    ) -> str:
        now = int(time.time() * 1000)
        session_id = uuid4().hex
        data: dict[str, Any] = {
            "cookie": {
                "expires": _js_date(now + expires_in_ms),
                "originalMaxAge": 8 * HOUR_MS,
                "originalExpires": _js_date(now + expires_in_ms - 1000),
                "sameSite": "lax",
                "secure": False,
                "path": "/",
                "httpOnly": True,
                "domain": None,
            }
        }
        if user is not None:
            data["user"] = user
            data["authenticatedAt"] = now - authenticated_ago_ms
        row_expiry = now + (expires_in_ms if row_expires_in_ms is None else row_expires_in_ms)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO sessions (id, data, expires_at, user_id, revoked) "
                    "VALUES (:id, :data, :exp, :uid, :rev)"
                ),
                {
                    "id": session_id,
                    "data": json.dumps(data),
                    "exp": row_expiry,
                    "uid": user["id"] if user else None,
                    "rev": revoked,
                },
            )
        ids.append(session_id)
        return quote(sign(session_id, TEST_SESSION_SECRET), safe="")

    yield make


def _me(client: TestClient, cookie: str | None) -> Any:
    if cookie is not None:
        client.cookies.set("cid", cookie)
    return client.get("/py/me")


def test_a_session_signed_in_through_typescript_works_here(client: TestClient, make_session: Any) -> None:
    user = _user(role="admin")
    res = _me(client, make_session(user))
    assert res.status_code == 200, res.text
    assert res.json() == {"id": user["id"], "email": user["email"], "role": "admin", "service": "python"}


def test_no_cookie_is_401_in_the_typescript_shape(client: TestClient) -> None:
    res = client.get("/py/me")
    assert res.status_code == 401
    assert res.json() == {"error": "Authentication required"}


def test_a_cookie_signed_with_another_secret_is_401(client: TestClient, make_session: Any) -> None:
    make_session(_user())
    forged = quote(sign(uuid4().hex, "another-secret-that-is-at-least-32-chars"), safe="")
    assert _me(client, forged).status_code == 401


@pytest.mark.parametrize(
    "case",
    [
        {"revoked": True},  # signed out / ended by an admin (canvas-bj7)
        {"row_expires_in_ms": -1000},  # past the row's expiry
        {"expires_in_ms": -1000, "row_expires_in_ms": HOUR_MS},  # past the cookie expiry stored in it
        {"authenticated_ago_ms": 13 * HOUR_MS},  # past SESSION_MAX_HOURS (12) since sign-in
    ],
    ids=["revoked", "row expired", "cookie expired", "past the absolute lifetime"],
)
def test_ended_sessions_are_not_signed_in(client: TestClient, make_session: Any, case: dict[str, Any]) -> None:
    assert _me(client, make_session(_user(), **case)).status_code == 401


def test_a_session_that_is_not_signed_in_yet_is_401(client: TestClient, make_session: Any) -> None:
    assert _me(client, make_session(None)).status_code == 401


@pytest.mark.parametrize(
    ("flag", "code"),
    [("mustChangePassword", "PASSWORD_CHANGE_REQUIRED"), ("mustEnrollMfa", "MFA_ENROLLMENT_REQUIRED")],
)
def test_must_change_password_or_enrol_mfa_blocks_like_typescript(
    client: TestClient, make_session: Any, flag: str, code: str
) -> None:
    res = _me(client, make_session(_user(**{flag: True})))
    assert res.status_code == 403
    assert res.json()["code"] == code


def test_each_request_moves_the_idle_expiry_forward_and_resends_the_cookie(
    client: TestClient, make_session: Any, engine: Engine, settings: Settings
) -> None:
    cookie = make_session(_user(), expires_in_ms=HOUR_MS)
    session_id = unsign(cookie.replace("%2F", "/").replace("%2B", "+"), TEST_SESSION_SECRET)
    assert session_id is not None
    before = load_session(engine, session_id)
    assert before is not None

    res = _me(client, cookie)
    assert res.status_code == 200
    set_cookie = res.headers["set-cookie"]
    assert set_cookie.startswith("cid=")
    assert f"Max-Age={8 * 60 * 60}" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie

    after = load_session(engine, session_id)
    assert after is not None
    with engine.connect() as conn:
        expires_at = conn.execute(
            text("SELECT expires_at FROM sessions WHERE id = :id"), {"id": session_id}
        ).scalar_one()
    assert int(expires_at) > int(time.time() * 1000) + 7 * HOUR_MS
    # Saved the way @fastify/session saves a rolled session.
    assert after["cookie"]["originalExpires"] == before["cookie"]["expires"]
    assert after["cookie"]["expires"] != before["cookie"]["expires"]
    assert after["user"] == before["user"]
    assert signed_in_user(after, settings) is not None


def test_touching_never_revives_a_revoked_session(make_session: Any, engine: Engine, settings: Settings) -> None:
    from canvas_api.auth.session import touch_session

    cookie = make_session(_user(), revoked=True)
    session_id = unsign(cookie.replace("%2F", "/").replace("%2B", "+"), TEST_SESSION_SECRET)
    assert session_id is not None
    with engine.connect() as conn:
        before = conn.execute(text("SELECT data, expires_at FROM sessions WHERE id = :id"), {"id": session_id}).one()
    touch_session(engine, session_id, {"cookie": {}, "user": _user()}, settings)
    with engine.connect() as conn:
        after = conn.execute(
            text("SELECT revoked, data, expires_at FROM sessions WHERE id = :id"), {"id": session_id}
        ).one()
    assert bool(after.revoked) is True
    assert (after.data, int(after.expires_at)) == (before.data, int(before.expires_at))
