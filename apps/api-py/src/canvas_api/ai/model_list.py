"""The models the configured AI provider offers, for the admin's model choice
(apps/api/src/ai/ai-models.service.ts). Cached for ten minutes per provider and key."""

from __future__ import annotations

import re
import threading
import time
from datetime import UTC, datetime
from typing import Any

import anthropic
import openai

from canvas_api.config import Settings
from canvas_api.timestamps import js_iso

CACHE_SECONDS = 10 * 60
TIMEOUT_SECONDS = 10.0
_OPENAI_CHAT = re.compile(r"^(gpt-|o\d|chatgpt-)")
_OPENAI_NOT_CHAT = re.compile(
    r"(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|computer-use|dall-e|whisper)"
)


class AiModelListError(Exception):
    pass


_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_lock = threading.Lock()


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _iso(value: datetime) -> str:
    """The API's created_at as it sent it (UTC, seconds)."""
    utc = value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%SZ")


def _list_anthropic(api_key: str, client: anthropic.Anthropic | None) -> list[dict[str, Any]]:
    client = client or anthropic.Anthropic(api_key=api_key, timeout=TIMEOUT_SECONDS, max_retries=0)
    try:
        return [
            {"id": m.id, "name": m.display_name or m.id, "createdAt": _iso(m.created_at) if m.created_at else None}
            for m in client.models.list(limit=1000)
        ]
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as error:
        raise AiModelListError("The AI provider rejected the API key while listing models.") from error
    except anthropic.APIStatusError as error:
        raise AiModelListError(f"The AI provider returned {error.status_code} while listing models.") from error
    except anthropic.APIConnectionError as error:
        raise AiModelListError("The AI provider could not be reached to list its models.") from error


def _list_openai(api_key: str, client: openai.OpenAI | None) -> list[dict[str, Any]]:
    client = client or openai.OpenAI(api_key=api_key, timeout=TIMEOUT_SECONDS, max_retries=0)
    try:
        models = list(client.models.list())
    except (openai.AuthenticationError, openai.PermissionDeniedError) as error:
        raise AiModelListError("The AI provider rejected the API key while listing models.") from error
    except openai.APIStatusError as error:
        raise AiModelListError(f"The AI provider returned {error.status_code} while listing models.") from error
    except openai.APIConnectionError as error:
        raise AiModelListError("The AI provider could not be reached to list its models.") from error
    return [
        {
            "id": m.id,
            "name": m.id,
            "createdAt": js_iso(datetime.fromtimestamp(m.created, UTC)) if m.created else None,
        }
        for m in models
        if _OPENAI_CHAT.search(m.id) and not _OPENAI_NOT_CHAT.search(m.id)
    ]


def list_ai_models(
    settings: Settings,
    *,
    anthropic_client: anthropic.Anthropic | None = None,
    openai_client: openai.OpenAI | None = None,
) -> list[dict[str, Any]]:
    """The provider's models, newest first. Clients can be passed in by tests."""
    provider = settings.ai_provider
    if provider == "mock":
        return [{"id": "mock", "name": "Mock (rule-based, no AI provider)", "createdAt": None}]
    api_key = (
        settings.anthropic_api_key
        if provider == "anthropic"
        else settings.openai_api_key
        if provider == "openai"
        else None
    )
    if not api_key or api_key == "unset":
        raise AiModelListError("No AI provider is configured (AI_PROVIDER and its API key).")
    key = f"{provider}:{api_key[-6:]}"
    with _lock:
        cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]
    models = (
        _list_anthropic(api_key, anthropic_client) if provider == "anthropic" else _list_openai(api_key, openai_client)
    )
    # Newest first, then by id (both as the TypeScript service sorts them).
    models.sort(key=lambda m: m["id"])
    models.sort(key=lambda m: m["createdAt"] or "", reverse=True)
    with _lock:
        _cache[key] = (time.monotonic(), models)
    return models
