"""Settings, read from the same environment variables as the TypeScript service (apps/api/src/config.ts)."""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Everything the service needs from its environment.

    Tests build a Settings directly instead of reading the environment, so an exported DATABASE_URL
    can never point a test run at a real database (the TypeScript service's canvas-uw8 rule).
    """

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    db_client: Literal["postgres", "sqlite"] = Field(default="postgres", alias="DB_CLIENT")
    #: Postgres: a postgres:// URL. SQLite: a file path, or ":memory:".
    database_url: str = Field(alias="DATABASE_URL")
    applicationinsights_connection_string: str | None = Field(
        default=None, alias="APPLICATIONINSIGHTS_CONNECTION_STRING"
    )

    # Sessions are shared with the TypeScript service (canvas-1bty.2): same secret, cookie and limits.
    session_secret: str = Field(alias="SESSION_SECRET", min_length=32)
    session_idle_minutes: float = Field(default=480, alias="SESSION_IDLE_MINUTES", gt=0)
    session_max_hours: float = Field(default=12, alias="SESSION_MAX_HOURS", gt=0)
    cookie_same_site: Literal["lax", "strict", "none"] = Field(default="lax", alias="COOKIE_SAME_SITE")
    cookie_secure_setting: bool = Field(default=False, alias="COOKIE_SECURE")

    @property
    def cookie_secure(self) -> bool:
        """SameSite=None cookies must be Secure (browsers drop them otherwise), as in apps/api."""
        return self.cookie_same_site == "none" or self.cookie_secure_setting

    #: canvas-1bty.4: the diagram-core bridge (packages/diagram-bridge), a sidecar on localhost in Azure.
    diagram_bridge_url: str | None = Field(default=None, alias="DIAGRAM_BRIDGE_URL")

    # canvas-1bty.11: the GitHub App diagrams are submitted for approval with (apps/api's
    # parseGitHubConfig). Both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY needed; "unset" counts as missing.
    github_app_id: str | None = Field(default=None, alias="GITHUB_APP_ID")
    #: The PEM as downloaded from GitHub, or base64 of it (easier to keep in Key Vault).
    github_app_private_key: str | None = Field(default=None, alias="GITHUB_APP_PRIVATE_KEY", repr=False)
    #: Not GITHUB_API_URL: GitHub Actions sets that on every runner and won't let a workflow override it.
    github_app_api_url: str = Field(default="https://api.github.com", alias="GITHUB_APP_API_URL")
    #: The web app's public address, for links back to Canvas (CANVAS_PUBLIC_URL, else the first WEB_ORIGINS).
    canvas_public_url_setting: str | None = Field(default=None, alias="CANVAS_PUBLIC_URL")
    web_origins: str = Field(default="http://localhost:5173", alias="WEB_ORIGINS")
    #: canvas-3s5.3: where the CI validator bundle is (packages/validator-cli/dist); unset = beside the repository.
    canvas_validator_dir: str | None = Field(default=None, alias="CANVAS_VALIDATOR_DIR")

    # canvas-1bty.12: the AI provider (apps/api/src/ai/provider.ts): anthropic, openai or mock (the rule-based
    # stand-in the e2e suite runs against); anything else = AI unconfigured.
    ai_provider: str | None = Field(default=None, alias="AI_PROVIDER")
    #: The model when the admin hasn't chosen one (Admin -> AI Personas); else each provider's default.
    ai_model: str | None = Field(default=None, alias="AI_MODEL")
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY", repr=False)
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY", repr=False)

    # canvas-1bty.13: sign-in (apps/api's loadConfig). Booleans are "true" or not, as there.
    node_env: str | None = Field(default=None, alias="NODE_ENV")
    auth_mode_setting: str = Field(default="entra", alias="AUTH_MODE")
    allow_local_auth_setting: str | None = Field(default=None, alias="ALLOW_LOCAL_AUTH")
    login_rate_limit_setting: str | None = Field(default=None, alias="LOGIN_RATE_LIMIT")
    mfa_required_setting: str | None = Field(default=None, alias="MFA_REQUIRED")
    #: 32 bytes, base64: the AES-256-GCM key for stored authenticator secrets.
    mfa_encryption_key_setting: str | None = Field(default=None, alias="MFA_ENCRYPTION_KEY", repr=False)
    oidc_issuer_url: str | None = Field(default=None, alias="OIDC_ISSUER_URL")
    oidc_client_id: str | None = Field(default=None, alias="OIDC_CLIENT_ID")
    oidc_client_secret: str | None = Field(default=None, alias="OIDC_CLIENT_SECRET", repr=False)
    oidc_redirect_uri: str | None = Field(default=None, alias="OIDC_REDIRECT_URI")
    #: "managed-identity": sign in to Entra with the managed identity's token instead of a client secret.
    oidc_client_auth_setting: str | None = Field(default=None, alias="OIDC_CLIENT_AUTH")
    #: The user-assigned managed identity's client id.
    azure_client_id: str | None = Field(default=None, alias="AZURE_CLIENT_ID")

    @property
    def auth_mode(self) -> Literal["entra", "local"]:
        if self.auth_mode_setting not in ("entra", "local"):
            raise ValueError(f'AUTH_MODE must be "entra" or "local" (got: {self.auth_mode_setting})')
        return "local" if self.auth_mode_setting == "local" else "entra"

    @property
    def allow_local_auth(self) -> bool:
        """Canvas email + password sign-in: always in local mode, opt-in (dev) with Entra."""
        return self.auth_mode == "local" or self.allow_local_auth_setting == "true"

    @property
    def mfa_required(self) -> bool:
        if not self.mfa_required_setting:
            return self.auth_mode == "local"
        return self.mfa_required_setting == "true"

    @property
    def login_rate_limit_per_minute(self) -> int:
        """Password sign-in attempts per client address per minute; 0 = no limit."""
        value = self.login_rate_limit_setting
        if not value:
            return 20 if self.auth_mode == "local" else 0
        if not re.fullmatch(r"[0-9]+", value):
            raise ValueError(f"LOGIN_RATE_LIMIT must be a whole number, 0 or more (got: {value})")
        return int(value)

    @property
    def mfa_encryption_key(self) -> bytes:
        if self.mfa_encryption_key_setting:
            try:
                key = base64.b64decode(self.mfa_encryption_key_setting)
            except ValueError:
                key = b""
            if len(key) != 32:
                raise ValueError(
                    "MFA_ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`)."
                )
            return key
        if self.auth_mode == "local" and self.node_env == "production":
            raise ValueError("MFA_ENCRYPTION_KEY is required with AUTH_MODE=local in production.")
        # Dev/test: derived from the session secret, so nothing extra has to be configured.
        return hashlib.sha256(f"canvas-mfa-key:{self.session_secret}".encode()).digest()

    @property
    def oidc(self) -> OidcConfig | None:
        """Entra sign-in settings, or None when it's off (local mode, or OIDC_* not all set)."""
        if self.auth_mode == "local":
            return None
        validate_oidc_issuer_url(self.oidc_issuer_url)
        if not (self.oidc_issuer_url and self.oidc_client_id and self.oidc_redirect_uri):
            return None
        managed = self.oidc_client_auth_setting == "managed-identity"
        if managed and not self.azure_client_id:
            raise ValueError(
                "OIDC_CLIENT_AUTH=managed-identity needs AZURE_CLIENT_ID (the managed identity's client id)."
            )
        return OidcConfig(
            issuer_url=self.oidc_issuer_url,
            client_id=self.oidc_client_id,
            client_secret=self.oidc_client_secret,
            redirect_uri=self.oidc_redirect_uri,
            managed_identity_client_id=self.azure_client_id if managed else None,
        )

    @property
    def web_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.web_origins.split(",")]

    @property
    def canvas_public_url(self) -> str:
        url = self.canvas_public_url_setting or self.web_origins.split(",")[0]
        return url.strip().rstrip("/")

    @property
    def github(self) -> GitHubAppConfig | None:
        """The GitHub App settings, or None when the integration is off. A bad key or URL raises."""
        return parse_github_config(self.github_app_id, self.github_app_private_key, self.github_app_api_url)


@dataclass(frozen=True)
class OidcConfig:
    issuer_url: str
    client_id: str
    client_secret: str | None = field(repr=False)
    redirect_uri: str
    #: Set: authenticate with this managed identity's token (a federated credential), not the secret.
    managed_identity_client_id: str | None = None


def validate_oidc_issuer_url(issuer_url: str | None) -> None:
    """Catches the two usual Entra issuer mistakes at startup (apps/api's validateOidcIssuerUrl); any
    other identity provider's issuer is left alone."""
    if not issuer_url:
        return
    parts = urlsplit(issuer_url)
    if not parts.scheme or not parts.netloc:
        raise ValueError(f'OIDC_ISSUER_URL is not a valid URL: "{issuer_url}"')
    if parts.hostname != "login.microsoftonline.com":
        return
    segments = [s for s in parts.path.split("/") if s]
    tenant = segments[0] if segments else None
    if tenant in ("common", "organizations", "consumers"):
        raise ValueError(
            f'OIDC_ISSUER_URL uses Entra\'s multi-tenant alias "/{tenant}/..." -- this app needs a real tenant ID'
            " in the issuer path instead: https://login.microsoftonline.com/<tenant-id>/v2.0"
        )
    if not segments or segments[-1] != "v2.0":
        raise ValueError(
            f'OIDC_ISSUER_URL must end in "/v2.0" (got: "{issuer_url}") -- use'
            " https://login.microsoftonline.com/<tenant-id>/v2.0"
        )


@dataclass(frozen=True)
class GitHubAppConfig:
    app_id: str
    private_key: RSAPrivateKey = field(repr=False)
    #: REST API base, e.g. https://api.github.com.
    api_url: str


def parse_github_config(app_id: str | None, raw_key: str | None, api_url: str) -> GitHubAppConfig | None:
    app_id = (app_id or "").strip()
    raw_key = (raw_key or "").strip()
    if not app_id or app_id == "unset" or not raw_key or raw_key == "unset":
        return None
    if not re.fullmatch(r"\d+", app_id):
        raise ValueError(f"GITHUB_APP_ID must be the App's numeric id (got: {app_id})")
    try:
        pem = raw_key.replace("\\n", "\n") if "-----BEGIN" in raw_key else base64.b64decode(raw_key).decode()
        key = serialization.load_pem_private_key(pem.encode(), password=None)
    except (ValueError, TypeError, UnicodeDecodeError) as error:
        raise ValueError("GITHUB_APP_PRIVATE_KEY is not a valid private key (PEM, or base64 of the PEM).") from error
    if not isinstance(key, RSAPrivateKey):
        raise ValueError("GITHUB_APP_PRIVATE_KEY is not a valid private key (PEM, or base64 of the PEM).")
    url = api_url.strip().rstrip("/")
    parts = urlsplit(url)
    local = parts.hostname in ("localhost", "127.0.0.1")
    if parts.scheme != "https" and not local:
        raise ValueError(f"GITHUB_APP_API_URL must use https (got: {url})")
    return GitHubAppConfig(app_id, key, url)
