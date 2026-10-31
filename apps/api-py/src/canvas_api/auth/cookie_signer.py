"""The session cookie's signature, exactly as @fastify/cookie's Signer makes it.

value = f"{session_id}.{base64(HMAC-SHA256(secret, session_id)) without '=' padding}"
(node_modules/@fastify/cookie/signer.js). Checked in constant time, like the original.
"""

from __future__ import annotations

import base64
import hashlib
import hmac


def _signature(value: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), value.encode(), hashlib.sha256).digest()
    return base64.b64encode(digest).decode().replace("=", "")


def sign(value: str, secret: str) -> str:
    return f"{value}.{_signature(value, secret)}"


def unsign(signed: str, secret: str) -> str | None:
    """The signed value, or None when the signature is wrong or missing."""
    dot = signed.rfind(".")
    if dot <= 0:
        return None
    value, actual = signed[:dot], signed[dot + 1 :]
    expected = _signature(value, secret)
    return value if hmac.compare_digest(expected.encode(), actual.encode()) else None
