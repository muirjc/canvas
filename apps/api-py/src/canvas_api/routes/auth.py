"""Sign-in and sessions (phase 9, canvas-1bty.13; apps/api/src/auth/session.ts, local.ts, oidc.ts).

- /auth/config, /auth/session-check, /auth/me, /auth/logout: always there.
- /auth/local/login, /auth/password, /auth/mfa/*: Canvas email + password accounts (ALLOW_LOCAL_AUTH, or
  AUTH_MODE=local), with optional or required two-step verification.
- /auth/login, /auth/callback: Entra ID (OIDC_* set, AUTH_MODE=entra).

Writes that must survive a refusal (a failed attempt counted, an audit row) are committed before the
error goes out, as the TypeScript service does them outside any transaction.
"""

from __future__ import annotations

import functools
import time
from typing import Annotated, Any
from uuid import uuid4

import httpx
import structlog
from fastapi import APIRouter, Body, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, StrictStr
from sqlalchemy import Connection, Engine, text

from canvas_api.audit import client_ip, record_audit
from canvas_api.auth import accounts
from canvas_api.auth.oidc import (
    OidcAuthorizationDenied,
    OidcClient,
    OidcError,
    PendingLogin,
    extract_entra_roles,
    extract_identity,
    map_idp_roles_to_user_role,
)
from canvas_api.auth.passwords import hash_password, verify_password
from canvas_api.auth.rate_limit import LoginRateLimiter
from canvas_api.auth.roles import CurrentUser
from canvas_api.auth.session import (
    StoredSession,
    end_session,
    read_session,
    save_session,
    start_session,
    start_signed_in_session,
    touch_session,
)
from canvas_api.auth.totp import otpauth_uri
from canvas_api.config import Settings
from canvas_api.db import get_engine
from canvas_api.errors import ApiError
from canvas_api.groups import record_memberships

router = APIRouter(tags=["Auth"])
Db = Annotated[Engine, Depends(get_engine)]
log = structlog.get_logger()

DEACTIVATED_MESSAGE = "This account has been deactivated. Ask an admin to reactivate it."
#: How long the second sign-in step may take after the password.
MFA_PENDING_MS = 5 * 60 * 1000


class PasswordBody(BaseModel):
    currentPassword: StrictStr
    newPassword: StrictStr


class CodeBody(BaseModel):
    code: StrictStr = Field(max_length=64)


def _settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def _now_ms() -> int:
    return int(time.time() * 1000)


@functools.cache
def _dummy_credential() -> tuple[str, str]:
    """Checked against when the email is unknown, so a wrong email takes as long as a wrong password."""
    return hash_password("not-a-real-password-dummy")


def _require_local_auth(request: Request) -> Settings:
    """Also a route dependency, so with local sign-in off these routes answer 404 before anything else (sign-in,
    body validation) is checked: they don't exist, as in apps/api."""
    settings = _settings(request)
    if not settings.allow_local_auth:
        raise ApiError(404, f"Route {request.method}:{request.url.path} not found")
    return settings


def _personas(conn: Connection, user_id: str) -> list[str]:
    return [
        r.persona
        for r in conn.execute(
            text("SELECT persona FROM users_personas WHERE user_id = :id ORDER BY position"), {"id": user_id}
        )
    ]


def _local_session_user(conn: Connection, user_id: str, mfa_required: bool) -> dict[str, Any] | None:
    """The signed-in session's user for a Canvas-password account."""
    row = conn.execute(
        text(
            "SELECT u.id, u.email, u.name, u.role, c.must_change_password FROM users u"
            " JOIN local_credentials c ON c.user_id = u.id WHERE u.id = :id"
        ),
        {"id": user_id},
    ).first()
    if row is None:
        return None
    mfa_enabled = accounts.is_mfa_enabled(conn, user_id)
    return {
        "id": str(row.id),
        "email": row.email,
        "name": row.name,
        "role": row.role,
        "personas": _personas(conn, user_id),
        "localAccount": True,
        "mustChangePassword": bool(row.must_change_password),
        "mfaEnabled": mfa_enabled,
        "mustEnrollMfa": mfa_required and not mfa_enabled,
    }


# --- always there ----------------------------------------------------------------------------------


@router.get("/auth/config")
def auth_config(request: Request) -> dict[str, Any]:
    """Public: which sign-in methods the sign-in page offers."""
    settings = _settings(request)
    return {
        "authMode": settings.auth_mode,
        "oidcEnabled": settings.oidc is not None,
        "localAuthEnabled": settings.allow_local_auth,
        "mfaRequired": settings.allow_local_auth and settings.mfa_required,
        # canvas-2h2w.3: whether the share dialogs offer Entra groups.
        "groupsEnabled": settings.entra_groups,
    }


@router.get("/auth/session-check")
def session_check(request: Request, response: Response) -> dict[str, str]:
    """Did this request arrive with a session? Lets the sign-in page tell a browser that dropped the session
    cookie from a plain visit (canvas-ao2)."""
    session = read_session(request)
    if session is None:
        return {"session": "none"}
    save_session(request, response, session)
    if session.data.get("user"):
        return {"session": "signed-in"}
    return {"session": "pending-mfa" if session.data.get("mfaPending") else "none"}


@router.get("/auth/me")
def me(request: Request, response: Response, db: Db) -> dict[str, Any]:
    session = read_session(request)
    user = session.data.get("user") if session else None
    if session is None or not isinstance(user, dict):
        raise ApiError(401, "Not authenticated")
    # Personas are captured at sign-in; re-read here (the web app calls this on every load), so an admin's
    # change applies on the user's next reload (canvas-2sk).
    with db.connect() as conn:
        personas = _personas(conn, str(user.get("id")))
    if personas != (user.get("personas") or []):
        user = {**user, "personas": personas}
        session.data["user"] = user
    save_session(request, response, session)
    return {"user": user}


@router.post("/auth/logout", response_model=None)
def logout(request: Request, db: Db) -> Response | dict[str, str]:
    """Ends this session. One that came from Entra also gets Entra's sign-out address, for the web app to
    open, so the next SSO sign-in asks who you are (canvas-252)."""
    session = read_session(request)
    if session is None:
        return Response(status_code=204)
    id_token = session.data.get("oidcIdToken")
    with db.begin() as conn:
        end_session(conn, session.id)
    oidc: OidcClient | None = request.app.state.oidc_client
    logout_url = oidc.end_session_url(id_token) if oidc is not None and isinstance(id_token, str) and id_token else None
    if logout_url:
        return {"logoutUrl": logout_url}
    return Response(status_code=204)


# --- Canvas passwords --------------------------------------------------------------------------------


@router.post("/auth/local/login", dependencies=[Depends(_require_local_auth)])
def local_login(request: Request, response: Response, db: Db, body: Annotated[Any, Body()] = None) -> dict[str, Any]:
    settings = _require_local_auth(request)
    body = body if isinstance(body, dict) else {}
    email, password = body.get("email"), body.get("password")
    if not email or not password or not isinstance(email, str) or not isinstance(password, str):
        raise ApiError(400, "email and password are required")
    ip = client_ip(request)
    limiter: LoginRateLimiter = request.app.state.login_rate_limiter
    if not limiter.allow(ip):
        raise ApiError(429, "Too many sign-in attempts from this network. Wait a minute and try again.")

    normalized = accounts.normalize_email(email)
    previous = read_session(request)
    refusal: ApiError | None = None
    result: dict[str, Any] = {}
    with db.begin() as conn:
        row = conn.execute(
            text(
                "SELECT u.id, u.active, c.password_hash, c.password_salt, c.locked_at FROM users u"
                " JOIN local_credentials c ON c.user_id = u.id WHERE u.email = :email"
            ),
            {"email": normalized},
        ).first()
        user_id = str(row.id) if row is not None else None
        if row is None or user_id is None:
            verify_password(password, *_dummy_credential())
            record_audit(conn, "sign_in_failed", ip=ip, detail={"email": normalized, "reason": "unknown_email"})
            refusal = ApiError(401, "Invalid email or password")
        elif row.locked_at is not None:
            # Saying so reveals the account exists -- accepted so its owner knows to ask an admin.
            record_audit(conn, "sign_in_failed", target_user_id=user_id, ip=ip, detail={"reason": "locked"})
            refusal = ApiError(423, accounts.LOCKED_MESSAGE)
        elif not verify_password(password, row.password_hash, row.password_salt):
            record_audit(conn, "sign_in_failed", target_user_id=user_id, ip=ip, detail={"reason": "wrong_password"})
            if accounts.record_failed_attempt(conn, user_id):
                record_audit(conn, "account_locked", target_user_id=user_id, ip=ip)
                refusal = ApiError(423, accounts.LOCKED_MESSAGE)
            else:
                refusal = ApiError(401, "Invalid email or password")
        elif not row.active:
            record_audit(conn, "sign_in_failed", target_user_id=user_id, ip=ip, detail={"reason": "inactive"})
            refusal = ApiError(403, DEACTIVATED_MESSAGE)
        elif accounts.is_mfa_enabled(conn, user_id):
            # The password alone signs no one in, and the failed-attempt count isn't reset yet -- or someone
            # with the password could guess codes forever by re-entering it after every two wrong ones.
            start_session(
                conn, request, response, previous, {"mfaPending": {"userId": user_id, "startedAt": _now_ms()}}
            )
            result = {"mfaRequired": True}
        else:
            accounts.clear_failed_attempts(conn, user_id)
            user = _local_session_user(conn, user_id, settings.mfa_required)
            assert user is not None  # noqa: S101 - joined just above, same transaction
            start_signed_in_session(conn, request, response, previous, user)
            record_audit(
                conn, "sign_in", actor_user_id=user_id, target_user_id=user_id, ip=ip, detail={"method": "password"}
            )
            result = {"user": user}
    if refusal is not None:
        raise refusal
    return result


@router.post("/auth/password", dependencies=[Depends(_require_local_auth)])
def change_password(
    request: Request, response: Response, user: CurrentUser, db: Db, body: PasswordBody
) -> dict[str, Any]:
    """A signed-in Canvas-password account changes its own password -- required after signing in with a
    one-time one. Other sessions of theirs end; this one stays."""
    _require_local_auth(request)
    session: StoredSession = request.state.session
    ip = client_ip(request)
    refusal: ApiError | None = None
    with db.begin() as conn:
        try:
            accounts.change_own_password(conn, user.id, user.email, body.currentPassword, body.newPassword, session.id)
        except accounts.AccountLockedError as error:
            detail = {"reason": "wrong_password"}
            record_audit(
                conn, "password_change_failed", actor_user_id=user.id, target_user_id=user.id, ip=ip, detail=detail
            )
            record_audit(conn, "account_locked", target_user_id=user.id, ip=ip)
            # Locking signed the user out everywhere; this session too.
            end_session(conn, session.id)
            refusal = ApiError(423, str(error))
        except accounts.WrongPasswordError as error:
            detail = {"reason": "wrong_password"}
            record_audit(
                conn, "password_change_failed", actor_user_id=user.id, target_user_id=user.id, ip=ip, detail=detail
            )
            refusal = ApiError(400, str(error))
        except (accounts.PasswordPolicyError, accounts.NoLocalPasswordError) as error:
            refusal = ApiError(400, str(error))
        if refusal is None:
            record_audit(conn, "password_changed", actor_user_id=user.id, target_user_id=user.id, ip=ip)
    if refusal is not None:
        raise refusal
    session.data["user"] = {**session.data["user"], "mustChangePassword": False}
    save_session(request, response, session)
    return {"user": session.data["user"]}


@router.post("/auth/mfa/verify", dependencies=[Depends(_require_local_auth)])
def mfa_verify(request: Request, response: Response, db: Db, body: CodeBody) -> dict[str, Any]:
    """The second sign-in step: an authenticator code or a recovery code. Wrong codes count toward the
    lockout like wrong passwords."""
    settings = _require_local_auth(request)
    session = read_session(request)
    pending = session.data.get("mfaPending") if session else None
    if session is None or not isinstance(pending, dict) or _now_ms() - pending.get("startedAt", 0) > MFA_PENDING_MS:
        if session is not None and pending:
            with db.begin() as conn:
                end_session(conn, session.id)
        raise ApiError(401, "Your sign-in timed out. Sign in again.")
    user_id = str(pending.get("userId"))
    ip = client_ip(request)
    refusal: ApiError | None = None
    result: dict[str, Any] = {}
    with db.begin() as conn:
        creds = conn.execute(
            text(
                "SELECT c.locked_at, u.active FROM local_credentials c JOIN users u ON u.id = c.user_id"
                " WHERE c.user_id = :id"
            ),
            {"id": user_id},
        ).first()
        method = None
        if creds is None or not creds.active:
            end_session(conn, session.id)
            refusal = ApiError(401, "Sign in again.")
        elif creds.locked_at is not None:
            end_session(conn, session.id)
            refusal = ApiError(423, accounts.LOCKED_MESSAGE)
        else:
            method = accounts.verify_second_factor(conn, user_id, body.code, settings.mfa_encryption_key)
            if method is None:
                record_audit(conn, "sign_in_failed", target_user_id=user_id, ip=ip, detail={"reason": "wrong_mfa_code"})
                if accounts.record_failed_attempt(conn, user_id):
                    record_audit(conn, "account_locked", target_user_id=user_id, ip=ip)
                    end_session(conn, session.id)
                    refusal = ApiError(423, accounts.LOCKED_MESSAGE)
                else:
                    refusal = ApiError(
                        401, "That code isn't right. Try the current code from your app, or a recovery code."
                    )
        if refusal is None and method is not None:
            accounts.clear_failed_attempts(conn, user_id)
            user = _local_session_user(conn, user_id, settings.mfa_required)
            if user is None:
                end_session(conn, session.id)
                refusal = ApiError(401, "Sign in again.")
            else:
                start_signed_in_session(conn, request, response, session, user)
                how = "password+authenticator" if method == "totp" else "password+recovery_code"
                record_audit(
                    conn, "sign_in", actor_user_id=user_id, target_user_id=user_id, ip=ip, detail={"method": how}
                )
                result = {"user": user}
                if method == "recovery_code":
                    result["recoveryCodesRemaining"] = accounts.remaining_recovery_codes(conn, user_id)
    if refusal is not None:
        raise refusal
    return result


@router.post("/auth/mfa/enroll", dependencies=[Depends(_require_local_auth)])
def mfa_enroll(request: Request, user: CurrentUser, db: Db) -> dict[str, str]:
    """Step 1 of setting up two-step verification: the secret, for the QR code or manual entry."""
    settings = _require_local_auth(request)
    if not user.localAccount:
        raise ApiError(400, "This account signs in with single sign-on.")
    with db.begin() as conn:
        try:
            secret = accounts.start_mfa_enrollment(conn, user.id, settings.mfa_encryption_key)
        except accounts.MfaAlreadyEnabledError as error:
            raise ApiError(409, str(error)) from error
    return {"secret": secret, "otpauthUri": otpauth_uri(secret, user.email)}


@router.post("/auth/mfa/enroll/confirm", dependencies=[Depends(_require_local_auth)])
def mfa_enroll_confirm(
    request: Request, response: Response, user: CurrentUser, db: Db, body: CodeBody
) -> dict[str, Any]:
    """Step 2: a code from the app confirms it; the recovery codes are returned, shown once."""
    settings = _require_local_auth(request)
    session: StoredSession = request.state.session
    with db.begin() as conn:
        try:
            codes = accounts.confirm_mfa_enrollment(conn, user.id, body.code, settings.mfa_encryption_key)
        except accounts.MfaAlreadyEnabledError as error:
            raise ApiError(409, str(error)) from error
        except (accounts.MfaNotStartedError, accounts.InvalidMfaCodeError) as error:
            raise ApiError(400, str(error)) from error
        record_audit(conn, "mfa_enrolled", actor_user_id=user.id, target_user_id=user.id, ip=client_ip(request))
    session.data["user"] = {**session.data["user"], "mfaEnabled": True, "mustEnrollMfa": False}
    save_session(request, response, session)
    return {"user": session.data["user"], "recoveryCodes": codes}


# --- Entra ID ----------------------------------------------------------------------------------------


def _oidc(request: Request) -> OidcClient:
    client: OidcClient | None = request.app.state.oidc_client
    if client is None:
        raise ApiError(404, f"Route {request.method}:{request.url.path} not found")
    return client


@router.get("/auth/login", response_model=None)
def oidc_login(request: Request, db: Db) -> RedirectResponse:
    """Starts an Entra sign-in: PKCE verifier, state and nonce kept in this session, then off to Entra."""
    client = _oidc(request)
    url, pending = client.start()
    redirect = RedirectResponse(url, status_code=302)
    fields = {"oidcCodeVerifier": pending.code_verifier, "oidcState": pending.state, "oidcNonce": pending.nonce}
    session = read_session(request)
    if session is not None:
        session.data.update(fields)
        save_session(request, redirect, session)
    else:
        with db.begin() as conn:
            start_session(conn, request, redirect, None, fields)
    return redirect


class _InactiveUserError(Exception):
    pass


def _find_or_create_user(conn: Connection, sub: str, email: str | None, name: str | None, role: str) -> dict[str, Any]:
    """The user with this email, its role synced from Entra (the source of truth once they use SSO), or a
    new one. Personas stay as an admin set them."""
    email = email or f"{sub}@unknown.local"
    name = name or email
    row = conn.execute(
        text("SELECT id, email, name, role, active FROM users WHERE email = :email"), {"email": email}
    ).first()
    if row is not None:
        if not row.active:
            raise _InactiveUserError(email)
        user_id = str(row.id)
        if row.role != role:
            conn.execute(text("UPDATE users SET role = :role WHERE id = :id"), {"role": role, "id": user_id})
        return {"id": user_id, "email": row.email, "name": row.name, "role": role, "personas": _personas(conn, user_id)}
    user_id = str(uuid4())
    conn.execute(
        text("INSERT INTO users (id, name, email, role) VALUES (:id, :name, :email, :role)"),
        {"id": user_id, "name": name, "email": email, "role": role},
    )
    return {"id": user_id, "email": email, "name": name, "role": role, "personas": []}


@router.get("/auth/callback", response_model=None)
def oidc_callback(request: Request, db: Db) -> RedirectResponse:
    client = _oidc(request)
    settings = _settings(request)
    session = read_session(request)
    data = session.data if session else {}
    verifier, state, nonce = data.get("oidcCodeVerifier"), data.get("oidcState"), data.get("oidcNonce")
    if session is None or not (verifier and state and nonce):
        raise ApiError(400, "No pending OIDC login for this session")
    # Cleared up front, not only on success: a failed sign-in must leave nothing a retry could reuse.
    for key in ("oidcCodeVerifier", "oidcState", "oidcNonce"):
        session.data.pop(key, None)
    touch_session(request.app.state.db, session.id, session.data, settings)

    params = {key: request.query_params.getlist(key)[0] for key in request.query_params}
    try:
        claims, id_token = client.finish(params, PendingLogin(str(verifier), str(state), str(nonce)))
    except OidcAuthorizationDenied as denied:
        # Authenticated with Entra but not allowed into this app (e.g. AADSTS50105). Logged, not shown.
        log.warning("OIDC authorization denied", error=denied.error, description=denied.description)
        raise ApiError(403, "You are not authorized to access this application.") from denied
    except (OidcError, httpx.HTTPError, ValueError, KeyError, TypeError) as error:
        # Never the tokens or claims in the log: they carry identity data.
        log.warning("OIDC callback failed validation", err=str(error))
        raise ApiError(401, "SSO sign-in failed") from error
    if not claims.get("sub"):
        raise ApiError(401, "OIDC provider did not return a subject claim")

    sub, email, name = extract_identity(claims)
    role = map_idp_roles_to_user_role(extract_entra_roles(claims))
    redirect = RedirectResponse(f"{settings.web_origin_list[0]}/?signin=sso", status_code=302)
    try:
        with db.begin() as conn:
            user = _find_or_create_user(conn, sub, email, name, role)
            if settings.entra_groups:
                record_memberships(conn, user["id"], claims)  # canvas-2h2w.3
            start_session(
                conn,
                request,
                redirect,
                session,
                {"user": user, "authenticatedAt": _now_ms(), "oidcIdToken": id_token},
            )
    except _InactiveUserError as error:
        raise ApiError(403, "This account has been deactivated.") from error
    return redirect
