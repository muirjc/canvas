"""Entra ID sign-in: OpenID Connect authorization code flow with PKCE (apps/api/src/auth/oidc.ts, which uses
openid-client).

Checked on the way back, any failure refusing the sign-in:
- the authorization response: `iss` (when sent) is the issuer, `state` is the one this session started;
  an `error` from Entra itself (e.g. AADSTS50105, a user not assigned to the app) is reported separately;
- the token response: JSON, a Bearer token type, and an ID token;
- the ID token: signed (RS256, or what discovery lists) by a key in the issuer's published JWKS with the
  token's `kid` (canvas-haz's hardening: openid-client only does this with enableNonRepudiationChecks);
  `iss`, `aud` (and `azp` when there are several audiences), `exp`/`iat`/`nbf` with 30 seconds of clock
  tolerance as openid-client, `sub`, and the `nonce` this session started.

Client authentication is the client secret (client_secret_post, openid-client's default for a secret) or,
with OIDC_CLIENT_AUTH=managed-identity, the managed identity's token as a jwt-bearer client assertion
(canvas-haz.9). Discovery happens at first use and is kept, as are the issuer's keys (fetched again, at
most every 30 seconds, when a token names a key that isn't there: Entra rotates them).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
import jwt

from canvas_api.config import OidcConfig

ROLE_PRIORITY = ("admin", "architect", "viewer")
_CLOCK_TOLERANCE_SECONDS = 30
_JWKS_REFETCH_SECONDS = 30
#: Signature algorithms accepted when discovery lists them; never "none" or a shared-secret (HS*) one.
_ASYMMETRIC_ALGORITHMS = ("RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512")
_MANAGED_IDENTITY_AUDIENCE = "api://AzureADTokenExchange"
_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
_REFRESH_MARGIN_SECONDS = 5 * 60


class OidcError(Exception):
    """The sign-in failed validation (a 401). Its message is for the log, never the user."""


class OidcAuthorizationDenied(Exception):
    """Entra redirected back with its own error: authenticated, but not allowed into this app (a 403)."""

    def __init__(self, error: str, description: str | None) -> None:
        super().__init__(error)
        self.error = error
        self.description = description


@dataclass(frozen=True)
class PendingLogin:
    """What GET /auth/login keeps in the session for the callback."""

    code_verifier: str
    state: str
    nonce: str


def extract_entra_roles(claims: dict[str, Any]) -> list[str]:
    """Entra App Roles: a flat top-level `roles` claim. A Keycloak-shaped `realm_access.roles` is not read."""
    roles = claims.get("roles")
    return [r for r in roles if isinstance(r, str)] if isinstance(roles, list) else []


def map_idp_roles_to_user_role(idp_roles: list[str]) -> str:
    """The highest-privilege recognised role; viewer when there's none."""
    return next((role for role in ROLE_PRIORITY if role in idp_roles), "viewer")


def extract_identity(claims: dict[str, Any]) -> tuple[str, str | None, str | None]:
    """(sub, email, name) from the ID token. The email is lowercased (Entra returns the directory's case);
    `preferred_username` (the UPN) stands in for a missing email only when it looks like one."""
    sub = claims.get("sub") if isinstance(claims.get("sub"), str) else ""
    raw_email = claims.get("email") if isinstance(claims.get("email"), str) and claims.get("email") else None
    preferred = claims.get("preferred_username")
    preferred = preferred if isinstance(preferred, str) and "@" in preferred else None
    email = raw_email or preferred
    name = claims.get("name") if isinstance(claims.get("name"), str) and claims.get("name") else None
    return str(sub), email.lower() if email else None, name


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _with_query(url: str, params: dict[str, str]) -> str:
    """`url` with `params` added, as URLSearchParams.set() would."""
    parts = urlsplit(url)
    query = "&".join(p for p in (parts.query, urlencode(params)) if p)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


class ManagedIdentityAssertion:
    """The managed identity's token for Entra's token-exchange audience (apps/api's managed-identity.ts), from
    the Container Apps identity endpoint; reused until five minutes before it expires."""

    def __init__(self, identity_client_id: str, http: httpx.Client) -> None:
        self._identity_client_id = identity_client_id
        self._http = http
        self._token = ""
        self._expires_at = 0.0
        self._lock = threading.Lock()

    def token(self) -> str:
        with self._lock:
            now = time.time()
            if self._token and now < self._expires_at - _REFRESH_MARGIN_SECONDS:
                return self._token
            endpoint = os.environ.get("IDENTITY_ENDPOINT")
            header = os.environ.get("IDENTITY_HEADER")
            if not endpoint or not header:
                raise OidcError(
                    "OIDC_CLIENT_AUTH=managed-identity needs the platform managed-identity endpoint"
                    " (IDENTITY_ENDPOINT/IDENTITY_HEADER), which only exists inside Azure."
                )
            url = _with_query(
                endpoint,
                {
                    "resource": _MANAGED_IDENTITY_AUDIENCE,
                    "api-version": "2019-08-01",
                    "client_id": self._identity_client_id,
                },
            )
            response = self._http.get(url, headers={"X-IDENTITY-HEADER": header})
            if response.status_code != 200:
                raise OidcError(f"Managed identity token request failed ({response.status_code}).")
            body = response.json()
            token = body.get("access_token") if isinstance(body, dict) else None
            if not token:
                raise OidcError("Managed identity token response had no access_token.")
            try:
                expires_on = float(body.get("expires_on"))
            except (TypeError, ValueError):
                expires_on = 0
            self._token = token
            self._expires_at = expires_on if expires_on > 0 else now + 3600
            return self._token


class OidcClient:
    def __init__(
        self, config: OidcConfig, post_logout_redirect_uri: str, transport: httpx.BaseTransport | None
    ) -> None:
        self.config = config
        self._post_logout_redirect_uri = post_logout_redirect_uri
        self._http = httpx.Client(transport=transport, timeout=15, follow_redirects=False)
        self._assertion = (
            ManagedIdentityAssertion(config.managed_identity_client_id, self._http)
            if config.managed_identity_client_id
            else None
        )
        self._metadata: dict[str, Any] | None = None
        self._jwks: list[dict[str, Any]] = []
        self._jwks_fetched_at = 0.0
        self._lock = threading.Lock()
        self._issuer = config.issuer_url
        # openid-client refuses plain HTTP unless the issuer itself is plain HTTP (a local test IdP only).
        self._allow_http = urlsplit(self._issuer).scheme == "http"

    def close(self) -> None:
        self._http.close()

    def _get_json(self, url: str) -> Any:
        if urlsplit(url).scheme != "https" and not self._allow_http:
            raise OidcError(f"refusing a plain-HTTP request to {url}")
        response = self._http.get(url, headers={"accept": "application/json"})
        if response.status_code != 200:
            raise OidcError(f"{url} answered {response.status_code}")
        return response.json()

    def metadata(self) -> dict[str, Any]:
        """The issuer's discovery document, checked to be for this issuer."""
        with self._lock:
            if self._metadata is None:
                url = self._issuer.rstrip("/") + "/.well-known/openid-configuration"
                document = self._get_json(url)
                if not isinstance(document, dict) or document.get("issuer") != self._issuer:
                    raise OidcError("the discovery document is for a different issuer")
                self._metadata = document
            return self._metadata

    def end_session_url(self, id_token: str) -> str | None:
        """RP-Initiated Logout, so signing out also ends the Entra session; None when the issuer has none."""
        try:
            endpoint = self.metadata().get("end_session_endpoint")
        except (OidcError, httpx.HTTPError, ValueError):
            return None
        if not isinstance(endpoint, str) or not endpoint:
            return None
        return _with_query(
            endpoint,
            {
                "client_id": self.config.client_id,
                "id_token_hint": id_token,
                "post_logout_redirect_uri": self._post_logout_redirect_uri,
            },
        )

    def start(self) -> tuple[str, PendingLogin]:
        """The Entra sign-in address, and what to keep in the session for the callback."""
        pending = PendingLogin(
            code_verifier=secrets.token_urlsafe(32), state=secrets.token_urlsafe(32), nonce=secrets.token_urlsafe(32)
        )
        challenge = _b64url(hashlib.sha256(pending.code_verifier.encode()).digest())
        url = _with_query(
            self.metadata()["authorization_endpoint"],
            {
                "client_id": self.config.client_id,
                "response_type": "code",
                "redirect_uri": self.config.redirect_uri,
                "scope": "openid email profile",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": pending.state,
                "nonce": pending.nonce,
            },
        )
        return url, pending

    def finish(self, params: dict[str, str], pending: PendingLogin) -> tuple[dict[str, Any], str]:
        """The callback: checks the authorization response, exchanges the code and checks the ID token.
        Returns the ID token's claims and the token itself (kept for sign-out)."""
        metadata = self.metadata()
        if "iss" in params and params["iss"] != self._issuer:
            raise OidcError("the authorization response's iss is not the issuer")
        if metadata.get("authorization_response_iss_parameter_supported") is True and "iss" not in params:
            raise OidcError("the authorization response has no iss")
        if not hmac.compare_digest(params.get("state", ""), pending.state):
            raise OidcError("state mismatch")
        if "error" in params:
            raise OidcAuthorizationDenied(params["error"], params.get("error_description"))
        code = params.get("code")
        if not code:
            raise OidcError("the authorization response has no code")
        tokens = self._exchange(metadata, code, pending.code_verifier)
        id_token = tokens.get("id_token")
        if not isinstance(id_token, str) or not id_token:
            raise OidcError("the token response has no id_token")
        return self._verify_id_token(metadata, id_token, pending.nonce), id_token

    def _exchange(self, metadata: dict[str, Any], code: str, code_verifier: str) -> dict[str, Any]:
        endpoint = metadata.get("token_endpoint")
        if not isinstance(endpoint, str) or (urlsplit(endpoint).scheme != "https" and not self._allow_http):
            raise OidcError("no usable token endpoint")
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.config.redirect_uri,
            "code_verifier": code_verifier,
            "client_id": self.config.client_id,
        }
        if self._assertion is not None:
            form["client_assertion_type"] = _ASSERTION_TYPE
            form["client_assertion"] = self._assertion.token()
        elif self.config.client_secret:
            form["client_secret"] = self.config.client_secret
        response = self._http.post(endpoint, data=form, headers={"accept": "application/json"})
        try:
            body = response.json()
        except ValueError as error:
            raise OidcError("the token response is not JSON") from error
        if response.status_code != 200 or not isinstance(body, dict):
            error_code = body.get("error") if isinstance(body, dict) else None
            raise OidcError(f"the token endpoint refused the code ({response.status_code}, {error_code})")
        if str(body.get("token_type", "")).lower() != "bearer":
            raise OidcError("unexpected token_type")
        return body

    def _signing_key(self, metadata: dict[str, Any], kid: str | None, alg: str) -> jwt.PyJWK:
        for attempt in range(2):
            with self._lock:
                stale = time.monotonic() - self._jwks_fetched_at >= _JWKS_REFETCH_SECONDS
                if not self._jwks or (attempt == 1 and stale):
                    document = self._get_json(metadata["jwks_uri"])
                    keys = document.get("keys") if isinstance(document, dict) else None
                    self._jwks = [k for k in keys if isinstance(k, dict)] if isinstance(keys, list) else []
                    self._jwks_fetched_at = time.monotonic()
                elif attempt == 1:
                    break
                candidates = [
                    k
                    for k in self._jwks
                    if k.get("kid") == kid and k.get("use", "sig") == "sig" and k.get("alg", alg) == alg
                ]
            if len(candidates) == 1:
                return jwt.PyJWK(candidates[0], algorithm=alg)
            if len(candidates) > 1:
                raise OidcError("more than one key matches the ID token's kid")
        raise OidcError("no key in the issuer's JWKS matches the ID token's kid")

    def _verify_id_token(self, metadata: dict[str, Any], id_token: str, nonce: str) -> dict[str, Any]:
        allowed = metadata.get("id_token_signing_alg_values_supported") or ["RS256"]
        algorithms = [a for a in allowed if a in _ASYMMETRIC_ALGORITHMS]
        try:
            header = jwt.get_unverified_header(id_token)
            alg = header.get("alg")
            if not isinstance(alg, str) or alg not in algorithms:
                raise OidcError(f"unexpected ID token algorithm {alg}")
            key = self._signing_key(metadata, header.get("kid"), alg)
            claims: dict[str, Any] = jwt.decode(
                id_token,
                key=key,
                algorithms=[alg],
                audience=self.config.client_id,
                issuer=self._issuer,
                leeway=_CLOCK_TOLERANCE_SECONDS,
                options={"require": ["iss", "sub", "aud", "exp", "iat"]},
            )
        except jwt.PyJWTError as error:
            raise OidcError(f"ID token rejected: {error}") from error
        audiences = claims["aud"] if isinstance(claims["aud"], list) else [claims["aud"]]
        if (len(audiences) > 1 or "azp" in claims) and claims.get("azp") != self.config.client_id:
            raise OidcError("ID token azp is not this client")
        if not isinstance(claims.get("nonce"), str) or not hmac.compare_digest(claims["nonce"], nonce):
            raise OidcError("nonce mismatch")
        return claims
