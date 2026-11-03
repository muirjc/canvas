"""canvas-1bty.13: the pieces of sign-in on their own (ports apps/api tests/unit/{login-rate-limit,mfa-crypto,
password-policy,totp,oidc}.test.ts and the sign-in parts of config.test.ts), plus the cross-service vectors.

Compatibility with what the TypeScript service stored (passwords, authenticator secrets, recovery codes): the
fixed values below were made by its own code (tag typescript-api-final), with
  node -e "import('/.../apps/api/src/auth/password.ts').then(...)"  (hashPassword, encryptSecret, totpCode)"""

from __future__ import annotations

import base64
import hashlib
import secrets
from typing import Any

import httpx
import pytest
from cryptography.exceptions import InvalidTag
from sqlalchemy import Engine

from canvas_api.app import create_app
from canvas_api.auth import accounts
from canvas_api.auth.mfa_crypto import decrypt_secret, encrypt_secret
from canvas_api.auth.oidc import (
    OidcClient,
    extract_entra_roles,
    extract_identity,
    map_idp_roles_to_user_role,
)
from canvas_api.auth.passwords import (
    MAX_PASSWORD_LENGTH,
    check_password_policy,
    generate_one_time_password,
    verify_password,
)
from canvas_api.auth.rate_limit import LoginRateLimiter
from canvas_api.auth.totp import (
    base32_decode,
    base32_encode,
    generate_totp_secret,
    otpauth_uri,
    time_step,
    totp_code,
    verify_totp,
)
from canvas_api.config import OidcConfig, Settings, validate_oidc_issuer_url
from tests.conftest import TEST_SESSION_SECRET

# --- the login rate limiter -------------------------------------------------------------------------------


def test_the_rate_limiter_allows_up_to_the_limit_per_key_per_minute_then_refuses() -> None:
    limiter = LoginRateLimiter(3, lambda: 0)
    assert [limiter.allow("a") for _ in range(5)] == [True, True, True, False, False]


def test_the_rate_limiter_counts_keys_separately() -> None:
    limiter = LoginRateLimiter(1, lambda: 0)
    assert limiter.allow("a") is True
    assert limiter.allow("a") is False
    assert limiter.allow("b") is True


def test_the_rate_limiter_starts_a_fresh_window_after_a_minute_not_before() -> None:
    now = [1_000.0]
    limiter = LoginRateLimiter(1, lambda: now[0])
    assert limiter.allow("a") is True
    now[0] += 59.999
    assert limiter.allow("a") is False
    now[0] += 0.001
    assert limiter.allow("a") is True
    assert limiter.allow("a") is False


def test_a_rate_limit_of_zero_means_unlimited() -> None:
    limiter = LoginRateLimiter(0, lambda: 0)
    assert all(limiter.allow("a") for _ in range(1000))


def test_the_rate_limiter_forgets_old_windows_instead_of_growing_forever() -> None:
    now = [0.0]
    limiter = LoginRateLimiter(5, lambda: now[0])
    for i in range(10_001):
        limiter.allow(f"key-{i}")
    now[0] = 120.0
    limiter.allow("fresh")
    assert len(limiter._windows) == 1


# --- authenticator secrets at rest --------------------------------------------------------------------------

SECRET = "JBSWY3DPEHPK3PXP"


def test_encrypting_round_trips_and_hides_the_plaintext() -> None:
    key = secrets.token_bytes(32)
    stored = encrypt_secret(SECRET, key)
    assert stored.startswith("v1:")
    assert SECRET not in stored
    assert decrypt_secret(stored, key) == SECRET


def test_every_encryption_uses_a_fresh_iv() -> None:
    key = secrets.token_bytes(32)
    assert encrypt_secret(SECRET, key) != encrypt_secret(SECRET, key)


def _flip(part: str) -> str:
    raw = bytearray(base64.b64decode(part))
    raw[0] ^= 1
    return base64.b64encode(bytes(raw)).decode()


def test_a_tampered_ciphertext_or_tag_is_refused() -> None:
    key = secrets.token_bytes(32)
    version, iv, tag, ciphertext = encrypt_secret(SECRET, key).split(":")
    for broken in (":".join([version, iv, tag, _flip(ciphertext)]), ":".join([version, iv, _flip(tag), ciphertext])):
        with pytest.raises(InvalidTag):
            decrypt_secret(broken, key)


def test_the_wrong_key_is_refused() -> None:
    with pytest.raises(InvalidTag):
        decrypt_secret(encrypt_secret(SECRET, secrets.token_bytes(32)), secrets.token_bytes(32))


@pytest.mark.parametrize("stored", ["v2:a:b:c", "garbage", "v1:a:b", "v1::b:c"])
def test_an_unrecognised_format_is_refused(stored: str) -> None:
    with pytest.raises(ValueError, match="format"):
        decrypt_secret(stored, bytes(32))


def test_a_truncated_authentication_tag_is_refused() -> None:
    """canvas-ez1.6, Semgrep gcm-no-tag-length."""
    key = bytes([7]) * 32
    version, iv, tag, ciphertext = encrypt_secret(SECRET, key).split(":")
    truncated = base64.b64encode(base64.b64decode(tag)[:4]).decode()
    with pytest.raises(ValueError, match="format"):
        decrypt_secret(":".join([version, iv, truncated, ciphertext]), key)


# TypeScript made this with encryptSecret('JBSWY3DPEHPK3PXP', key), key = the dev key derived from the tests'
# session secret (sha256 of "canvas-mfa-key:" + secret, which config.ts and config.py both do).
TS_MFA_KEY_HEX = "7d5055f0b72744476088a73aaf1c9c537ffb613c16b667ba1701c7b6cd9306c9"  # gitleaks:allow
TS_MFA_CIPHERTEXT = "v1:zHgWS5fDH1dubWxM:UzB+2Dgg/drewTYko7LNBQ==:qh58z4zSEmsDJp5uaysm9g=="


def test_the_derived_dev_key_is_the_one_typescript_derives(settings: Settings) -> None:
    assert settings.mfa_encryption_key.hex() == TS_MFA_KEY_HEX


def test_a_typescript_made_ciphertext_decrypts_in_python(settings: Settings) -> None:
    assert decrypt_secret(TS_MFA_CIPHERTEXT, settings.mfa_encryption_key) == SECRET


# --- password policy ----------------------------------------------------------------------------------------


def test_accepts_twelve_or_more_characters_with_no_composition_rules() -> None:
    assert check_password_policy("correct horse battery") is None
    assert check_password_policy("abcdefghijkl") is None


def test_rejects_fewer_than_twelve_characters() -> None:
    assert "at least 12" in (check_password_policy("shortpass11") or "")
    assert "at least 12" in (check_password_policy("") or "")


def test_rejects_more_than_the_maximum_length() -> None:
    assert "at most" in (check_password_policy("ab" * MAX_PASSWORD_LENGTH) or "")
    assert check_password_policy("a1" * (MAX_PASSWORD_LENGTH // 2)) is None


def test_lengths_count_as_javascript_counts_them() -> None:
    """Six emoji are 12 UTF-16 code units in JavaScript (so allowed) but 6 Python characters."""
    assert check_password_policy("🔑🗝️🔐🔒🔓🔏") is None
    assert "at least 12" in (check_password_policy("🔑🔑🔑🔑🔑") or "")


def test_rejects_common_passwords_case_insensitively() -> None:
    assert "too common" in (check_password_policy("PasswordPassword") or "")
    assert "too common" in (check_password_policy("123456789012") or "")


def test_rejects_a_single_repeated_character() -> None:
    assert "too common" in (check_password_policy("zzzzzzzzzzzzzz") or "")


def test_rejects_a_password_containing_the_email_local_part_case_insensitively() -> None:
    assert "email" in (check_password_policy("xx-Jmuir-xx-yy", "JMuir@example.com") or "")


def test_ignores_email_local_parts_shorter_than_four_characters() -> None:
    assert check_password_policy("xx-abc-xx-yyyy", "abc@example.com") is None


def test_one_time_passwords_have_the_format_without_ambiguous_characters() -> None:
    import re

    pattern = re.compile(r"^[a-km-zA-HJ-NP-Z2-9]{4}(-[a-km-zA-HJ-NP-Z2-9]{4}){3}$")
    assert all(pattern.match(generate_one_time_password()) for _ in range(50))


def test_one_time_passwords_pass_the_policy_and_are_not_repeated() -> None:
    seen = {generate_one_time_password() for _ in range(50)}
    assert len(seen) == 50
    assert all(check_password_policy(p, "someone@example.com") is None for p in seen)


# --- password hashes, both directions -----------------------------------------------------------------------

# TypeScript's hashPassword made these (scryptSync(password, salt, 64), the hex salt used as text).
TS_PASSWORDS = [
    (
        "correct horse battery",
        "186acca6f05510d68d836028190a4be9d39f6c2141676bb4a2ef37419c7973d62408dbc74a3dd1cff1ac6e95b9e17bef94a983a5e14a624474153ea2dcded683",
        "f2ae93f5ef212a3e8175d38fa2cdf222",
    ),
    (
        "pässwörd-日本語-🔑 long enough",
        "0b123b7bb368ba16faa636db3fd1512ecc3015e0cd4402d802d252695d2da4fcdcf30cdd5e430c265e88ca57fcd75b48a950828e7680e354cd9819469454a74b",
        "11af36baf982f1146658d6224b92465f",
    ),
]


@pytest.mark.parametrize(("password", "password_hash", "salt"), TS_PASSWORDS)
def test_a_typescript_made_password_hash_verifies_in_python(password: str, password_hash: str, salt: str) -> None:
    assert verify_password(password, password_hash, salt) is True
    assert verify_password(password + "x", password_hash, salt) is False


def test_a_malformed_stored_hash_is_a_failed_check_not_an_error() -> None:
    assert verify_password("anything", "not-hex", "salt") is False
    assert verify_password("anything", "abcd", "salt") is False


# --- TOTP ---------------------------------------------------------------------------------------------------

# RFC 6238 Appendix B, SHA-1 key "12345678901234567890" (ASCII), 8-digit codes; ours are the last 6 digits.
RFC_SECRET = base32_encode(b"12345678901234567890")
RFC_VECTORS = [
    (59, "287082"),
    (1111111109, "081804"),
    (1111111111, "050471"),
    (1234567890, "005924"),
    (2000000000, "279037"),
]
# TypeScript's totpCode('JBSWY3DPEHPK3PXP', step).
TS_TOTP = [(0, "282760"), (1, "996554"), (56666666, "324550"), (57000000, "438643"), (58333333, "509970")]


@pytest.mark.parametrize(("seconds", "expected"), RFC_VECTORS)
def test_matches_the_rfc_6238_vectors(seconds: int, expected: str) -> None:
    assert totp_code(RFC_SECRET, time_step(seconds * 1000)) == expected


@pytest.mark.parametrize(("step", "expected"), TS_TOTP)
def test_matches_typescripts_totp_code(step: int, expected: str) -> None:
    assert totp_code(SECRET, step) == expected


def test_base32_encodes_the_rfc_key_to_the_well_known_string() -> None:
    assert RFC_SECRET == "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # gitleaks:allow


def test_base32_round_trips_and_tolerates_spaces_dashes_padding_and_lower_case() -> None:
    for length in (1, 2, 3, 4, 5, 19, 20, 21):
        data = bytes((i * 37 + length) % 256 for i in range(length))
        assert base32_decode(base32_encode(data)) == data
    assert base32_decode("gezd gnbv-GY3TQOJQ====") == b"1234567890"


def test_base32_decode_rejects_characters_outside_the_alphabet() -> None:
    with pytest.raises(ValueError, match="base32"):
        base32_decode("GEZD1")


def test_generates_a_160_bit_base32_secret_different_each_time() -> None:
    import re

    first = generate_totp_secret()
    assert re.fullmatch(r"[A-Z2-7]{32}", first)
    assert generate_totp_secret() != first


NOW = 1_700_000_000_000
STEP = time_step(NOW)


def _code(step: int) -> str:
    return totp_code(RFC_SECRET, step)


def test_accepts_the_current_step_and_one_either_side_returning_the_matched_step() -> None:
    assert verify_totp(RFC_SECRET, _code(STEP), NOW, None) == STEP
    assert verify_totp(RFC_SECRET, _code(STEP - 1), NOW, None) == STEP - 1
    assert verify_totp(RFC_SECRET, _code(STEP + 1), NOW, None) == STEP + 1


def test_refuses_steps_two_or_more_away() -> None:
    assert verify_totp(RFC_SECRET, _code(STEP - 2), NOW, None) is None
    assert verify_totp(RFC_SECRET, _code(STEP + 2), NOW, None) is None


def test_refuses_a_step_at_or_before_the_last_used_one_but_accepts_a_later_one() -> None:
    assert verify_totp(RFC_SECRET, _code(STEP), NOW, STEP) is None
    assert verify_totp(RFC_SECRET, _code(STEP - 1), NOW, STEP) is None
    assert verify_totp(RFC_SECRET, _code(STEP + 1), NOW, STEP) == STEP + 1


def test_ignores_whitespace_inside_the_code() -> None:
    code = _code(STEP)
    assert verify_totp(RFC_SECRET, f"{code[:3]} {code[3:]}", NOW, None) == STEP


@pytest.mark.parametrize("bad", ["", "abcdef", "12345", "1234567", "12345a", "١٢٣٤٥٦"])
def test_rejects_non_digit_wrong_length_and_empty_input(bad: str) -> None:
    assert verify_totp(RFC_SECRET, bad, NOW, None) is None


def test_builds_an_otpauth_uri_an_authenticator_app_understands() -> None:
    from urllib.parse import parse_qsl, unquote, urlsplit

    uri = urlsplit(otpauth_uri("ABCDEFGH", "ann@example.com"))
    assert (uri.scheme, uri.netloc) == ("otpauth", "totp")
    assert unquote(uri.path) == "/Canvas:ann@example.com"
    assert dict(parse_qsl(uri.query)) == {
        "secret": "ABCDEFGH",
        "issuer": "Canvas",
        "algorithm": "SHA1",
        "digits": "6",
        "period": "30",
    }


# --- recovery codes -----------------------------------------------------------------------------------------

# TypeScript's hashRecoveryCode: sha256("canvas-recovery:" + code.toLowerCase().replace(/[\s-]/g, "")).
TS_RECOVERY_HASH = "57fd5d91e8bd56c66c4ffc9096eccdf615d83379b00ad892a5f6e66fde3d02db"


@pytest.mark.parametrize("typed", ["ABCDE-fghjk", " abc de-FGH jk ", "abcdefghjk", "abcde-fghjk"])
def test_recovery_code_hashing_matches_typescript_whatever_the_spacing_dashes_and_case(typed: str) -> None:
    assert accounts._hash_recovery_code(typed) == TS_RECOVERY_HASH
    assert hashlib.sha256(b"canvas-recovery:abcdefghjk").hexdigest() == TS_RECOVERY_HASH


# --- Entra roles and identity (oidc.test.ts) ----------------------------------------------------------------


def test_reads_roles_from_a_flat_roles_claim() -> None:
    assert extract_entra_roles({"roles": ["admin", "SomeOtherAppRole"]}) == ["admin", "SomeOtherAppRole"]


def test_roles_are_empty_when_absent_or_not_a_list() -> None:
    assert extract_entra_roles({}) == []
    assert extract_entra_roles({"roles": "admin"}) == []


def test_non_string_roles_are_dropped() -> None:
    assert extract_entra_roles({"roles": ["admin", 42, None, "viewer"]}) == ["admin", "viewer"]


def test_a_keycloak_shaped_realm_access_claim_is_not_read() -> None:
    assert extract_entra_roles({"realm_access": {"roles": ["admin"]}}) == []


def test_a_single_recognised_role_maps_directly() -> None:
    for role in ("admin", "architect", "viewer"):
        assert map_idp_roles_to_user_role([role]) == role


def test_the_highest_privilege_role_wins() -> None:
    assert map_idp_roles_to_user_role(["viewer", "admin"]) == "admin"
    assert map_idp_roles_to_user_role(["viewer", "architect"]) == "architect"
    assert map_idp_roles_to_user_role(["architect", "admin"]) == "admin"


def test_unrecognised_roles_are_ignored_and_none_means_viewer() -> None:
    assert map_idp_roles_to_user_role(["SomeOtherAppRole", "architect"]) == "architect"
    assert map_idp_roles_to_user_role([]) == "viewer"
    assert map_idp_roles_to_user_role(["SomeOtherAppRole"]) == "viewer"


def test_reads_sub_email_and_name_off_the_id_token() -> None:
    assert extract_identity({"sub": "abc123", "email": "jane@example.com", "name": "Jane Doe"}) == (
        "abc123",
        "jane@example.com",
        "Jane Doe",
    )


def test_the_email_is_lowercased() -> None:
    assert extract_identity({"sub": "abc123", "email": "Jane.Doe@Contoso.com"})[1] == "jane.doe@contoso.com"


def test_preferred_username_stands_in_for_a_missing_email_only_when_it_looks_like_one() -> None:
    assert extract_identity({"sub": "a", "preferred_username": "Jane@Contoso.com"})[1] == "jane@contoso.com"
    assert extract_identity({"sub": "a", "preferred_username": "not-an-email"})[1] is None


def test_the_real_email_claim_beats_preferred_username() -> None:
    claims = {"sub": "a", "email": "real@example.com", "preferred_username": "upn@example.com"}
    assert extract_identity(claims)[1] == "real@example.com"


def test_no_email_or_name_is_none() -> None:
    assert extract_identity({"sub": "abc123"}) == ("abc123", None, None)


def test_a_missing_or_non_string_sub_is_an_empty_string() -> None:
    assert extract_identity({})[0] == ""
    assert extract_identity({"sub": 42})[0] == ""


# --- the end-session address (buildEndSessionUrl / canvas-252) ----------------------------------------------

ISSUER = "https://public.example.com"
LOGOUT = "https://idp.example.com/realms/Canvas/protocol/openid-connect/logout"


def oidc_client(document: dict[str, Any] | None, post_logout: str = "https://app.example.com/") -> OidcClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if document is None:
            return httpx.Response(500)
        return httpx.Response(200, json={"issuer": ISSUER, **document})

    config = OidcConfig(
        issuer_url=ISSUER, client_id="canvas-client", client_secret="secret", redirect_uri="http://x/cb"
    )
    return OidcClient(config, post_logout, httpx.MockTransport(handler))


def test_the_end_session_address_carries_client_id_id_token_hint_and_post_logout_redirect_uri() -> None:
    from urllib.parse import parse_qs, urlsplit

    url = oidc_client({"end_session_endpoint": LOGOUT}).end_session_url("the-id-token")
    assert url is not None
    parts = urlsplit(url)
    query = parse_qs(parts.query)
    assert query["client_id"] == ["canvas-client"]
    assert query["id_token_hint"] == ["the-id-token"]
    assert query["post_logout_redirect_uri"] == ["https://app.example.com/"]
    assert (parts.scheme, parts.netloc, parts.path) == (
        "https",
        "idp.example.com",
        "/realms/Canvas/protocol/openid-connect/logout",
    )


def test_the_end_session_values_are_url_encoded() -> None:
    url = oidc_client({"end_session_endpoint": LOGOUT}, "https://app.example.com/?x=1&y=2").end_session_url("t")
    assert url is not None
    assert "post_logout_redirect_uri=https%3A%2F%2Fapp.example.com%2F%3Fx%3D1%26y%3D2" in url


def test_an_end_session_endpoint_that_has_a_query_keeps_it() -> None:
    url = oidc_client({"end_session_endpoint": LOGOUT + "?p=B2C_1_signin"}).end_session_url("t")
    assert url is not None
    assert "?p=B2C_1_signin&client_id=canvas-client" in url


def test_no_end_session_endpoint_means_none() -> None:
    assert oidc_client({}).end_session_url("t") is None
    assert oidc_client({"end_session_endpoint": ""}).end_session_url("t") is None


def test_a_discovery_failure_means_none_not_an_error() -> None:
    assert oidc_client(None).end_session_url("t") is None


def test_discovery_for_a_different_issuer_is_refused() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"issuer": "https://evil.example.com", "end_session_endpoint": LOGOUT})

    config = OidcConfig(issuer_url=ISSUER, client_id="c", client_secret="s", redirect_uri="http://x/cb")
    assert OidcClient(config, "https://app/", httpx.MockTransport(handler)).end_session_url("t") is None


# --- sign-in settings (config.test.ts) ----------------------------------------------------------------------

ENTRA = {
    "oidc_issuer_url": "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0",
    "oidc_client_id": "client",
    "oidc_client_secret": "secret",
    "oidc_redirect_uri": "https://api.example.com/auth/callback",
}
KEY = base64.b64encode(bytes([7]) * 32).decode()


def with_(settings: Settings, **changes: Any) -> Settings:
    return settings.model_copy(update=changes)


def test_accepts_a_correctly_formed_entra_v2_issuer() -> None:
    validate_oidc_issuer_url("https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0")


@pytest.mark.parametrize(
    "issuer", [None, "", "https://public.example.com", "https://sts.windows.net/11111111-1111-1111-1111-111111111111/"]
)
def test_other_identity_providers_and_an_unset_issuer_are_left_alone(issuer: str | None) -> None:
    validate_oidc_issuer_url(issuer)


@pytest.mark.parametrize(
    ("issuer", "message"),
    [
        ("https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111", 'must end in "/v2.0"'),
        ("https://login.microsoftonline.com/common/v2.0", 'multi-tenant alias "/common/..."'),
        ("https://login.microsoftonline.com/organizations/v2.0", 'multi-tenant alias "/organizations/..."'),
        ("https://login.microsoftonline.com/consumers/v2.0", 'multi-tenant alias "/consumers/..."'),
        ("not a url", "OIDC_ISSUER_URL is not a valid URL"),
    ],
)
def test_rejects_a_misformed_issuer_with_a_clear_message(issuer: str, message: str) -> None:
    with pytest.raises(ValueError, match=message.replace("(", r"\(")):
        validate_oidc_issuer_url(issuer)


def test_entra_is_the_default_mode_and_keeps_the_oidc_settings(settings: Settings) -> None:
    config = with_(settings, **ENTRA)
    assert config.auth_mode == "entra"
    assert config.oidc is not None
    assert config.oidc.client_id == "client"
    assert config.allow_local_auth is False
    assert with_(settings, allow_local_auth_setting="true").allow_local_auth is True


def test_local_mode_forces_local_sign_in_on_and_drops_the_entra_settings(settings: Settings) -> None:
    config = with_(settings, auth_mode_setting="local", allow_local_auth_setting="false", **ENTRA)
    assert config.auth_mode == "local"
    assert config.allow_local_auth is True
    assert config.oidc is None


def test_local_mode_does_not_validate_a_malformed_issuer_but_entra_mode_does(settings: Settings) -> None:
    assert with_(settings, auth_mode_setting="local", oidc_issuer_url="not a url").oidc is None
    with pytest.raises(ValueError, match="OIDC_ISSUER_URL"):
        _ = with_(settings, oidc_issuer_url="not a url").oidc


def test_an_unknown_auth_mode_is_refused(settings: Settings) -> None:
    with pytest.raises(ValueError, match="AUTH_MODE"):
        _ = with_(settings, auth_mode_setting="keycloak").auth_mode


def test_partial_oidc_settings_leave_sso_off(settings: Settings) -> None:
    assert with_(settings, oidc_issuer_url=ENTRA["oidc_issuer_url"]).oidc is None


def test_managed_identity_client_auth_needs_the_identitys_client_id(settings: Settings) -> None:
    with pytest.raises(ValueError, match="AZURE_CLIENT_ID"):
        _ = with_(settings, oidc_client_auth_setting="managed-identity", **ENTRA).oidc
    config = with_(settings, oidc_client_auth_setting="managed-identity", azure_client_id="mi", **ENTRA).oidc
    assert config is not None
    assert config.managed_identity_client_id == "mi"
    assert with_(settings, azure_client_id="mi", **ENTRA).oidc.managed_identity_client_id is None  # type: ignore[union-attr]


def test_the_login_rate_limit_defaults_to_twenty_in_local_mode_and_off_otherwise(settings: Settings) -> None:
    assert with_(settings, auth_mode_setting="local").login_rate_limit_per_minute == 20
    assert settings.login_rate_limit_per_minute == 0
    assert with_(settings, login_rate_limit_setting="").login_rate_limit_per_minute == 0


def test_the_login_rate_limit_parses_an_explicit_value_including_zero(settings: Settings) -> None:
    assert with_(settings, login_rate_limit_setting="5").login_rate_limit_per_minute == 5
    assert with_(settings, auth_mode_setting="local", login_rate_limit_setting="0").login_rate_limit_per_minute == 0


@pytest.mark.parametrize("bad", ["abc", "-1", "1.5"])
def test_a_non_integer_or_negative_login_rate_limit_is_refused(settings: Settings, bad: str) -> None:
    with pytest.raises(ValueError, match="LOGIN_RATE_LIMIT"):
        _ = with_(settings, login_rate_limit_setting=bad).login_rate_limit_per_minute


def test_mfa_required_defaults_to_true_in_local_mode_and_false_otherwise_and_explicit_values_win(
    settings: Settings,
) -> None:
    assert with_(settings, auth_mode_setting="local").mfa_required is True
    assert settings.mfa_required is False
    assert with_(settings, auth_mode_setting="local", mfa_required_setting="false").mfa_required is False
    assert with_(settings, mfa_required_setting="true").mfa_required is True


def test_uses_mfa_encryption_key_when_given(settings: Settings) -> None:
    assert with_(settings, mfa_encryption_key_setting=KEY).mfa_encryption_key == bytes([7]) * 32


def test_a_key_that_is_not_32_bytes_is_refused(settings: Settings) -> None:
    short = base64.b64encode(bytes(16)).decode()
    with pytest.raises(ValueError, match="MFA_ENCRYPTION_KEY"):
        _ = with_(settings, mfa_encryption_key_setting=short).mfa_encryption_key
    with pytest.raises(ValueError, match="MFA_ENCRYPTION_KEY"):
        _ = with_(settings, mfa_encryption_key_setting="not base64!").mfa_encryption_key


def test_production_local_mode_requires_the_key_but_entra_production_does_not(settings: Settings) -> None:
    production = with_(settings, node_env="production")
    with pytest.raises(ValueError, match="MFA_ENCRYPTION_KEY is required"):
        _ = with_(production, auth_mode_setting="local").mfa_encryption_key
    assert len(with_(production, auth_mode_setting="local", mfa_encryption_key_setting=KEY).mfa_encryption_key) == 32
    assert len(with_(production, allow_local_auth_setting="true").mfa_encryption_key) == 32


def test_derives_a_stable_32_byte_key_outside_production(settings: Settings) -> None:
    local = with_(settings, auth_mode_setting="local")
    assert len(local.mfa_encryption_key) == 32
    assert local.mfa_encryption_key == with_(settings, auth_mode_setting="local").mfa_encryption_key
    assert local.mfa_encryption_key == hashlib.sha256(f"canvas-mfa-key:{TEST_SESSION_SECRET}".encode()).digest()


def test_bad_sign_in_settings_stop_the_app_at_startup_not_at_first_use(settings: Settings, engine: Engine) -> None:
    for changes in (
        {"auth_mode_setting": "keycloak"},
        {"oidc_issuer_url": "https://login.microsoftonline.com/common/v2.0"},
        {"login_rate_limit_setting": "lots"},
        {"mfa_encryption_key_setting": "AAAA"},
    ):
        with pytest.raises(ValueError):
            create_app(with_(settings, **changes), engine)
