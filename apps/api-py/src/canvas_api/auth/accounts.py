"""Canvas-password accounts and their two-step verification (apps/api/src/admin/local-accounts.service.ts,
apps/api/src/auth/mfa.service.ts).

An admin creates a user or resets a password; either way a one-time password is generated, shown to the
admin once and stored only as a hash, and the user must change it at their next sign-in. Three failed
attempts in a row (wrong password, wrong code) lock the account until an admin unlocks or resets it.
Two-step verification is an authenticator-app code after the password, or one of ten single-use recovery
codes; the app's secret is stored encrypted.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import time
from typing import Any, Literal
from uuid import uuid4

from sqlalchemy import Connection, text

from canvas_api.auth.mfa_crypto import decrypt_secret, encrypt_secret
from canvas_api.auth.passwords import check_password_policy, hash_password, verify_password
from canvas_api.auth.session import revoke_sessions
from canvas_api.auth.totp import generate_totp_secret, verify_totp
from canvas_api.github.jstext import JS_WHITESPACE, js_trim, js_utf8
from canvas_api.timestamps import now_utc, to_db

MAX_FAILED_ATTEMPTS = 3
LOCKED_MESSAGE = "This account is locked after too many failed sign-in attempts. Ask an admin to unlock it."
RECOVERY_CODE_COUNT = 10
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_RECOVERY_SEPARATORS = re.compile(f"[{JS_WHITESPACE}-]")
_AUTHENTICATOR_CODE = re.compile(f"[0-9]{{3}}[{JS_WHITESPACE}]?[0-9]{{3}}")


class AccountError(Exception):
    """A refusal shown to the user as is."""


class PasswordPolicyError(AccountError):
    pass


class WrongPasswordError(AccountError):
    pass


class NoLocalPasswordError(AccountError):
    pass


class AccountLockedError(AccountError):
    pass


class EmailInUseError(AccountError):
    pass


class UserNotFoundError(AccountError):
    pass


class MfaAlreadyEnabledError(AccountError):
    pass


class MfaNotStartedError(AccountError):
    pass


class InvalidMfaCodeError(AccountError):
    pass


def normalize_email(email: str) -> str:
    return js_trim(email).lower()


def _now(conn: Connection) -> Any:
    return to_db(now_utc(), conn.dialect.name)


# --- lockout ---------------------------------------------------------------------------------------


def record_failed_attempt(conn: Connection, user_id: str) -> bool:
    """Counts a failed attempt; True when this one locked the account (the user is then signed out
    everywhere)."""
    conn.execute(
        text("UPDATE local_credentials SET failed_attempts = failed_attempts + 1 WHERE user_id = :id"), {"id": user_id}
    )
    row = conn.execute(
        text("SELECT failed_attempts, locked_at FROM local_credentials WHERE user_id = :id"), {"id": user_id}
    ).first()
    if row is None or row.locked_at is not None or row.failed_attempts < MAX_FAILED_ATTEMPTS:
        return False
    conn.execute(
        text("UPDATE local_credentials SET locked_at = :at WHERE user_id = :id"), {"at": _now(conn), "id": user_id}
    )
    revoke_sessions(conn, user_id)
    return True


def clear_failed_attempts(conn: Connection, user_id: str) -> None:
    conn.execute(text("UPDATE local_credentials SET failed_attempts = 0 WHERE user_id = :id"), {"id": user_id})


def _require_user(conn: Connection, user_id: str) -> None:
    row = conn.execute(text("SELECT id FROM users WHERE id = :id AND deleted_at IS NULL"), {"id": user_id}).first()
    if row is None:
        raise UserNotFoundError(f"No user with id {user_id}")


def unlock_account(conn: Connection, user_id: str) -> bool:
    """False when the account wasn't locked (or has no Canvas password)."""
    _require_user(conn, user_id)
    result = conn.execute(
        text(
            "UPDATE local_credentials SET failed_attempts = 0, locked_at = NULL"
            " WHERE user_id = :id AND locked_at IS NOT NULL"
        ),
        {"id": user_id},
    )
    return bool(result.rowcount)


# --- one-time passwords ----------------------------------------------------------------------------


def create_local_user(
    conn: Connection, email: str, name: str, role: str, personas: list[str], temporary_password: str
) -> dict[str, Any]:
    email = normalize_email(email)
    name = js_trim(name) or email
    password_hash, salt = hash_password(temporary_password)
    if conn.execute(text("SELECT id FROM users WHERE email = :email"), {"email": email}).first() is not None:
        raise EmailInUseError("A user with that email already exists.")
    user_id = str(uuid4())
    conn.execute(
        text("INSERT INTO users (id, email, name, role) VALUES (:id, :email, :name, :role)"),
        {"id": user_id, "email": email, "name": name, "role": role},
    )
    conn.execute(
        text(
            "INSERT INTO local_credentials (user_id, password_hash, password_salt, must_change_password)"
            " VALUES (:id, :hash, :salt, :yes)"
        ),
        {"id": user_id, "hash": password_hash, "salt": salt, "yes": True},
    )
    if personas:
        conn.execute(
            text("INSERT INTO users_personas (user_id, persona, position) VALUES (:id, :persona, :position)"),
            [{"id": user_id, "persona": p, "position": i} for i, p in enumerate(personas)],
        )
    return {"id": user_id, "email": email, "name": name, "role": role, "active": True, "personas": personas}


_UPSERT_CREDENTIALS = text(
    "INSERT INTO local_credentials"
    " (user_id, password_hash, password_salt, must_change_password, failed_attempts, locked_at)"
    " VALUES (:id, :hash, :salt, :yes, 0, NULL)"
    " ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash,"
    " password_salt = excluded.password_salt, must_change_password = excluded.must_change_password,"
    " failed_attempts = 0, locked_at = NULL"
)


def set_one_time_password(conn: Connection, user_id: str, password: str) -> None:
    """Makes `password` the user's one-time password (creating Canvas credentials if they had none), unlocks
    the account and signs them out everywhere."""
    password_hash, salt = hash_password(password)
    _require_user(conn, user_id)
    conn.execute(_UPSERT_CREDENTIALS, {"id": user_id, "hash": password_hash, "salt": salt, "yes": True})
    revoke_sessions(conn, user_id)


def change_own_password(
    conn: Connection, user_id: str, email: str, current_password: str, new_password: str, session_id: str
) -> None:
    """A signed-in user changing their own password; their other sessions end. A wrong current password
    counts toward the lockout (someone at an unattended session): the caller commits that count even when
    this raises."""
    row = conn.execute(
        text("SELECT password_hash, password_salt FROM local_credentials WHERE user_id = :id"), {"id": user_id}
    ).first()
    if row is None:
        raise NoLocalPasswordError("This account signs in with single sign-on and has no Canvas password.")
    if not verify_password(current_password, row.password_hash, row.password_salt):
        if record_failed_attempt(conn, user_id):
            raise AccountLockedError(LOCKED_MESSAGE)
        raise WrongPasswordError("Your current password is incorrect.")
    clear_failed_attempts(conn, user_id)
    if new_password == current_password:
        raise PasswordPolicyError("Choose a new password, different from the current one.")
    problem = check_password_policy(new_password, email)
    if problem:
        raise PasswordPolicyError(problem)
    password_hash, salt = hash_password(new_password)
    conn.execute(
        text(
            "UPDATE local_credentials SET password_hash = :hash, password_salt = :salt, must_change_password = :no"
            " WHERE user_id = :id"
        ),
        {"hash": password_hash, "salt": salt, "no": False, "id": user_id},
    )
    conn.execute(
        text("UPDATE sessions SET revoked = :yes, data = '{}' WHERE user_id = :uid AND id != :keep"),
        {"yes": True, "uid": user_id, "keep": session_id},
    )


# --- two-step verification -------------------------------------------------------------------------


def is_mfa_enabled(conn: Connection, user_id: str) -> bool:
    row = conn.execute(text("SELECT enabled_at FROM user_mfa WHERE user_id = :id"), {"id": user_id}).first()
    return row is not None and row.enabled_at is not None


_UPSERT_MFA = text(
    "INSERT INTO user_mfa (user_id, secret_encrypted, enabled_at, last_used_step) VALUES (:id, :secret, NULL, NULL)"
    " ON CONFLICT (user_id) DO UPDATE SET secret_encrypted = excluded.secret_encrypted, enabled_at = NULL,"
    " last_used_step = NULL"
)


def start_mfa_enrollment(conn: Connection, user_id: str, key: bytes) -> str:
    """Starts (or restarts) set-up: a new secret, not active until confirmed with a code."""
    if is_mfa_enabled(conn, user_id):
        raise MfaAlreadyEnabledError("Two-step verification is already set up.")
    secret = generate_totp_secret()
    conn.execute(_UPSERT_MFA, {"id": user_id, "secret": encrypt_secret(secret, key)})
    return secret


def _now_ms() -> int:
    return int(time.time() * 1000)


def confirm_mfa_enrollment(conn: Connection, user_id: str, code: str, key: bytes) -> list[str]:
    """Confirms set-up with a code from the app; returns the recovery codes (shown once)."""
    row = conn.execute(
        text("SELECT secret_encrypted, enabled_at FROM user_mfa WHERE user_id = :id"), {"id": user_id}
    ).first()
    if row is not None and row.enabled_at is not None:
        raise MfaAlreadyEnabledError("Two-step verification is already set up.")
    if row is None:
        raise MfaNotStartedError("Start setting up two-step verification first.")
    step = verify_totp(decrypt_secret(row.secret_encrypted, key), code, _now_ms(), None)
    if step is None:
        raise InvalidMfaCodeError("That code didn't match. Check the time on your phone and try the current code.")
    codes = [_recovery_code() for _ in range(RECOVERY_CODE_COUNT)]
    conn.execute(
        text("UPDATE user_mfa SET enabled_at = :at, last_used_step = :step WHERE user_id = :id"),
        {"at": _now(conn), "step": step, "id": user_id},
    )
    conn.execute(text("DELETE FROM mfa_recovery_codes WHERE user_id = :id"), {"id": user_id})
    conn.execute(
        text("INSERT INTO mfa_recovery_codes (id, user_id, code_hash, used_at) VALUES (:rid, :id, :hash, NULL)"),
        [{"rid": str(uuid4()), "id": user_id, "hash": _hash_recovery_code(c)} for c in codes],
    )
    return codes


_USE_STEP = text(
    "UPDATE user_mfa SET last_used_step = :step"
    " WHERE user_id = :id AND (last_used_step IS NULL OR last_used_step < :step)"
)
_USE_RECOVERY_CODE = text(
    "UPDATE mfa_recovery_codes SET used_at = :at WHERE user_id = :id AND code_hash = :hash AND used_at IS NULL"
)


def verify_second_factor(
    conn: Connection, user_id: str, code: str, key: bytes
) -> Literal["totp", "recovery_code"] | None:
    """An authenticator code (not one already used) or an unused recovery code: which one matched, or None.
    Both are conditional updates, so two requests racing with the same code can't both succeed."""
    row = conn.execute(
        text("SELECT secret_encrypted, enabled_at, last_used_step FROM user_mfa WHERE user_id = :id"), {"id": user_id}
    ).first()
    if row is None or row.enabled_at is None:
        return None
    trimmed = js_trim(code)
    if _AUTHENTICATOR_CODE.fullmatch(trimmed):
        last_used = None if row.last_used_step is None else int(row.last_used_step)
        step = verify_totp(decrypt_secret(row.secret_encrypted, key), trimmed, _now_ms(), last_used)
        if step is None:
            return None
        return "totp" if conn.execute(_USE_STEP, {"step": step, "id": user_id}).rowcount else None
    used = conn.execute(_USE_RECOVERY_CODE, {"at": _now(conn), "id": user_id, "hash": _hash_recovery_code(trimmed)})
    return "recovery_code" if used.rowcount else None


def remaining_recovery_codes(conn: Connection, user_id: str) -> int:
    return int(
        conn.execute(
            text("SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = :id AND used_at IS NULL"), {"id": user_id}
        ).scalar_one()
    )


def reset_mfa(conn: Connection, user_id: str) -> None:
    """Admin reset (lost phone): removes it; the user sets it up again at next sign-in."""
    conn.execute(text("DELETE FROM mfa_recovery_codes WHERE user_id = :id"), {"id": user_id})
    conn.execute(text("DELETE FROM user_mfa WHERE user_id = :id"), {"id": user_id})
    revoke_sessions(conn, user_id)


def _recovery_code() -> str:
    """ "xxxxx-xxxxx" from a 31-character alphabet (~50 bits)."""
    code = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(10))
    return f"{code[:5]}-{code[5:]}"


def _hash_recovery_code(code: str) -> str:
    """Recovery codes are random (not chosen by people), so a plain SHA-256 is enough."""
    normalized = _RECOVERY_SEPARATORS.sub("", code.lower())
    return hashlib.sha256(js_utf8(f"canvas-recovery:{normalized}")).hexdigest()
