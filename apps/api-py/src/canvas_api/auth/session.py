"""Sessions, in the row format the TypeScript service wrote (apps/api/src/auth/session.ts, session-store.ts).

A browser signed in through either service is signed in to both: same cookie (`cid`), same signature,
same `sessions` rows, written in @fastify/session's format. The rules match the TypeScript side:
- the cookie's signature must check out (SESSION_SECRET);
- the row must exist, not be revoked, and not be past `expires_at` or the cookie expiry stored in it;
- a signed-in session ends SESSION_MAX_HOURS after sign-in (`authenticatedAt`), however active; it is then
  revoked, as the TypeScript service replaces it;
- each request moves the idle expiry forward (@fastify/session's `rolling`), in the row and the cookie --
  except that a request which changes nothing else only writes the row when that moves it by at least
  TOUCH_INTERVAL_MS (canvas-qeo8: one write fewer on almost every request), so the idle timeout can end
  up to that much early;
- signing in always starts a new session id and revokes the old one (no session fixation);
- someone who must change a one-time password or set up two-step verification can only reach /auth/*
  and /health until they do.
"""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import quote, unquote

from fastapi import Request, Response
from pydantic import BaseModel
from sqlalchemy import Connection, Engine, text

from canvas_api.auth.cookie_signer import sign, unsign
from canvas_api.config import Settings
from canvas_api.errors import ApiError

SESSION_COOKIE_NAME = "cid"
#: Expired rows are deleted when saving, at most this often per process (session-store.ts PRUNE_INTERVAL_MS).
PRUNE_INTERVAL_MS = 10 * 60 * 1000
_last_prune_ms = 0
#: A signed-in request that changes nothing in the session writes it only when that moves the idle expiry
#: forward by at least this much (canvas-qeo8).
TOUCH_INTERVAL_MS = 60 * 1000


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


@dataclass
class StoredSession:
    """A live session: its id and everything stored in it (the cookie block, `user`, ...)."""

    id: str
    data: dict[str, Any] = field(default_factory=dict)


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


def _idle_ms(settings: Settings) -> int:
    return int(settings.session_idle_minutes * 60 * 1000)


def session_id_from_request(request: Request, settings: Settings) -> str | None:
    raw = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw:
        return None
    # @fastify/cookie URL-encodes the value (the base64 signature can hold + and /); Starlette doesn't decode.
    return unsign(unquote(raw), settings.session_secret)


def _prune_expired(conn: Connection, now: int) -> None:
    """Deletes expired session rows, at most once per PRUNE_INTERVAL_MS (DbSessionStore.pruneIfDue)."""
    global _last_prune_ms
    if now - _last_prune_ms < PRUNE_INTERVAL_MS:
        return
    _last_prune_ms = now
    conn.execute(text("DELETE FROM sessions WHERE expires_at <= :now"), {"now": now})


def load_session(engine: Engine, session_id: str, now_ms: int | None = None) -> dict[str, Any] | None:
    """The stored session, or None when there's no live one."""
    now = _now_ms() if now_ms is None else now_ms
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT data, expires_at, revoked FROM sessions WHERE id = :id"), {"id": session_id}
        ).first()
    if row is None or bool(row.revoked):
        return None
    if int(row.expires_at) <= now:
        # Expired: removed now rather than waiting for the next prune (DbSessionStore.get).
        with engine.begin() as conn:
            conn.execute(
                text("DELETE FROM sessions WHERE id = :id AND expires_at <= :now"), {"id": session_id, "now": now}
            )
        return None
    data: dict[str, Any] = json.loads(row.data)
    # @fastify/session rebuilds the cookie from the stored `expires` and checks that (lib/cookie.js);
    # the stored `originalExpires` is only the previous value.
    expiry = _parse_js_date((data.get("cookie") or {}).get("expires"))
    if expiry is not None and expiry <= now:
        return None
    return data


def _past_max_lifetime(data: dict[str, Any], settings: Settings, now: int) -> bool:
    authenticated_at = data.get("authenticatedAt")
    max_ms = settings.session_max_hours * 60 * 60 * 1000
    # bool is an int in Python; a JavaScript number is never a boolean.
    return (
        not isinstance(authenticated_at, int | float)
        or isinstance(authenticated_at, bool)
        or now - authenticated_at > max_ms
    )


def signed_in_user(data: dict[str, Any], settings: Settings, now_ms: int | None = None) -> SessionUser | None:
    user = data.get("user")
    if not user:
        return None
    now = _now_ms() if now_ms is None else now_ms
    if _past_max_lifetime(data, settings, now):
        return None
    return SessionUser.model_validate(user)


def read_session(request: Request) -> StoredSession | None:
    """The request's live session, or None. A signed-in session past its absolute lifetime is ended here
    (revoked), as the TypeScript service's onRequest hook replaces it with an empty one."""
    settings: Settings = request.app.state.settings
    engine: Engine = request.app.state.db
    session_id = session_id_from_request(request, settings)
    data = load_session(engine, session_id) if session_id else None
    if session_id is None or data is None:
        return None
    if data.get("user") and _past_max_lifetime(data, settings, _now_ms()):
        with engine.begin() as conn:
            end_session(conn, session_id)
        return None
    return StoredSession(session_id, data)


def _rolled_cookie(data: dict[str, Any], expires_at: int) -> dict[str, Any]:
    """As @fastify/session saves a rolled session: the old expiry becomes originalExpires."""
    cookie = dict(data.get("cookie") or {})
    if "expires" in cookie:
        cookie["originalExpires"] = cookie["expires"]
    cookie["expires"] = _iso_ms(expires_at)
    return cookie


def touch_session(
    engine: Engine, session_id: str, data: dict[str, Any], settings: Settings, now_ms: int | None = None
) -> None:
    """Saves the session and moves its idle expiry forward, never over a revoked row (DbSessionStore.set)."""
    now = _now_ms() if now_ms is None else now_ms
    expires_at = now + _idle_ms(settings)
    updated = {**data, "cookie": _rolled_cookie(data, expires_at)}
    user = updated.get("user")
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE sessions SET data = :data, expires_at = :expires_at, user_id = :user_id"
                " WHERE id = :id AND revoked = :no"
            ),
            {
                "data": _to_json(updated),
                "expires_at": expires_at,
                "user_id": user.get("id") if isinstance(user, dict) else None,
                "id": session_id,
                "no": False,
            },
        )
        _prune_expired(conn, now)


def _to_json(data: dict[str, Any]) -> str:
    """JSON.stringify's compact form."""
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def _cookie_value(session_id: str, settings: Settings) -> str:
    """The signed id, URL-encoded as @fastify/cookie writes it (encodeURIComponent)."""
    return quote(sign(session_id, settings.session_secret), safe="-_.!~*'()")


def set_session_cookie(response: Response, session_id: str, settings: Settings) -> None:
    """The session cookie with a fresh Max-Age, as @fastify/session sends it on every response."""
    response.set_cookie(
        SESSION_COOKIE_NAME,
        _cookie_value(session_id, settings),
        max_age=int(settings.session_idle_minutes * 60),
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_same_site,
    )


def save_session(request: Request, response: Response, session: StoredSession) -> None:
    """Saves a session the request read (rolling it forward) and re-sends its cookie."""
    settings: Settings = request.app.state.settings
    touch_session(request.app.state.db, session.id, session.data, settings)
    set_session_cookie(response, session.id, settings)


def start_session(
    conn: Connection,
    request: Request,
    response: Response,
    previous: StoredSession | None,
    fields: dict[str, Any],
) -> StoredSession:
    """A new session (new id) holding `fields`, replacing `previous`, which is revoked (apps/api's
    replaceSession: a session id known before signing in is dead after it). Commits with `conn`."""
    settings: Settings = request.app.state.settings
    if previous is not None:
        end_session(conn, previous.id)
    session_id = secrets.token_urlsafe(24)  # @fastify/session's id: 24 random bytes, base64url
    expires_at = _now_ms() + _idle_ms(settings)
    data = {
        "cookie": {
            "expires": _iso_ms(expires_at),
            "originalMaxAge": _idle_ms(settings),
            "sameSite": settings.cookie_same_site,
            "secure": settings.cookie_secure,
            "path": "/",
            "httpOnly": True,
            "domain": None,
        },
        **fields,
    }
    user = fields.get("user")
    conn.execute(
        text("INSERT INTO sessions (id, data, expires_at, user_id) VALUES (:id, :data, :expires_at, :user_id)"),
        {
            "id": session_id,
            "data": _to_json(data),
            "expires_at": expires_at,
            "user_id": user.get("id") if isinstance(user, dict) else None,
        },
    )
    _prune_expired(conn, _now_ms())
    set_session_cookie(response, session_id, settings)
    return StoredSession(session_id, data)


def start_signed_in_session(
    conn: Connection, request: Request, response: Response, previous: StoredSession | None, user: dict[str, Any]
) -> StoredSession:
    """Signs `user` in: a new session, stamped with the sign-in time the absolute lifetime runs from."""
    return start_session(conn, request, response, previous, {"user": user, "authenticatedAt": _now_ms()})


def end_session(conn: Connection, session_id: str) -> None:
    """Revoked and emptied, never deleted: a request still in flight can't save it back (canvas-bj7)."""
    conn.execute(
        text("UPDATE sessions SET revoked = :yes, data = '{}' WHERE id = :id"), {"yes": True, "id": session_id}
    )


def current_user(request: Request, response: Response) -> SessionUser:
    """FastAPI dependency: the signed-in user, or 401 like apps/api's requireAuth."""
    settings: Settings = request.app.state.settings
    session = read_session(request)
    user = signed_in_user(session.data, settings) if session else None
    if user is None or session is None:
        raise ApiError(401, "Authentication required")
    path = request.url.path
    if not (path.startswith("/auth/") or path == "/health"):
        if user.mustChangePassword:
            raise ApiError(403, "Change your one-time password before continuing.", "PASSWORD_CHANGE_REQUIRED")
        if user.mustEnrollMfa:
            raise ApiError(403, "Set up two-step verification before continuing.", "MFA_ENROLLMENT_REQUIRED")
    _roll(request, response, session)
    request.state.session = session
    return user


def _roll(request: Request, response: Response, session: StoredSession) -> None:
    """Rolls an unchanged session forward: saves it only when the stored expiry is TOUCH_INTERVAL_MS or
    more behind where this request would move it; re-sends the cookie either way."""
    settings: Settings = request.app.state.settings
    stored = _parse_js_date((session.data.get("cookie") or {}).get("expires"))
    if stored is not None and _now_ms() + _idle_ms(settings) - stored < TOUCH_INTERVAL_MS:
        set_session_cookie(response, session.id, settings)
        return
    save_session(request, response, session)


def revoke_sessions(conn: Connection, user_id: str) -> None:
    """Signs a user out everywhere now (session-store.ts revokeSessions): their rows are revoked and
    emptied, so neither service accepts them again."""
    conn.execute(
        text("UPDATE sessions SET revoked = :yes, data = '{}' WHERE user_id = :uid"), {"yes": True, "uid": user_id}
    )
