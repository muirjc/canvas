"""Settings, read from the same environment variables as the TypeScript service (apps/api/src/config.ts)."""

from __future__ import annotations

from typing import Literal

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
