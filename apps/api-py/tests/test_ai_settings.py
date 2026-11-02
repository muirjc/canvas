"""The AI settings (feature 004 Foundational, canvas-wuc): the cases of apps/api/tests/contract/ai-settings.test.ts
and apps/api/tests/unit/ai-settings.test.ts (the provider kind from AI_PROVIDER).
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from canvas_api.ai.settings import provider_kind
from canvas_api.config import Settings
from tests.api import Api, User


@pytest.fixture()
def users(api: Api, ai_env: Callable[..., Settings]) -> tuple[User, User]:
    return api.user("admin@example.com", "admin"), api.user("architect@example.com")


def test_defaults_to_chat_enabled_false(api: Api, users: tuple[User, User]) -> None:
    admin, _ = users
    response = api.call("GET", "/admin/ai-settings", admin)
    assert response.status_code == 200
    assert response.json()["chatEnabled"] is False
    # `provider` comes from AI_PROVIDER, which the test app leaves unset: the "misconfigured" fallback.
    assert response.json()["provider"] == "unconfigured"


def test_rejects_a_non_admin_from_reading_or_changing_the_setting(api: Api, users: tuple[User, User]) -> None:
    _, architect = users
    assert api.call("GET", "/admin/ai-settings", architect).status_code == 403
    assert api.call("PATCH", "/admin/ai-settings", architect, json={"chatEnabled": True}).status_code == 403


def test_lets_an_admin_enable_and_disable_ai_chat_visible_on_the_next_request(
    api: Api, users: tuple[User, User]
) -> None:
    admin, _ = users
    enabled = api.call("PATCH", "/admin/ai-settings", admin, json={"chatEnabled": True})
    assert enabled.status_code == 200
    assert enabled.json()["chatEnabled"] is True
    assert api.call("GET", "/admin/ai-settings", admin).json()["chatEnabled"] is True
    disabled = api.call("PATCH", "/admin/ai-settings", admin, json={"chatEnabled": False})
    assert disabled.json()["chatEnabled"] is False


# --- GET /ai-settings (any authenticated user) --------------------------------------------------------


def test_get_ai_settings_succeeds_for_a_plain_user_returning_chat_enabled_and_provider(
    api: Api, users: tuple[User, User]
) -> None:
    _, architect = users
    response = api.call("GET", "/ai-settings", architect)
    assert response.status_code == 200
    assert response.json() == {
        "chatEnabled": False,
        "showUsageToUsers": True,
        "provider": "unconfigured",
        "modelId": None,
        "defaultModelId": None,
        "effectiveModelId": None,
    }


def test_get_ai_settings_requires_authentication(api: Api) -> None:
    assert api.call("GET", "/ai-settings").status_code == 401


# --- the provider kind (unit) -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "kind"),
    [
        ("mock", "mock"),
        ("anthropic", "anthropic"),
        ("openai", "openai"),
        (None, "unconfigured"),
        ("not-a-real-provider", "unconfigured"),
    ],
    ids=["mock", "anthropic", "openai", "unset", "unrecognized"],
)
def test_provider_kind_resolves_ai_provider(settings: Settings, provider: str | None, kind: str) -> None:
    assert provider_kind(settings.model_copy(update={"ai_provider": provider})) == kind
