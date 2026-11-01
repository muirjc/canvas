"""GitHub App settings (parse_github_config, via Settings.github). A bad key fails at startup. Port of
apps/api/tests/unit/github-config.test.ts."""

from __future__ import annotations

import base64
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from canvas_api.config import Settings

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PKCS8 = _KEY.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()
PKCS1 = _KEY.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()
).decode()


def load(**env: str) -> Settings:
    return Settings(DATABASE_URL=":memory:", SESSION_SECRET="x" * 32, **env)  # type: ignore[arg-type]


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def test_is_none_integration_off_when_unset_partly_set_or_unset_word() -> None:
    assert load().github is None
    assert load(GITHUB_APP_ID="123").github is None
    assert load(GITHUB_APP_PRIVATE_KEY=PKCS8).github is None
    assert load(GITHUB_APP_ID="unset", GITHUB_APP_PRIVATE_KEY=PKCS8).github is None
    assert load(GITHUB_APP_ID="123", GITHUB_APP_PRIVATE_KEY="unset").github is None
    assert load(GITHUB_APP_ID="  ", GITHUB_APP_PRIVATE_KEY=PKCS8).github is None


@pytest.mark.parametrize(
    "key",
    [
        PKCS8,
        PKCS1,
        PKCS8.strip().replace("\n", "\\n"),
        b64(PKCS8),
        f"  {b64(PKCS1)}\n",
    ],
    ids=["pkcs8", "pkcs1", "escaped-newlines", "base64-pkcs8", "base64-pkcs1-padded"],
)
def test_accepts_a_pem_a_pkcs1_pem_a_pem_with_literal_escapes_and_base64_of_the_pem(key: str) -> None:
    github = load(GITHUB_APP_ID="4242", GITHUB_APP_PRIVATE_KEY=key).github
    assert github is not None
    assert github.app_id == "4242"
    assert isinstance(github.private_key, rsa.RSAPrivateKey)


def test_defaults_the_api_to_api_github_com_and_trims_a_trailing_slash() -> None:
    assert load(GITHUB_APP_ID="1", GITHUB_APP_PRIVATE_KEY=PKCS8).github.api_url == "https://api.github.com"  # type: ignore[union-attr]
    ghe = load(GITHUB_APP_ID="1", GITHUB_APP_PRIVATE_KEY=PKCS8, GITHUB_APP_API_URL="https://ghe.example.com/api/v3/")
    assert ghe.github.api_url == "https://ghe.example.com/api/v3"  # type: ignore[union-attr]


def test_raises_for_a_bad_key_or_a_non_numeric_app_id() -> None:
    with pytest.raises(ValueError, match="GITHUB_APP_PRIVATE_KEY"):
        _ = load(GITHUB_APP_ID="1", GITHUB_APP_PRIVATE_KEY="not a key").github
    broken = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"
    with pytest.raises(ValueError, match="GITHUB_APP_PRIVATE_KEY"):
        _ = load(GITHUB_APP_ID="1", GITHUB_APP_PRIVATE_KEY=broken).github
    with pytest.raises(ValueError, match="numeric"):
        _ = load(GITHUB_APP_ID="abc", GITHUB_APP_PRIVATE_KEY=PKCS8).github


def test_rejects_the_public_half_of_a_key() -> None:
    """The App must sign, not verify."""
    public = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    with pytest.raises(ValueError, match="GITHUB_APP_PRIVATE_KEY"):
        _ = load(GITHUB_APP_ID="1", GITHUB_APP_PRIVATE_KEY=public).github


def test_rejects_a_non_https_api_url_except_for_localhost_and_127_0_0_1() -> None:
    base: dict[str, Any] = {"GITHUB_APP_ID": "1", "GITHUB_APP_PRIVATE_KEY": PKCS8}

    def github(url: str) -> Any:
        return load(**base, GITHUB_APP_API_URL=url).github

    for url in ("http://api.github.com", "http://github.example.com", "http://localhost.evil.com"):
        with pytest.raises(ValueError, match="https"):
            github(url)
    with pytest.raises(ValueError):
        github("not a url")
    assert github("http://localhost:4010").api_url == "http://localhost:4010"
    assert github("http://127.0.0.1:4010/").api_url == "http://127.0.0.1:4010"


def test_public_url_uses_canvas_public_url_else_the_first_web_origin_else_localhost() -> None:
    assert load(CANVAS_PUBLIC_URL="https://canvas.example.com/").canvas_public_url == "https://canvas.example.com"
    assert load(WEB_ORIGINS="https://a.example.com, https://b.example.com").canvas_public_url == "https://a.example.com"
    assert load().canvas_public_url == "http://localhost:5173"
