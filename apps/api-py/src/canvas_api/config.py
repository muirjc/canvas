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
