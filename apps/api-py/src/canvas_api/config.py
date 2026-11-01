"""Settings, read from the same environment variables as the TypeScript service (apps/api/src/config.ts)."""

from __future__ import annotations

import base64
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

    @property
    def canvas_public_url(self) -> str:
        url = self.canvas_public_url_setting or self.web_origins.split(",")[0]
        return url.strip().rstrip("/")

    @property
    def github(self) -> GitHubAppConfig | None:
        """The GitHub App settings, or None when the integration is off. A bad key or URL raises."""
        return parse_github_config(self.github_app_id, self.github_app_private_key, self.github_app_api_url)


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
