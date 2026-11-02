"""canvas-1bty.13: sessions as sign-in leaves them (ports apps/api tests/contract/session-info-routes.test.ts and the
applicable parts of session-store.test.ts): /auth/me and /auth/logout without local auth, RP-initiated logout for
an Entra session, expiry, absolute lifetime, a new session id at every sign-in, pruning, and a late save never
bringing back an ended session.

Not ported from session-store.test.ts: "stores the session in the database" is covered by the first test below;
DbSessionStore's `set` spy and the in-flight request with a deliberately slow Fastify route are about
@fastify/session's save-at-end-of-response, which has no Python counterpart -- the Python service saves once,
right after reading (current_user / the /auth routes), so the "one request writes its session once" check is
made on touch_session instead."""

from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
import pytest
from sqlalchemy import text

from canvas_api.auth import session as session_module
from canvas_api.auth.cookie_signer import unsign
from canvas_api.auth.session import revoke_sessions, touch_session
from tests.auth_helpers import Site, seed_user, session_cookie
from tests.conftest import TEST_SESSION_SECRET
from tests.test_auth_oidc import END_SESSION_ENDPOINT, OIDC_SETTINGS, discovery_document

HOUR_MS = 60 * 60 * 1000


def session_id(cookie: str) -> str:
    value = unsign(unquote(cookie.removeprefix("cid=")), TEST_SESSION_SECRET)
    assert value is not None
    return value


def live_rows(site: Site) -> list[Any]:
    with site.engine.connect() as conn:
        return list(conn.execute(text("SELECT id, data, expires_at FROM sessions WHERE revoked = :no"), {"no": False}))


@pytest.fixture()
def local(make_site: Any) -> Site:
    site: Site = make_site(allow_local_auth_setting="true")
    seed_user(site.engine, "session@example.com", "session-pass")
    return site


def sign_in(site: Site) -> str:
    response, cookie = site.login("session@example.com", "session-pass")
    assert response.status_code == 200
    assert cookie
    return cookie


# --- /auth/me and /auth/logout with local auth disabled -----------------------------------------------------


def test_me_and_logout_are_registered_without_local_auth(make_site: Any) -> None:
    """The bug reported live on Azure: an SSO-only deployment 404'd /auth/me, so a completed sign-in was never
    recognised. Every other test builds an app with local sign-in on; this one deliberately doesn't."""
    site: Site = make_site()
    assert site.get("/auth/me").status_code == 401
    assert site.post("/auth/logout").status_code == 204
    assert (
        site.post(
            "/auth/local/login", {"email": "nobody@example.com", "password": "irrelevant"}, absent=True
        ).status_code
        == 404
    )


# --- logout from an Entra session (canvas-252) --------------------------------------------------------------


def sso_session(site: Site, id_token: str | None) -> str:
    """A signed-in session as the OIDC callback leaves one: the user and, for Entra, the ID token."""
    user = site.api.user("sso-user@example.com", "architect")
    if id_token is not None:
        with site.engine.begin() as conn:
            sid = session_id(f"cid={user.cookie}")
            data = json.loads(conn.execute(text("SELECT data FROM sessions WHERE id = :id"), {"id": sid}).scalar_one())
            data["oidcIdToken"] = id_token
            conn.execute(text("UPDATE sessions SET data = :d WHERE id = :id"), {"d": json.dumps(data), "id": sid})
    return f"cid={user.cookie}"


def entra_site(make_site: Any, document: dict[str, Any]) -> Site:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith("/.well-known/openid-configuration")
        return httpx.Response(200, json=document)

    return make_site(httpx.MockTransport(handler), **OIDC_SETTINGS)


def test_logout_of_an_entra_session_returns_the_end_session_address_and_ends_the_local_session(make_site: Any) -> None:
    site = entra_site(make_site, discovery_document())
    cookie = sso_session(site, "the-id-token")
    response = site.post("/auth/logout", cookie=cookie)
    assert response.status_code == 200
    url = urlsplit(response.json()["logoutUrl"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == END_SESSION_ENDPOINT
    query = parse_qs(url.query)
    assert query["id_token_hint"] == ["the-id-token"]
    assert query["client_id"] == [OIDC_SETTINGS["oidc_client_id"]]
    assert query["post_logout_redirect_uri"] == ["http://localhost:5173"]
    # Not just an extra field on the response: the session is really gone.
    assert site.get("/auth/me", cookie).status_code == 401


def test_logout_without_an_id_token_is_a_plain_204_even_with_an_entra_client(make_site: Any) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json=discovery_document())

    site: Site = make_site(httpx.MockTransport(handler), **OIDC_SETTINGS)
    cookie = sso_session(site, None)
    response = site.post("/auth/logout", cookie=cookie)
    assert response.status_code == 204
    assert response.content == b""
    assert calls == []  # no identity-provider round trip
    assert site.get("/auth/me", cookie).status_code == 401


def test_logout_is_a_plain_204_when_the_issuer_advertises_no_end_session_endpoint(make_site: Any) -> None:
    document = {k: v for k, v in discovery_document().items() if k != "end_session_endpoint"}
    site = entra_site(make_site, document)
    cookie = sso_session(site, "the-id-token")
    assert site.post("/auth/logout", cookie=cookie).status_code == 204
    assert site.get("/auth/me", cookie).status_code == 401


def test_logout_is_a_plain_204_when_the_identity_provider_cannot_be_reached(make_site: Any) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    site: Site = make_site(httpx.MockTransport(handler), **OIDC_SETTINGS)
    cookie = sso_session(site, "the-id-token")
    assert site.post("/auth/logout", cookie=cookie).status_code == 204
    assert site.get("/auth/me", cookie).status_code == 401


# --- the database store, expiry, no anonymous sessions (canvas-4xo) -----------------------------------------


def test_the_session_is_in_the_database_so_it_survives_a_restart(local: Site, make_site: Any) -> None:
    cookie = sign_in(local)
    assert len(live_rows(local)) == 1
    second: Site = make_site(allow_local_auth_setting="true")  # a new app: nothing in memory
    response = second.get("/auth/me", cookie)
    assert response.status_code == 200
    assert response.json()["user"]["email"] == "session@example.com"


def test_an_anonymous_request_creates_no_session_and_sets_no_cookie(local: Site) -> None:
    response = local.get("/auth/me")
    assert response.status_code == 401
    assert session_cookie(response) is None
    assert live_rows(local) == []


def test_a_session_idle_past_its_expiry_is_rejected_and_its_row_removed(local: Site) -> None:
    cookie = sign_in(local)
    with local.engine.begin() as conn:
        conn.execute(text("UPDATE sessions SET expires_at = :past"), {"past": int(time.time() * 1000) - 1000})
    assert local.get("/auth/me", cookie).status_code == 401
    assert local.api.scalar("SELECT COUNT(*) FROM sessions WHERE id = :id", id=session_id(cookie)) == 0


def test_a_session_past_its_absolute_lifetime_signs_the_user_out_even_while_active(local: Site) -> None:
    cookie = sign_in(local)
    sid = session_id(cookie)
    with local.engine.begin() as conn:
        data = json.loads(conn.execute(text("SELECT data FROM sessions WHERE id = :id"), {"id": sid}).scalar_one())
        data["authenticatedAt"] = int(time.time() * 1000) - 13 * HOUR_MS
        conn.execute(text("UPDATE sessions SET data = :d WHERE id = :id"), {"d": json.dumps(data), "id": sid})
    assert local.get("/auth/me", cookie).status_code == 401
    # ...and the old session id is out of the live store, not just ignored.
    assert sid not in [row.id for row in live_rows(local)]


def test_signing_in_issues_a_new_session_id_and_ends_any_earlier_one(local: Site) -> None:
    """No session fixation."""
    first = sign_in(local)
    before = [row.id for row in live_rows(local)]
    assert before == [session_id(first)]
    second_response, second = local.login("session@example.com", "session-pass", cookie=first)
    assert second_response.status_code == 200
    assert second and second != first
    assert session_id(first) not in [row.id for row in live_rows(local)]
    assert local.get("/auth/me", first).status_code == 401
    assert local.get("/auth/me", second).status_code == 200


def test_expired_rows_from_other_sessions_are_pruned(local: Site, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_module, "_last_prune_ms", 0)
    local.api.execute(
        "INSERT INTO sessions (id, data, expires_at) VALUES ('stale-session', '{}', :past)",
        past=int(time.time() * 1000) - 60_000,
    )
    sign_in(local)
    ids = [row.id for row in live_rows(local)]
    assert "stale-session" not in ids
    assert len(ids) == 1
    assert local.api.scalar("SELECT COUNT(*) FROM sessions WHERE id = 'stale-session'") == 0


def test_pruning_runs_at_most_once_per_interval(local: Site, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_module, "_last_prune_ms", int(time.time() * 1000))
    local.api.execute(
        "INSERT INTO sessions (id, data, expires_at) VALUES ('stale-session', '{}', :past)",
        past=int(time.time() * 1000) - 60_000,
    )
    sign_in(local)
    assert local.api.scalar("SELECT COUNT(*) FROM sessions WHERE id = 'stale-session'") == 1


def test_session_check_reports_none_or_signed_in_and_never_creates_a_session(local: Site) -> None:
    """canvas-ao2: the web app asks right after signing in, to detect a blocked session cookie."""
    anonymous = local.get("/auth/session-check")
    assert anonymous.json() == {"session": "none"}
    assert session_cookie(anonymous) is None
    assert live_rows(local) == []
    cookie = sign_in(local)
    assert local.get("/auth/session-check", cookie).json() == {"session": "signed-in"}
    # A sign-in whose cookie the browser dropped: the next request carries none.
    assert local.get("/auth/session-check").json() == {"session": "none"}


def test_one_request_saves_its_session_exactly_once(local: Site, monkeypatch: pytest.MonkeyPatch) -> None:
    cookie = sign_in(local)
    calls: list[str] = []
    real = touch_session

    def counting(*args: Any, **kwargs: Any) -> None:
        calls.append(args[1])
        real(*args, **kwargs)

    monkeypatch.setattr(session_module, "touch_session", counting)
    assert local.get("/auth/me", cookie).status_code == 200
    assert calls == [session_id(cookie)]


# --- an ended session cannot be brought back (canvas-bj7) ---------------------------------------------------


def test_a_late_save_does_not_bring_back_a_signed_out_session(local: Site) -> None:
    cookie = sign_in(local)
    sid = session_id(cookie)
    with local.engine.connect() as conn:
        stale = json.loads(conn.execute(text("SELECT data FROM sessions WHERE id = :id"), {"id": sid}).scalar_one())
    assert local.post("/auth/logout", cookie=cookie).status_code == 204
    touch_session(local.engine, sid, stale, local.settings)  # a request that started before the sign-out finishes
    assert live_rows(local) == []
    assert local.get("/auth/me", cookie).status_code == 401
    with local.engine.connect() as conn:
        assert conn.execute(text("SELECT data FROM sessions WHERE id = :id"), {"id": sid}).scalar_one() == "{}"


def test_a_late_save_does_not_bring_back_sessions_ended_by_an_admin_action(local: Site) -> None:
    """Reset, deactivation and lockout end a user's sessions through revoke_sessions."""
    cookie = sign_in(local)
    sid = session_id(cookie)
    user_id = local.user_id("session@example.com")
    with local.engine.connect() as conn:
        stale = json.loads(conn.execute(text("SELECT data FROM sessions WHERE id = :id"), {"id": sid}).scalar_one())
    with local.engine.begin() as conn:
        revoke_sessions(conn, user_id)
    touch_session(local.engine, sid, stale, local.settings)
    assert live_rows(local) == []
    assert local.get("/auth/me", cookie).status_code == 401


def test_a_cookie_pointing_at_an_ended_session_stays_ended_whatever_it_says(local: Site) -> None:
    cookie = sign_in(local)
    local.post("/auth/logout", cookie=cookie)
    # Signing in with the dead cookie still starts a fresh session, not the old one.
    _, fresh = local.login("session@example.com", "session-pass", cookie=cookie)
    assert session_id(fresh) != session_id(cookie)
    assert local.get("/auth/me", cookie).status_code == 401
    assert local.get("/auth/me", fresh).status_code == 200
