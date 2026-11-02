"""Authenticator-app codes (apps/api/src/auth/totp.ts): RFC 6238 TOTP over RFC 4226 HOTP, SHA-1, 6 digits,
30-second steps -- the defaults every authenticator app supports."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from urllib.parse import quote, urlencode

from canvas_api.github.jstext import JS_WHITESPACE

STEP_SECONDS = 30
DIGITS = 6
_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
_SEPARATORS = re.compile(f"[{JS_WHITESPACE}=-]")
_SPACES = re.compile(f"[{JS_WHITESPACE}]")
_SIX_DIGITS = re.compile(r"[0-9]{6}")


def base32_encode(data: bytes) -> str:
    """Unpadded, as the TypeScript one."""
    bits = value = 0
    out = []
    for byte in data:
        value = ((value << 8) | byte) & 0xFFFFFFFF
        bits += 8
        while bits >= 5:
            out.append(_BASE32[(value >> (bits - 5)) & 31])
            bits -= 5
    if bits > 0:
        out.append(_BASE32[(value << (5 - bits)) & 31])
    return "".join(out)


def base32_decode(text: str) -> bytes:
    clean = _SEPARATORS.sub("", text).upper()
    bits = value = 0
    out = bytearray()
    for char in clean:
        index = _BASE32.find(char)
        if index < 0:
            raise ValueError("Invalid base32")
        value = ((value << 5) | index) & 0xFFFFFFFF
        bits += 5
        if bits >= 8:
            out.append((value >> (bits - 8)) & 255)
            bits -= 8
    return bytes(out)


def generate_totp_secret() -> str:
    """20 random bytes (160 bits, RFC 4226's recommendation), base32 for the apps."""
    return base32_encode(secrets.token_bytes(20))


def time_step(now_ms: int) -> int:
    return now_ms // 1000 // STEP_SECONDS


def totp_code(secret: str, step: int) -> str:
    digest = hmac.new(base32_decode(secret), step.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(binary % 10**DIGITS).zfill(DIGITS)


def verify_totp(secret: str, code: str, now_ms: int, last_used_step: int | None) -> int | None:
    """The matching step for `code` (now, or one step either side for clock drift), or None. A step at or
    before `last_used_step` is refused, so a code can't be replayed."""
    normalized = _SPACES.sub("", code)
    if not _SIX_DIGITS.fullmatch(normalized):
        return None
    current = time_step(now_ms)
    for step in (current, current - 1, current + 1):
        if last_used_step is not None and step <= last_used_step:
            continue
        if hmac.compare_digest(totp_code(secret, step), normalized):
            return step
    return None


def otpauth_uri(secret: str, account: str, issuer: str = "Canvas") -> str:
    """What the set-up QR code holds. Encoded as JavaScript's encodeURIComponent and URLSearchParams."""
    label = quote(f"{issuer}:{account}", safe="-_.!~*'()")
    params = urlencode(
        {"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": str(DIGITS), "period": str(STEP_SECONDS)}
    )
    return f"otpauth://totp/{label}?{params}"
