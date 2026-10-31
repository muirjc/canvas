"""Reads the sessions the TypeScript service writes (apps/api/src/auth/session.ts, session-store.ts).

A browser signed in through either service is signed in to both: same cookie (`cid`), same signature,
same `sessions` rows. The rules match the TypeScript side:
- the cookie's signature must check out (SESSION_SECRET);
- the row must exist, not be revoked, and not be past `expires_at` or the cookie expiry stored in it;
- a signed-in session ends SESSION_MAX_HOURS after sign-in (`authenticatedAt`), however active;
- each request moves the idle expiry forward (@fastify/session's `rolling`), in the row and the cookie;
- someone who must change a one-time password or set up two-step verification can only reach /auth/*
  and /health until they do.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import unquote

from fastapi import Request, Response
from pydantic import BaseModel
from sqlalchemy import Engine, text

from canvas_api.auth.cookie_signer import unsign
from canvas_api.config import Settings
from canvas_api.errors import ApiError

SESSION_COOKIE_NAME = "cid"


class SessionUser(BaseModel):
    """apps/api/src/auth/types.ts SessionUser."""

    id: str
    email: str
    name: str
    role: Literal["admin", "architect", "viewer"]
    personas: list[str] = []
    localAccount: bool | None = None
    mustChangePassword: bool | None = None
    mustEnrollMfa: bool | None = None
    mfaEnabled: bool | None = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso_ms(ms: int) -> str:
    """A JavaScript Date's toJSON(): 2026-10-31T12:00:00.000Z."""
    return datetime.fromtimestamp(ms / 1000, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def _parse_js_date(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def session_id_from_request(request: Request, settings: Settings) -> str | None:
    raw = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw:
        return None
    # @fastify/cookie URL-encodes the value (the base64 signature can hold + and /); Starlette doesn't decode.
    return unsign(unquote(raw), settings.session_secret)


def load_session(engine: Engine, session_id: str, now_ms: int | None = None) -> dict[str, Any] | None:
    """The stored session, or None when there's no live one."""
    now = _now_ms() if now_ms is None else now_ms
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT data, expires_at, revoked FROM sessions WHERE id = :id"), {"id": session_id}
        ).first()
    if row is None or bool(row.revoked) or int(row.expires_at) <= now:
        return None
    data: dict[str, Any] = json.loads(row.data)
    # @fastify/session rebuilds the cookie from the stored `expires` and checks that (lib/cookie.js);
    # the stored `originalExpires` is only the previous value.
    expiry = _parse_js_date((data.get("cookie") or {}).get("expires"))
    if expiry is not None and expiry <= now:
        return None
    return data


def signed_in_user(data: dict[str, Any], settings: Settings, now_ms: int | None = None) -> SessionUser | None:
    user = data.get("user")
    if not user:
        return None
    now = _now_ms() if now_ms is None else now_ms
    authenticated_at = data.get("authenticatedAt")
    max_ms = settings.session_max_hours * 60 * 60 * 1000
    # bool is an int in Python; a JavaScript number is never a boolean.
    if (
        not isinstance(authenticated_at, int | float)
        or isinstance(authenticated_at, bool)
        or now - authenticated_at > max_ms
    ):
        return None
    return SessionUser.model_validate(user)


def touch_session(
    engine: Engine, session_id: str, data: dict[str, Any], settings: Settings, now_ms: int | None = None
) -> None:
    """Moves the idle expiry forward, never over a revoked row (as DbSessionStore.set)."""
    now = _now_ms() if now_ms is None else now_ms
    expires_at = now + int(settings.session_idle_minutes * 60 * 1000)
    cookie = dict(data.get("cookie") or {})
    # As @fastify/session saves a rolled session: the old expiry becomes originalExpires.
    if "expires" in cookie:
        cookie["originalExpires"] = cookie["expires"]
    cookie["expires"] = _iso_ms(expires_at)
    updated = {**data, "cookie": cookie}
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE sessions SET data = :data, expires_at = :expires_at WHERE id = :id AND revoked = :no"),
            {
                "data": json.dumps(updated, separators=(",", ":")),
                "expires_at": expires_at,
                "id": session_id,
                "no": False,
            },
        )


def refresh_cookie(response: Response, request: Request, settings: Settings) -> None:
    """Re-sends the same cookie with a fresh Max-Age, as @fastify/session does on every response."""
    raw = request.cookies.get(SESSION_COOKIE_NAME)
    if raw is None:
        return
    response.set_cookie(
        SESSION_COOKIE_NAME,
        unquote(raw),
        max_age=int(settings.session_idle_minutes * 60),
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_same_site,
    )


def current_user(request: Request, response: Response) -> SessionUser:
    """FastAPI dependency: the signed-in user, or 401 like apps/api's requireAuth."""
    settings: Settings = request.app.state.settings
    engine: Engine = request.app.state.db
    session_id = session_id_from_request(request, settings)
    data = load_session(engine, session_id) if session_id else None
    user = signed_in_user(data, settings) if data else None
    if user is None or session_id is None or data is None:
        raise ApiError(401, "Authentication required")
    path = request.url.path
    if not (path.startswith("/auth/") or path == "/health"):
        if user.mustChangePassword:
            raise ApiError(403, "Change your one-time password before continuing.", "PASSWORD_CHANGE_REQUIRED")
        if user.mustEnrollMfa:
            raise ApiError(403, "Set up two-step verification before continuing.", "MFA_ENROLLMENT_REQUIRED")
    touch_session(engine, session_id, data, settings)
    refresh_cookie(response, request, settings)
    return user
