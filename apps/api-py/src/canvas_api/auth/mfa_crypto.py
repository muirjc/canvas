"""Authenticator secrets at rest (apps/api/src/auth/mfa-crypto.ts): AES-256-GCM, stored as
"v1:<iv>:<tag>:<ciphertext>" with base64 parts. The full 16-byte tag is required: a shorter (truncated)
one is refused."""

from __future__ import annotations

import base64
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TAG_LENGTH = 16


def encrypt_secret(plaintext: str, key: bytes) -> str:
    iv = secrets.token_bytes(12)
    sealed = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    ciphertext, tag = sealed[:-TAG_LENGTH], sealed[-TAG_LENGTH:]
    return ":".join(["v1", *(base64.b64encode(part).decode() for part in (iv, tag, ciphertext))])


def decrypt_secret(stored: str, key: bytes) -> str:
    parts = stored.split(":")
    if len(parts) < 4 or parts[0] != "v1" or not all(parts[1:4]):
        raise ValueError("Unrecognized encrypted secret format")
    iv, tag, ciphertext = (base64.b64decode(part) for part in parts[1:4])
    if len(tag) != TAG_LENGTH:
        raise ValueError("Unrecognized encrypted secret format")
    return AESGCM(key).decrypt(iv, ciphertext + tag, None).decode()
