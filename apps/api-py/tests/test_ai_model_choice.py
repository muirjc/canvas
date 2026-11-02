"""The admin chooses the AI model from the provider's available models (canvas-tj1): the cases of
apps/api/tests/contract/ai-model-choice.test.ts. The provider's HTTP API is a mock transport behind the
Anthropic client the app is given (`app.state.anthropic_client`).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import anthropic
import httpx2
import pytest
from sqlalchemy import text

from canvas_api.ai import chat as chat_module
from canvas_api.ai.anthropic_model import AnthropicModel
from canvas_api.ai.model_list import clear_cache
from canvas_api.config import Settings
from tests.ai_helpers import chat_world, persona, usage_rows
from tests.api import Api, User

KEY = "sk-ant-SECRETKEY123456"  # gitleaks:allow (made up)
MODEL_LIST = {
    "data": [
        {"id": "claude-a", "display_name": "Claude A", "created_at": "2026-01-01T00:00:00Z", "type": "model"},
        {"id": "claude-b", "display_name": "Claude B", "created_at": "2025-01-01T00:00:00Z", "type": "model"},
    ],
    "has_more": False,
    "first_id": "claude-a",
    "last_id": "claude-b",
}


class Provider:
    """What the Anthropic client's transport answers (swapped per test), and the requests it saw."""

    def __init__(self) -> None:
        self.handler: Callable[[httpx2.Request], httpx2.Response] = lambda _r: httpx2.Response(200, json=MODEL_LIST)
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.handler(request)

    def fail(self, status: int) -> None:
        self.handler = lambda _r: httpx2.Response(status, json={})

    def unreachable(self) -> None:
        def handler(_r: httpx2.Request) -> httpx2.Response:
            raise httpx2.ConnectError("ECONNREFUSED")

        self.handler = handler


class Env:
    def __init__(
        self, api: Api, admin: User, architect: User, provider: Provider, use: Callable[..., Settings]
    ) -> None:
        self.api, self.admin, self.architect, self.provider, self.use = api, admin, architect, provider, use

    def patch(self, body: Any, who: User | None = None) -> Any:
        return self.api.call("PATCH", "/admin/ai-settings", who or self.admin, json=body)

    def get(self, url: str, who: User | None = None) -> Any:
        return self.api.call("GET", url, who)

    def audits(self) -> list[dict[str, Any]]:
        with self.api.engine.connect() as conn:
            rows = conn.execute(
                text("SELECT actor_user_id, detail FROM audit_events WHERE event = 'ai_model_set' ORDER BY occurred_at")
            ).all()
        # `detail` is JSON: an object on Postgres, text on SQLite.
        return [
            {"actor": str(r.actor_user_id), "detail": json.loads(r.detail) if isinstance(r.detail, str) else r.detail}
            for r in rows
        ]

    def stored_model(self) -> Any:
        return self.api.scalar("SELECT model_id FROM ai_settings")


@pytest.fixture()
def env(api: Api, ai_env: Callable[..., Settings]) -> Env:
    provider = Provider()
    api.client.app.state.anthropic_client = anthropic.Anthropic(  # type: ignore[attr-defined]
        api_key=KEY, http_client=httpx2.Client(transport=httpx2.MockTransport(provider)), max_retries=0
    )
    ai_env(ai_provider="anthropic", anthropic_api_key=KEY)
    return Env(api, api.user("admin@example.com", "admin"), api.user("architect@example.com"), provider, ai_env)


# --- GET /admin/ai-models -----------------------------------------------------------------------------


def test_models_is_admin_only(env: Env) -> None:
    assert env.get("/admin/ai-models", None).status_code == 401
    assert env.get("/admin/ai-models", env.architect).status_code == 403


def test_lists_the_provider_models_with_the_current_and_default_choice(env: Env) -> None:
    res = env.get("/admin/ai-models", env.admin)
    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "anthropic"
    assert [m["id"] for m in body["models"]] == ["claude-a", "claude-b"]
    assert body["modelId"] is None
    assert body["defaultModelId"] == "claude-sonnet-5"
    assert "error" not in body


def test_answers_200_with_an_error_and_no_models_when_listing_fails(env: Env) -> None:
    env.provider.fail(500)
    res = env.get("/admin/ai-models", env.admin)
    assert res.status_code == 200
    assert res.json()["models"] == []
    assert isinstance(res.json()["error"], str)
    assert "SECRETKEY" not in res.text


def test_answers_200_with_an_error_when_the_provider_is_unreachable(env: Env) -> None:
    env.provider.unreachable()
    res = env.get("/admin/ai-models", env.admin)
    assert res.status_code == 200
    assert res.json()["models"] == []
    assert isinstance(res.json()["error"], str)


def test_answers_200_with_an_error_when_no_provider_is_configured(env: Env) -> None:
    env.use()
    res = env.get("/admin/ai-models", env.admin)
    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "unconfigured"
    assert body["models"] == []
    assert isinstance(body["error"], str)


# --- PATCH /admin/ai-settings modelId -----------------------------------------------------------------


def test_saves_an_offered_model_visible_in_both_settings_endpoints(env: Env) -> None:
    res = env.patch({"modelId": "claude-b"})
    assert res.status_code == 200
    body = res.json()
    assert (body["modelId"], body["effectiveModelId"], body["defaultModelId"]) == (
        "claude-b",
        "claude-b",
        "claude-sonnet-5",
    )
    assert env.stored_model() == "claude-b"
    for url, who in (("/admin/ai-settings", env.admin), ("/ai-settings", env.architect)):
        got = env.get(url, who).json()
        assert (got["modelId"], got["effectiveModelId"]) == ("claude-b", "claude-b")


def test_works_with_only_model_id(env: Env) -> None:
    env.patch({"chatEnabled": True})
    res = env.patch({"modelId": "claude-a"})
    assert res.status_code == 200
    assert (res.json()["chatEnabled"], res.json()["modelId"]) == (True, "claude-a")


def test_leaves_the_stored_model_alone_when_only_chat_enabled_is_patched(env: Env) -> None:
    env.patch({"modelId": "claude-a"})
    res = env.patch({"chatEnabled": True})
    assert (res.json()["chatEnabled"], res.json()["modelId"]) == (True, "claude-a")
    assert env.stored_model() == "claude-a"


def test_rejects_a_model_the_provider_does_not_offer_and_changes_nothing(env: Env) -> None:
    env.patch({"modelId": "claude-a"})
    res = env.patch({"modelId": "claude-typo"})
    assert res.status_code == 400
    assert "claude-typo" in res.json()["error"]
    assert env.stored_model() == "claude-a"
    assert len(env.audits()) == 1


def test_answers_502_and_changes_nothing_when_the_model_list_cannot_be_fetched(env: Env) -> None:
    env.patch({"modelId": "claude-a"})
    clear_cache()
    env.provider.unreachable()
    res = env.patch({"modelId": "claude-b"})
    assert res.status_code == 502
    assert env.stored_model() == "claude-a"
    assert len(env.audits()) == 1


def test_null_returns_to_the_default_without_consulting_the_provider(env: Env) -> None:
    env.patch({"modelId": "claude-a"})
    env.provider.requests.clear()
    env.provider.unreachable()
    res = env.patch({"modelId": None})
    assert res.status_code == 200
    assert res.json()["modelId"] is None
    assert res.json()["effectiveModelId"] == "claude-sonnet-5"
    assert env.stored_model() is None
    assert env.provider.requests == []


@pytest.mark.parametrize("model_id", [123, "", "x" * 201, True], ids=["number", "empty", "too long", "boolean"])
def test_rejects_an_invalid_model_id(env: Env, model_id: Any) -> None:
    assert env.patch({"modelId": model_id}).status_code == 400
    assert env.stored_model() is None


def test_rejects_an_empty_body(env: Env) -> None:
    assert env.patch({}).status_code == 400


def test_model_choice_is_admin_only(env: Env) -> None:
    assert env.patch({"modelId": "claude-a"}, env.architect).status_code == 403
    assert env.stored_model() is None


def test_uses_ai_model_as_the_default_when_set(env: Env) -> None:
    env.use(ai_provider="anthropic", anthropic_api_key=KEY, ai_model="claude-b")
    body = env.get("/admin/ai-settings", env.admin).json()
    assert (body["modelId"], body["defaultModelId"], body["effectiveModelId"]) == (None, "claude-b", "claude-b")


# --- audit ai_model_set -------------------------------------------------------------------------------


def test_audit_is_recorded_once_with_from_to_chosen_and_the_actor_when_the_choice_changes(env: Env) -> None:
    env.patch({"modelId": "claude-b"})
    [row] = env.audits()
    assert row["actor"] == env.admin.id
    assert row["detail"] == {"provider": "anthropic", "from": "claude-sonnet-5", "to": "claude-b", "chosen": "claude-b"}


def test_audit_records_the_move_back_to_the_default(env: Env) -> None:
    env.patch({"modelId": "claude-b"})
    env.patch({"modelId": None})
    details = [r["detail"] for r in env.audits()]
    assert len(details) == 2
    assert {"provider": "anthropic", "from": "claude-b", "to": "claude-sonnet-5", "chosen": None} in details


def test_audit_is_not_recorded_when_the_choice_is_unchanged(env: Env) -> None:
    env.patch({"modelId": "claude-b"})
    env.patch({"modelId": "claude-b"})
    env.patch({"modelId": None})
    env.patch({"modelId": None})
    assert len(env.audits()) == 2


def test_audit_is_not_recorded_when_only_other_settings_change(env: Env) -> None:
    env.patch({"chatEnabled": True})
    env.patch({"showUsageToUsers": False})
    assert env.audits() == []


# --- mock provider ------------------------------------------------------------------------------------


def test_mock_provider_ignores_a_stored_model_and_offers_just_the_mock(env: Env) -> None:
    env.patch({"modelId": "claude-a"})
    env.use(ai_provider="mock")
    settings = env.get("/admin/ai-settings", env.admin).json()
    assert settings["provider"] == "mock"
    assert settings["modelId"] is None
    assert (settings["defaultModelId"], settings["effectiveModelId"]) == ("mock", "mock")
    models = env.get("/admin/ai-models", env.admin).json()
    assert [m["id"] for m in models["models"]] == ["mock"]


def test_mock_provider_accepts_only_the_mock_model(env: Env) -> None:
    env.use(ai_provider="mock")
    assert env.patch({"modelId": "claude-a"}).status_code == 400


# --- chat uses the chosen model -----------------------------------------------------------------------


@pytest.fixture()
def real_chat(env: Env, needs_bridge: str, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, list[str]]:
    """Chat with no injected model: it builds Anthropic's from the admin's choice. The Anthropic API is a mock
    transport; nothing leaves the process. Returns the world and the model ids the API was asked for."""
    requested: list[str] = []

    def messages(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/v1/messages", f"unexpected call to {request.url}"
        model = json.loads(request.content)["model"]
        requested.append(model)
        return httpx2.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [{"type": "text", "text": "ok"}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )

    def anthropic_model(api_key: str, model_id: str) -> AnthropicModel:
        http = httpx2.Client(transport=httpx2.MockTransport(messages))
        return AnthropicModel(api_key, model_id, anthropic.Anthropic(api_key=api_key, http_client=http, max_retries=0))

    monkeypatch.setattr(chat_module, "AnthropicModel", anthropic_model)
    world = chat_world(env.api, admin=env.admin, architect=env.architect)
    return world, requested


def send(world: Any) -> Any:
    return world.chat("hello", personaId=persona(world.api, "P", prompt="You help."))


def test_chat_sends_the_chosen_model_id_to_the_provider_and_records_it_as_usage(real_chat: Any) -> None:
    world, requested = real_chat
    world.api.execute("UPDATE ai_settings SET model_id = :m", m="claude-chosen")
    assert send(world).status_code == 200
    assert requested == ["claude-chosen"]
    assert [r["model_id"] for r in usage_rows(world.api)] == ["claude-chosen"]


def test_chat_falls_back_to_the_default_model_when_none_is_chosen(real_chat: Any) -> None:
    world, requested = real_chat
    assert send(world).status_code == 200
    assert requested == ["claude-sonnet-5"]
