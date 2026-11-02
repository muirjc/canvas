"""Canvas passwords (apps/api/src/auth/password.ts, password-policy.ts).

Hashes are scrypt (N=16384, r=8, p=1, 64 bytes; Node's scryptSync defaults) with a 16-byte hex salt, used as
text like Node does, so a password set by either service signs in through the other.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

from canvas_api.github.jstext import js_len, js_utf8

KEY_LENGTH = 64
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 256

_COMMON_PASSWORDS = frozenset(
    {
        "123456789012",
        "1234567890123",
        "password1234",
        "password12345",
        "passwordpassword",
        "qwertyuiopas",
        "qwerty123456",
        "1q2w3e4r5t6y",
        "iloveyou1234",
        "adminadmin123",
        "administrator",
        "letmein12345",
        "welcome12345",
        "changeme1234",
        "abc123456789",
        "aaaaaaaaaaaa",
        "111111111111",
        "000000000000",
        "canvascanvas",
        "canvas123456",
        "trustno11234",
        "football1234",
        "baseball1234",
        "superman1234",
    }
)
_ONE_CHARACTER_REPEATED = re.compile(r"(.)\1+")

#: No 0/O, 1/l/I: one-time passwords are read off a screen and typed in by someone else.
_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _scrypt(password: str, salt: str) -> bytes:
    return hashlib.scrypt(js_utf8(password), salt=js_utf8(salt), n=16384, r=8, p=1, dklen=KEY_LENGTH)


def hash_password(password: str) -> tuple[str, str]:
    """(hash, salt), both hex."""
    salt = secrets.token_hex(16)
    return _scrypt(password, salt).hex(), salt


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    candidate = _scrypt(password, salt)
    try:
        expected = bytes.fromhex(password_hash)
    except ValueError:
        return False
    return len(candidate) == len(expected) and hmac.compare_digest(candidate, expected)


def check_password_policy(password: str, email: str | None = None) -> str | None:
    """Why `password` isn't acceptable, or None. At least 12 characters, no composition rules, and not one
    of the passwords attackers try first (NIST SP 800-63B). Lengths count as JavaScript does."""
    if js_len(password) < MIN_PASSWORD_LENGTH:
        return f"Passwords must be at least {MIN_PASSWORD_LENGTH} characters."
    if js_len(password) > MAX_PASSWORD_LENGTH:
        return f"Passwords can be at most {MAX_PASSWORD_LENGTH} characters."
    lower = password.lower()
    if lower in _COMMON_PASSWORDS or _ONE_CHARACTER_REPEATED.fullmatch(password):
        return "That password is too common. Choose something harder to guess."
    local_part = email.split("@")[0].lower() if email else ""
    if js_len(local_part) >= 4 and local_part in lower:
        return "Passwords can't contain your email address."
    return None


def generate_one_time_password() -> str:
    """4 groups of 4 from a 55-character alphabet (~92 bits), e.g. "x7Kp-..."."""
    return "-".join("".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(4))
