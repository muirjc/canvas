"""Listing the provider's models and resolving which one a chat uses (canvas-tj1): the cases of
apps/api/tests/unit/ai-models.test.ts. The provider SDKs' HTTP clients are given mock transports (the
Anthropic SDK 1.x uses httpx2, the OpenAI SDK httpx), so nothing leaves the process.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import anthropic
import httpx
import httpx2
import openai
import pytest

from canvas_api.ai import model_list
from canvas_api.ai.chat import language_model_for
from canvas_api.ai.model_list import AiModelListError, clear_cache, list_ai_models
from canvas_api.ai.models import default_model_id
from canvas_api.config import Settings

KEY = "sk-test-SECRETKEY123456"  # gitleaks:allow (made up)


@pytest.fixture(autouse=True)
def _fresh_cache() -> Any:
    clear_cache()
    yield
    clear_cache()


@pytest.fixture()
def cfg(settings: Settings) -> Callable[..., Settings]:
    blank = {"ai_provider": None, "ai_model": None, "anthropic_api_key": None, "openai_api_key": None}
    return lambda **kw: settings.model_copy(update={**blank, **kw})


class Recorder:
    """A mock transport handler that answers from a queue (the last answer repeats) and keeps the requests."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.requests: list[Any] = []

    def __call__(self, request: Any) -> Any:
        self.requests.append(request)
        answer = self.answers[min(len(self.requests), len(self.answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer


def anthropic_client(handler: Recorder) -> anthropic.Anthropic:
    http = httpx2.Client(transport=httpx2.MockTransport(handler))
    return anthropic.Anthropic(api_key=KEY, http_client=http, max_retries=0)


def openai_client(handler: Recorder) -> openai.OpenAI:
    return openai.OpenAI(api_key=KEY, http_client=httpx.Client(transport=httpx.MockTransport(handler)), max_retries=0)


def a_json(body: Any, status: int = 200) -> httpx2.Response:
    return httpx2.Response(status, json=body)


def o_json(body: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=body)


def test_mock_provider_returns_the_single_mock_model_without_a_client(cfg: Callable[..., Settings]) -> None:
    models = list_ai_models(cfg(ai_provider="mock"))
    assert [m["id"] for m in models] == ["mock"]


def test_anthropic_pages_sends_auth_headers_falls_back_to_id_and_sorts_newest_first(
    cfg: Callable[..., Settings],
) -> None:
    handler = Recorder(
        a_json(
            {
                "data": [
                    {"id": "old", "display_name": "Old One", "created_at": "2024-01-01T00:00:00Z", "type": "model"},
                    {"id": "no-name", "created_at": "2025-01-01T00:00:00Z", "type": "model"},
                ],
                "has_more": True,
                "first_id": "old",
                "last_id": "no-name",
            }
        ),
        a_json(
            {
                "data": [
                    {"id": "newest", "display_name": "Newest", "created_at": "2026-01-01T00:00:00Z", "type": "model"}
                ],
                "has_more": False,
                "first_id": "newest",
                "last_id": "newest",
            }
        ),
    )
    models = list_ai_models(
        cfg(ai_provider="anthropic", anthropic_api_key=KEY), anthropic_client=anthropic_client(handler)
    )
    assert [m["id"] for m in models] == ["newest", "no-name", "old"]
    assert next(m for m in models if m["id"] == "no-name")["name"] == "no-name"
    assert next(m for m in models if m["id"] == "old")["name"] == "Old One"
    assert len(handler.requests) == 2
    first, second = handler.requests
    assert first.url.path == "/v1/models"
    assert first.url.params["limit"] == "1000"
    assert first.headers["x-api-key"] == KEY
    assert first.headers["anthropic-version"]
    assert second.url.params["after_id"] == "no-name"


OPENAI_INCLUDED = ["gpt-4o", "gpt-5", "o3", "chatgpt-4o-latest"]
OPENAI_EXCLUDED = [
    "text-embedding-3-small",
    "whisper-1",
    "dall-e-3",
    "gpt-4o-audio-preview",
    "gpt-4o-realtime-preview",
    "gpt-4o-mini-tts",
    "omni-moderation-latest",
    "gpt-4o-search-preview",
]


def test_openai_keeps_chat_models_only_with_a_bearer_token_newest_first(cfg: Callable[..., Settings]) -> None:
    data = [
        {"id": id_, "created": 1_700_000_000 + i * 1000, "object": "model", "owned_by": "x"}
        for i, id_ in enumerate([*OPENAI_INCLUDED, *OPENAI_EXCLUDED])
    ]
    handler = Recorder(o_json({"data": data, "object": "list"}))
    models = list_ai_models(cfg(ai_provider="openai", openai_api_key=KEY), openai_client=openai_client(handler))
    assert sorted(m["id"] for m in models) == sorted(OPENAI_INCLUDED)
    # 'chatgpt-4o-latest' has the largest created among the included.
    assert models[0]["id"] == "chatgpt-4o-latest"
    request = handler.requests[0]
    assert request.url.path == "/v1/models"
    assert request.headers["authorization"] == f"Bearer {KEY}"


@pytest.mark.parametrize(
    "changes",
    [
        {"ai_provider": "anthropic"},
        {"ai_provider": "openai", "openai_api_key": "unset"},
        {},
    ],
    ids=["no key", 'key "unset"', "no provider"],
)
def test_errors_without_a_usable_provider_or_key_without_calling_out(
    cfg: Callable[..., Settings], changes: dict[str, Any]
) -> None:
    handler = Recorder(a_json({}))
    with pytest.raises(AiModelListError):
        list_ai_models(cfg(**changes), anthropic_client=anthropic_client(handler))
    assert handler.requests == []


@pytest.mark.parametrize("status", [401, 403, 500])
def test_errors_on_an_http_error_without_leaking_the_key(cfg: Callable[..., Settings], status: int) -> None:
    handler = Recorder(a_json({"error": f"bad key {KEY}"}, status))
    with pytest.raises(AiModelListError) as raised:
        list_ai_models(cfg(ai_provider="anthropic", anthropic_api_key=KEY), anthropic_client=anthropic_client(handler))
    assert KEY not in str(raised.value)
    assert "SECRETKEY" not in str(raised.value)


def test_distinguishes_a_rejected_key_from_another_status(cfg: Callable[..., Settings]) -> None:
    settings = cfg(ai_provider="anthropic", anthropic_api_key=KEY)
    with pytest.raises(AiModelListError, match="rejected"):
        list_ai_models(settings, anthropic_client=anthropic_client(Recorder(a_json({}, 401))))
    with pytest.raises(AiModelListError, match="500"):
        list_ai_models(settings, anthropic_client=anthropic_client(Recorder(a_json({}, 500))))


def test_errors_on_a_network_error_without_leaking_the_key(cfg: Callable[..., Settings]) -> None:
    handler = Recorder(httpx2.ConnectError(f"connect ECONNREFUSED using {KEY}"))
    with pytest.raises(AiModelListError) as raised:
        list_ai_models(cfg(ai_provider="anthropic", anthropic_api_key=KEY), anthropic_client=anthropic_client(handler))
    assert "SECRETKEY" not in str(raised.value)


def test_openai_errors_the_same_way(cfg: Callable[..., Settings]) -> None:
    settings = cfg(ai_provider="openai", openai_api_key=KEY)
    with pytest.raises(AiModelListError, match="rejected"):
        list_ai_models(settings, openai_client=openai_client(Recorder(o_json({}, 401))))
    with pytest.raises(AiModelListError, match="500"):
        list_ai_models(settings, openai_client=openai_client(Recorder(o_json({}, 500))))
    with pytest.raises(AiModelListError, match="could not be reached"):
        list_ai_models(settings, openai_client=openai_client(Recorder(httpx.ConnectError("down"))))


def test_does_not_cache_a_failure(cfg: Callable[..., Settings]) -> None:
    settings = cfg(ai_provider="anthropic", anthropic_api_key=KEY)
    with pytest.raises(AiModelListError):
        list_ai_models(settings, anthropic_client=anthropic_client(Recorder(a_json({}, 500))))
    ok = Recorder(a_json({"data": [{"id": "m", "type": "model"}], "has_more": False}))
    assert [m["id"] for m in list_ai_models(settings, anthropic_client=anthropic_client(ok))] == ["m"]


def test_serves_a_second_call_within_10_minutes_from_cache_refetches_after_and_for_a_different_key(
    cfg: Callable[..., Settings], monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [1000.0]
    monkeypatch.setattr(model_list.time, "monotonic", lambda: now[0])
    handler = Recorder(a_json({"data": [{"id": "m", "type": "model"}], "has_more": False}))
    client = anthropic_client(handler)
    a = cfg(ai_provider="anthropic", anthropic_api_key="key-aaaaaa111111")
    b = cfg(ai_provider="anthropic", anthropic_api_key="key-bbbbbb222222")
    list_ai_models(a, anthropic_client=client)
    list_ai_models(a, anthropic_client=client)
    assert len(handler.requests) == 1

    list_ai_models(b, anthropic_client=client)
    assert len(handler.requests) == 2

    now[0] += 10 * 60 + 1
    list_ai_models(b, anthropic_client=client)
    assert len(handler.requests) == 3


def test_does_not_share_a_cache_between_providers(cfg: Callable[..., Settings]) -> None:
    a_handler = Recorder(a_json({"data": [{"id": "gpt-4o", "type": "model"}], "has_more": False}))
    o_handler = Recorder(o_json({"data": [{"id": "gpt-4o", "created": 1, "object": "model", "owned_by": "x"}]}))
    list_ai_models(cfg(ai_provider="anthropic", anthropic_api_key=KEY), anthropic_client=anthropic_client(a_handler))
    list_ai_models(cfg(ai_provider="openai", openai_api_key=KEY), openai_client=openai_client(o_handler))
    assert len(a_handler.requests) == 1
    assert len(o_handler.requests) == 1


# --- which model a chat uses --------------------------------------------------------------------------


def test_chosen_wins_over_ai_model_which_wins_over_the_default(cfg: Callable[..., Settings]) -> None:
    anthropic_settings = cfg(ai_provider="anthropic", anthropic_api_key=KEY, ai_model="env-model")
    assert language_model_for(anthropic_settings, "chosen-model").model_id == "chosen-model"
    assert language_model_for(anthropic_settings, None).model_id == "env-model"
    assert language_model_for(cfg(ai_provider="anthropic", anthropic_api_key=KEY), None).model_id == "claude-sonnet-5"


def test_model_choice_applies_to_openai_too(cfg: Callable[..., Settings]) -> None:
    settings = cfg(ai_provider="openai", openai_api_key=KEY)
    assert language_model_for(settings, "gpt-5").model_id == "gpt-5"
    assert language_model_for(settings, None).model_id == "gpt-4o"


def test_default_model_id_is_ai_model_else_the_provider_default_mock_for_mock_none_when_unconfigured() -> None:
    assert default_model_id("anthropic", None) == "claude-sonnet-5"
    assert default_model_id("anthropic", "x") == "x"
    assert default_model_id("openai", None) == "gpt-4o"
    assert default_model_id("openai", "y") == "y"
    assert default_model_id("mock", None) == "mock"
    assert default_model_id(None, None) is None
