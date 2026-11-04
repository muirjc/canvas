"""canvas-1bty.13: Entra sign-in (ports apps/api tests/contract/oidc-callback.test.ts, auth-mode.test.ts).

The real GET /auth/login -> GET /auth/callback flow, with only the network faked: an httpx.MockTransport
(handed to create_app) answers the discovery document, the key set, the token endpoint and the Container
Apps identity endpoint. Tokens are signed with a locally generated RSA key (PyJWT), so a rejection below is
the ID-token checks in canvas_api/auth/oidc.py doing their job -- tests/test_auth_oidc.py was run against a
deliberately weakened copy of that file to prove it (see the phase 9 notes).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import text

from tests.auth_helpers import Site, session_cookie

TENANT_ID = "11111111-1111-1111-1111-111111111111"
ISSUER = f"https://login.microsoftonline.com/{TENANT_ID}/v2.0"
AUTHORIZATION_ENDPOINT = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/authorize"
TOKEN_ENDPOINT = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
JWKS_URI = f"https://login.microsoftonline.com/{TENANT_ID}/discovery/v2.0/keys"
END_SESSION_ENDPOINT = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/logout"
CLIENT_ID = "test-client-id"
REDIRECT_URI = "http://localhost:3000/auth/callback"
WEB_ORIGIN = "http://localhost:5173"
KID = "test-signing-key"
IDENTITY_ENDPOINT = "http://identity.local/msi/token"
EMAIL = "jane.doe@contoso.com"

OIDC_SETTINGS = {
    "oidc_issuer_url": ISSUER,
    "oidc_client_id": CLIENT_ID,
    "oidc_client_secret": "test-client-secret",
    "oidc_redirect_uri": REDIRECT_URI,
}


def discovery_document() -> dict[str, Any]:
    return {
        "issuer": ISSUER,
        "authorization_endpoint": AUTHORIZATION_ENDPOINT,
        "token_endpoint": TOKEN_ENDPOINT,
        "jwks_uri": JWKS_URI,
        "end_session_endpoint": END_SESSION_ENDPOINT,
        "response_types_supported": ["code"],
        "subject_types_supported": ["pairwise"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid", "email", "profile"],
    }


class FakeIdp:
    """The identity provider's side, served in-process."""

    def __init__(self) -> None:
        self.real_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        #: Never published: signs tokens that claim the real key's kid.
        self.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.real_key.public_key()))
        self.public_jwk = {**jwk, "kid": KID, "alg": "RS256", "use": "sig"}
        self.token_body: dict[str, Any] | None = None
        self.token_requests: list[dict[str, str]] = []
        self.identity_calls: list[httpx.URL] = []

    def respond_with(self, id_token: str) -> None:
        self.token_body = {
            "token_type": "Bearer",
            "access_token": "test-access-token",
            "expires_in": 3600,
            "id_token": id_token,
        }

    def sign(self, claims: dict[str, Any], key: Any = None, kid: str = KID) -> str:
        return jwt.encode(claims, key or self.real_key, algorithm="RS256", headers={"kid": kid})

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/.well-known/openid-configuration"):
            return httpx.Response(200, json=discovery_document())
        if url == JWKS_URI:
            return httpx.Response(200, json={"keys": [self.public_jwk]})
        if url == TOKEN_ENDPOINT:
            assert self.token_body is not None, "the token endpoint was called with no response configured"
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            return httpx.Response(200, json=self.token_body)
        if url.startswith(IDENTITY_ENDPOINT):
            self.identity_calls.append(request.url)
            expires_on = str(int(time.time()) + 3600)
            return httpx.Response(200, json={"access_token": "managed-identity-token", "expires_on": expires_on})
        raise AssertionError(f"unexpected request to {url}")


def claims(**overrides: Any) -> dict[str, Any]:
    now = int(time.time())
    base: dict[str, Any] = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "sub": "entra-oid-12345",
        "iat": now,
        "exp": now + 3600,
        "email": EMAIL,
        "name": "Jane Doe",
        "roles": ["admin"],
    }
    return {k: v for k, v in {**base, **overrides}.items() if v is not None}


@pytest.fixture(scope="module")
def idp() -> FakeIdp:
    return FakeIdp()


@pytest.fixture()
def sso(make_site: Any, idp: FakeIdp) -> Iterator[Site]:
    idp.token_body = None
    idp.token_requests.clear()
    idp.identity_calls.clear()
    yield make_site(httpx.MockTransport(idp.handler), **OIDC_SETTINGS)


def start_login(site: Site) -> tuple[str, str, str]:
    """GET /auth/login: the pre-login session cookie, and the state and nonce the IdP would echo back."""
    response = site.get("/auth/login")
    assert response.status_code == 302
    query = parse_qs(urlsplit(response.headers["location"]).query)
    cookie = session_cookie(response)
    assert cookie, "expected a session cookie from GET /auth/login"
    return cookie, query["state"][0], query["nonce"][0]


def callback(site: Site, cookie: str, state: str) -> httpx.Response:
    return site.get(f"/auth/callback?code=test-code&state={state}", cookie)


def signed_in_cookie(response: httpx.Response) -> str:
    cookie = session_cookie(response)
    assert cookie, "expected the callback to set a new session cookie"
    return cookie


def user_count(site: Site) -> int:
    return int(site.api.scalar("SELECT COUNT(*) FROM users"))


def test_login_redirects_to_entra_with_pkce_state_and_nonce(sso: Site) -> None:
    response = sso.get("/auth/login")
    assert response.status_code == 302
    location = urlsplit(response.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == AUTHORIZATION_ENDPOINT
    query = {k: v[0] for k, v in parse_qs(location.query).items()}
    assert query["client_id"] == CLIENT_ID
    assert query["response_type"] == "code"
    assert query["redirect_uri"] == REDIRECT_URI
    assert query["scope"] == "openid email profile"
    assert query["code_challenge_method"] == "S256"
    assert query["code_challenge"] and query["state"] and query["nonce"]


def test_happy_path_establishes_a_session_creates_the_user_and_sets_up_logout(sso: Site, idp: FakeIdp) -> None:
    cookie, state, nonce = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=nonce)))

    response = callback(sso, cookie, state)
    assert response.status_code == 302
    assert response.headers["location"] == f"{WEB_ORIGIN}/?signin=sso"  # canvas-ao2 marker
    session = signed_in_cookie(response)

    # canvas-4xo: no session fixation -- the pre-login session id is replaced, and dead.
    assert session != cookie
    assert sso.get("/auth/me", cookie).status_code == 401

    me = sso.get("/auth/me", session)
    assert me.status_code == 200
    assert me.json()["user"]["email"] == EMAIL
    assert me.json()["user"]["name"] == "Jane Doe"
    assert me.json()["user"]["role"] == "admin"

    # The code went to the token endpoint with the PKCE verifier and the client secret.
    sent = idp.token_requests[-1]
    assert sent["grant_type"] == "authorization_code"
    assert sent["code"] == "test-code"
    assert sent["redirect_uri"] == REDIRECT_URI
    assert sent["code_verifier"]
    assert sent["client_secret"] == "test-client-secret"

    logout = sso.post("/auth/logout", cookie=session)
    assert logout.status_code == 200
    logout_url = urlsplit(logout.json()["logoutUrl"])
    assert f"{logout_url.scheme}://{logout_url.netloc}{logout_url.path}" == END_SESSION_ENDPOINT
    assert parse_qs(logout_url.query)["post_logout_redirect_uri"] == [WEB_ORIGIN]
    assert parse_qs(logout_url.query)["id_token_hint"]
    assert sso.get("/auth/me", session).status_code == 401  # the local session is really gone

    row = sso.api.scalar("SELECT role FROM users WHERE email = :e", e=EMAIL)
    assert row == "admin"


def test_a_callback_cannot_be_replayed(sso: Site, idp: FakeIdp) -> None:
    cookie, state, nonce = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=nonce)))
    assert callback(sso, cookie, state).status_code == 302
    # The pre-login session is dead, so the same cookie and state get nowhere.
    assert callback(sso, cookie, state).status_code == 400


def test_a_callback_with_no_pending_login_is_400(sso: Site) -> None:
    assert sso.get("/auth/callback?code=x&state=y").status_code == 400


def test_maps_multiple_roles_to_the_highest_privilege_one(sso: Site, idp: FakeIdp) -> None:
    cookie, state, nonce = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=nonce, roles=["viewer", "architect"])))
    session = signed_in_cookie(callback(sso, cookie, state))
    assert sso.get("/auth/me", session).json()["user"]["role"] == "architect"


def test_defaults_to_viewer_when_the_roles_claim_is_absent(sso: Site, idp: FakeIdp) -> None:
    cookie, state, nonce = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=nonce, roles=None)))
    session = signed_in_cookie(callback(sso, cookie, state))
    assert sso.get("/auth/me", session).json()["user"]["role"] == "viewer"


def test_ignores_a_keycloak_shaped_realm_access_roles_claim(sso: Site, idp: FakeIdp) -> None:
    cookie, state, nonce = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=nonce, roles=None, realm_access={"roles": ["admin"]})))
    session = signed_in_cookie(callback(sso, cookie, state))
    assert sso.get("/auth/me", session).json()["user"]["role"] == "viewer"


def test_re_syncs_the_role_on_a_second_login_without_a_second_account(sso: Site, idp: FakeIdp) -> None:
    first = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=first[2], roles=["admin"])))
    callback(sso, first[0], first[1])

    second = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=second[2], roles=["viewer"])))
    session = signed_in_cookie(callback(sso, second[0], second[1]))

    assert sso.get("/auth/me", session).json()["user"]["role"] == "viewer"
    assert sso.api.scalar("SELECT COUNT(*) FROM users WHERE email = :e", e=EMAIL) == 1


def test_keeps_admin_assigned_personas_across_a_second_login(sso: Site, idp: FakeIdp) -> None:
    first = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=first[2], roles=["admin"])))
    callback(sso, first[0], first[1])

    user_id = sso.user_id(EMAIL)
    with sso.engine.begin() as conn:
        for position, persona in enumerate(["Business", "Solution"]):
            conn.execute(
                text("INSERT INTO users_personas (user_id, persona, position) VALUES (:u, :p, :i)"),
                {"u": user_id, "p": persona, "i": position},
            )

    second = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=second[2], roles=["viewer"])))
    session = signed_in_cookie(callback(sso, second[0], second[1]))

    user = sso.get("/auth/me", session).json()["user"]
    assert user["role"] == "viewer"
    assert user["personas"] == ["Business", "Solution"]
    assert sso.api.scalar("SELECT COUNT(*) FROM users_personas WHERE user_id = :u", u=user_id) == 2


def test_rejects_an_inactive_user_with_403_and_no_session(sso: Site, idp: FakeIdp) -> None:
    cookie, state, nonce = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=nonce)))
    callback(sso, cookie, state)  # creates the user
    sso.api.execute("UPDATE users SET active = :no WHERE email = :e", no=False, e=EMAIL)

    second_cookie, second_state, second_nonce = start_login(sso)
    idp.respond_with(idp.sign(claims(nonce=second_nonce)))
    response = callback(sso, second_cookie, second_state)
    assert response.status_code == 403
    assert session_cookie(response) is None or sso.get("/auth/me", session_cookie(response)).status_code == 401
    assert sso.get("/auth/me", second_cookie).status_code == 401


def test_responds_403_not_500_when_entra_redirects_back_with_its_own_error(sso: Site) -> None:
    """E.g. AADSTS50105, a user not assigned to the app."""
    cookie, state, _ = start_login(sso)
    response = sso.get(
        f"/auth/callback?error=access_denied&error_description=AADSTS50105%3A%20user%20not%20assigned&state={state}",
        cookie,
    )
    assert response.status_code == 403
    assert response.json() == {"error": "You are not authorized to access this application."}
    assert user_count(sso) == 0


class TestRejectedSignIns:
    """401, and no user row created."""

    def expect_rejected(self, site: Site, cookie: str, state: str) -> None:
        response = callback(site, cookie, state)
        assert response.status_code == 401
        assert response.json() == {"error": "SSO sign-in failed"}
        assert user_count(site) == 0

    def test_a_tampered_payload(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        header, payload, signature = idp.sign(claims(nonce=nonce)).split(".")
        decoded = jwt.utils.base64url_decode(payload).decode().replace('"admin"', '"viewer"')
        assert '"viewer"' in decoded
        idp.respond_with(f"{header}.{jwt.utils.base64url_encode(decoded.encode()).decode()}.{signature}")
        self.expect_rejected(sso, cookie, state)

    def test_signed_with_a_different_key_under_the_same_kid(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        idp.respond_with(idp.sign(claims(nonce=nonce), key=idp.other_key, kid=KID))
        self.expect_rejected(sso, cookie, state)

    def test_an_unknown_kid(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        idp.respond_with(idp.sign(claims(nonce=nonce), kid="no-such-key"))
        self.expect_rejected(sso, cookie, state)

    def test_wrong_audience(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        idp.respond_with(idp.sign(claims(nonce=nonce, aud="some-other-client-id")))
        self.expect_rejected(sso, cookie, state)

    def test_wrong_issuer_the_v1_form(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        idp.respond_with(idp.sign(claims(nonce=nonce, iss=f"https://sts.windows.net/{TENANT_ID}/")))
        self.expect_rejected(sso, cookie, state)

    def test_an_expired_token(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        now = int(time.time())
        idp.respond_with(idp.sign(claims(nonce=nonce, iat=now - 7200, exp=now - 3600)))
        self.expect_rejected(sso, cookie, state)

    def test_a_wrong_nonce(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, _ = start_login(sso)
        idp.respond_with(idp.sign(claims(nonce="wrong-nonce-value")))
        self.expect_rejected(sso, cookie, state)

    def test_a_mismatched_state(self, sso: Site, idp: FakeIdp) -> None:
        cookie, _, nonce = start_login(sso)
        idp.respond_with(idp.sign(claims(nonce=nonce)))
        self.expect_rejected(sso, cookie, "completely-wrong-state")

    def test_a_token_with_no_nonce(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, _ = start_login(sso)
        idp.respond_with(idp.sign(claims()))
        self.expect_rejected(sso, cookie, state)

    def test_an_unsigned_none_algorithm_token(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        idp.respond_with(jwt.encode(claims(nonce=nonce), key=None, algorithm="none", headers={"kid": KID}))
        self.expect_rejected(sso, cookie, state)

    def test_a_shared_secret_algorithm_token_signed_with_the_public_key(self, sso: Site, idp: FakeIdp) -> None:
        """The classic RS256 -> HS256 downgrade: the published public key used as an HMAC secret."""
        cookie, state, nonce = start_login(sso)
        _, payload, _ = idp.sign(claims(nonce=nonce)).split(".")
        forged_header = jwt.utils.base64url_encode(json.dumps({"alg": "HS256", "typ": "JWT", "kid": KID}).encode())
        signing_input = f"{forged_header.decode()}.{payload}".encode()
        public_pem = idp.real_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        signature = hmac.new(public_pem, signing_input, hashlib.sha256).digest()
        idp.respond_with(f"{forged_header.decode()}.{payload}.{jwt.utils.base64url_encode(signature).decode()}")
        self.expect_rejected(sso, cookie, state)

    def test_a_token_endpoint_refusal(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, _ = start_login(sso)
        idp.token_body = {"error": "invalid_grant"}
        response = callback(sso, cookie, state)
        # The fake always answers 200 with this body; no id_token or Bearer type means refused all the same.
        assert response.status_code == 401
        assert user_count(sso) == 0

    def test_a_failed_attempt_leaves_nothing_a_retry_could_reuse(self, sso: Site, idp: FakeIdp) -> None:
        cookie, state, nonce = start_login(sso)
        idp.respond_with(idp.sign(claims(nonce="wrong-nonce-value")))
        assert callback(sso, cookie, state).status_code == 401
        idp.respond_with(idp.sign(claims(nonce=nonce)))
        assert callback(sso, cookie, state).status_code == 400  # the verifier, state and nonce were cleared
        assert user_count(sso) == 0


def test_signing_in_with_a_federated_credential_sends_the_identity_token_never_a_secret(
    make_site: Any, idp: FakeIdp, monkeypatch: pytest.MonkeyPatch
) -> None:
    """canvas-haz.9: no client secret -- the managed identity's token is the client assertion."""
    monkeypatch.setenv("IDENTITY_ENDPOINT", IDENTITY_ENDPOINT)
    monkeypatch.setenv("IDENTITY_HEADER", "platform-header")
    idp.token_requests.clear()
    idp.identity_calls.clear()
    site = make_site(
        httpx.MockTransport(idp.handler),
        **{**OIDC_SETTINGS, "oidc_client_secret": None},
        oidc_client_auth_setting="managed-identity",
        azure_client_id="mi-client-id",
    )
    for round_number in (1, 2):
        cookie, state, nonce = start_login(site)
        idp.respond_with(idp.sign(claims(nonce=nonce)))
        response = callback(site, cookie, state)
        assert response.status_code == 302, f"round {round_number}"
        sent = idp.token_requests[-1]
        assert sent["client_assertion_type"] == "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        assert sent["client_assertion"] == "managed-identity-token"
        assert sent["client_id"] == CLIENT_ID
        assert "client_secret" not in sent
    # One identity-endpoint call for both sign-ins (cached until near expiry), asking for Entra's
    # token-exchange audience for this identity.
    assert len(idp.identity_calls) == 1
    asked = idp.identity_calls[0].params
    assert asked["resource"] == "api://AzureADTokenExchange"
    assert asked["client_id"] == "mi-client-id"


def test_managed_identity_outside_azure_fails_the_sign_in_not_the_app(
    make_site: Any, idp: FakeIdp, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("IDENTITY_ENDPOINT", raising=False)
    monkeypatch.delenv("IDENTITY_HEADER", raising=False)
    site = make_site(
        httpx.MockTransport(idp.handler),
        **{**OIDC_SETTINGS, "oidc_client_secret": None},
        oidc_client_auth_setting="managed-identity",
        azure_client_id="mi-client-id",
    )
    cookie, state, nonce = start_login(site)
    idp.respond_with(idp.sign(claims(nonce=nonce)))
    assert callback(site, cookie, state).status_code == 401


# --- AUTH_MODE (apps/api tests/contract/auth-mode.test.ts) -------------------------------------------


def test_local_mode_reports_local_sign_in_only_and_the_entra_routes_do_not_exist(make_site: Any, idp: FakeIdp) -> None:
    from tests.auth_helpers import seed_user

    site = make_site(httpx.MockTransport(idp.handler), auth_mode_setting="local", **OIDC_SETTINGS)
    seed_user(site.engine, "local@example.com", "local-pass")
    assert site.get("/auth/config").json() == {
        "authMode": "local",
        "oidcEnabled": False,
        "localAuthEnabled": True,
        "mfaRequired": True,
        "groupsEnabled": False,
    }
    assert site.login("local@example.com", "local-pass")[0].status_code == 200
    assert site.get("/auth/login", absent=True).status_code == 404
    assert site.get("/auth/callback?code=x&state=y", absent=True).status_code == 404


def test_entra_mode_without_allow_local_auth_has_no_local_sign_in_route(make_site: Any) -> None:
    from tests.auth_helpers import seed_user

    site = make_site()
    seed_user(site.engine, "local@example.com", "local-pass")
    assert site.get("/auth/config").json() == {
        "authMode": "entra",
        "oidcEnabled": False,
        "localAuthEnabled": False,
        "mfaRequired": False,
        "groupsEnabled": False,
    }
    assert site.login("local@example.com", "local-pass", absent=True)[0].status_code == 404


def test_entra_mode_with_oidc_settings_reports_sso_enabled(sso: Site) -> None:
    assert sso.get("/auth/config").json() == {
        "authMode": "entra",
        "oidcEnabled": True,
        "localAuthEnabled": False,
        "mfaRequired": False,
        "groupsEnabled": False,
    }
