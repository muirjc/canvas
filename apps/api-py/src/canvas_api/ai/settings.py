"""AI settings (apps/api/src/ai/ai-settings.service.ts): whether chat is on, whether users see token usage,
and the admin's choice of model. One row in ai_settings; the provider itself comes from the environment."""

from __future__ import annotations

from typing import Any

from sqlalchemy import Connection, text

from canvas_api.ai.models import default_model_id
from canvas_api.config import Settings

_GET = text("SELECT chat_enabled, show_usage_to_users, model_id FROM ai_settings")


def provider_kind(settings: Settings) -> str:
    """anthropic | openai | mock | unconfigured."""
    return settings.ai_provider if settings.ai_provider in ("anthropic", "openai", "mock") else "unconfigured"


def get_ai_settings(conn: Connection, settings: Settings) -> dict[str, Any]:
    row = conn.execute(_GET).one()
    provider = provider_kind(settings)
    fallback = default_model_id(settings.ai_provider, settings.ai_model)
    # The mock has one model; a choice made for a real provider doesn't apply to it.
    chosen = None if provider == "mock" else row.model_id
    return {
        "chatEnabled": bool(row.chat_enabled),
        "showUsageToUsers": bool(row.show_usage_to_users),
        "provider": provider,
        "modelId": chosen,
        "defaultModelId": fallback,
        "effectiveModelId": chosen if chosen is not None else fallback,
    }


def set_ai_settings(conn: Connection, changes: dict[str, Any]) -> None:
    """`changes` holds only the fields being set (chatEnabled, showUsageToUsers, modelId: a string or None)."""
    if "chatEnabled" in changes:
        conn.execute(
            text("UPDATE ai_settings SET chat_enabled = :v, updated_at = CURRENT_TIMESTAMP"),
            {"v": bool(changes["chatEnabled"])},
        )
    if "showUsageToUsers" in changes:
        conn.execute(
            text("UPDATE ai_settings SET show_usage_to_users = :v, updated_at = CURRENT_TIMESTAMP"),
            {"v": bool(changes["showUsageToUsers"])},
        )
    if "modelId" in changes:
        conn.execute(
            text("UPDATE ai_settings SET model_id = :v, updated_at = CURRENT_TIMESTAMP"), {"v": changes["modelId"]}
        )


def can_see_usage(conn: Connection, settings: Settings, role: str | None) -> bool:
    """canvas-4k9: admins always; everyone else when the setting allows it."""
    return role == "admin" or bool(get_ai_settings(conn, settings)["showUsageToUsers"])


def chosen_model_id(conn: Connection) -> str | None:
    row = conn.execute(text("SELECT model_id FROM ai_settings")).first()
    return row.model_id if row else None
