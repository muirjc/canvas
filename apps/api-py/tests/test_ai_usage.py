"""AI token usage (canvas-9af): the cases of apps/api/tests/contract/ai-usage.test.ts -- one row recorded per
chat turn, and the admin reports (per user, per user by day and by model).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import pytest

from canvas_api.ai.mock_model import MockModel
from canvas_api.ai.models import Message
from tests.ai_helpers import (
    ScriptedModel,
    World,
    chat_world,
    enable_chat,
    insert_usage,
    persona,
    text_step,
    tolerant_api,
    tool_step,
    usage_rows,
)
from tests.api import Api, User


def iso(value: str) -> str:
    return quote(datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%Y-%m-%dT%H:%M:%S.000Z"))


def at(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@pytest.fixture()
def w(api: Api, scripted: ScriptedModel, needs_bridge: str) -> World:
    return chat_world(api)


def chat(w: World, message: str = "hello", who: User | None = None, **extra: Any) -> Any:
    return w.api.call(
        "POST",
        f"/diagrams/{w.diagram_id}/chat/messages",
        who or w.architect,
        json={"message": message, "currentDslContent": "flowchart TD\n", "personaId": persona(w.api), **extra},
    )


def failing_chat(w: World, message: str) -> int:
    api = tolerant_api(w.api)
    api.client.cookies.set("cid", w.architect.cookie)
    return api.client.post(
        f"/diagrams/{w.diagram_id}/chat/messages", json={"message": message, "currentDslContent": "flowchart TD\n"}
    ).status_code


# --- recording a chat turn ----------------------------------------------------------------------------


def test_records_one_row_for_the_signed_in_user_with_the_reported_numbers(w: World, scripted: ScriptedModel) -> None:
    scripted.reply(text_step("hi", 120, 30))
    assert chat(w).status_code == 200
    [row] = usage_rows(w.api)
    assert str(row["user_id"]) == w.architect.id
    assert str(row["diagram_id"]) == w.diagram_id
    assert (row["provider"], row["model_id"], row["mode"], row["steps"]) == ("test-provider", "test-model", "build", 1)
    assert (row["input_tokens"], row["output_tokens"]) == (120, 30)
    assert (row["cache_read_tokens"], row["cache_write_tokens"]) == (0, 0)


def test_sums_every_step_of_a_tool_turn_into_one_row(w: World, scripted: ScriptedModel) -> None:
    scripted.script(tool_step(input=100, output=20), text_step("done", 150, 10))
    assert chat(w, "add a start node").status_code == 200
    assert len(scripted.calls) == 2
    [row] = usage_rows(w.api)
    assert (row["steps"], row["input_tokens"], row["output_tokens"]) == (2, 250, 30)
    assert row["succeeded"]


def test_sums_cache_read_and_write_tokens(w: World, scripted: ScriptedModel) -> None:
    scripted.script(
        tool_step(input=100, output=20, cache_read=40, cache_write=7),
        text_step("done", 150, 10, cache_read=60, cache_write=3),
    )
    chat(w, "add a start node")
    [row] = usage_rows(w.api)
    assert (row["cache_read_tokens"], row["cache_write_tokens"], row["input_tokens"]) == (100, 10, 250)


def test_a_failure_after_the_first_step_records_the_partial_usage_as_failed_and_the_request_errors(
    w: World, scripted: ScriptedModel
) -> None:
    scripted.script(tool_step(input=100, output=20), RuntimeError("provider exploded"))
    assert failing_chat(w, "add a start node") >= 500
    [row] = usage_rows(w.api)
    assert (row["steps"], row["input_tokens"], row["output_tokens"], str(row["user_id"])) == (
        1,
        100,
        20,
        w.architect.id,
    )
    summary = w.api.call("GET", "/admin/ai-usage", w.admin).json()
    assert summary["totals"]["requests"] == 1
    assert summary["totals"]["failedRequests"] == 1


def test_a_failure_on_the_first_step_records_nothing(w: World, scripted: ScriptedModel) -> None:
    scripted.script(RuntimeError("provider down"))
    assert failing_chat(w, "hello") >= 500
    assert usage_rows(w.api) == []


def test_plan_mode_records_mode_plan(w: World, scripted: ScriptedModel) -> None:
    scripted.reply(text_step("a plan", 5, 5))
    assert chat(w, "plan it", mode="plan").status_code == 200
    assert usage_rows(w.api)[0]["mode"] == "plan"


def test_a_disabled_chat_records_nothing(w: World) -> None:
    enable_chat(w.api, False)
    assert chat(w).status_code == 503
    assert usage_rows(w.api) == []


def test_each_turn_is_its_own_row(w: World) -> None:
    chat(w, "one")
    chat(w, "two")
    assert len(usage_rows(w.api)) == 2


# --- the mock language model --------------------------------------------------------------------------


def test_mock_model_reports_non_zero_deterministic_usage() -> None:
    def call() -> Any:
        return MockModel().generate("", [Message(role="user", text="add a node called Start")], []).usage

    a = call()
    b = call()
    assert a.input_tokens > 0
    assert a.output_tokens > 0
    assert b == a


# --- GET /admin/ai-usage ------------------------------------------------------------------------------


@pytest.fixture()
def bob(w: World) -> User:
    return w.api.user("bob@example.com", "viewer")


def get(w: World, url: str, who: User | None = None) -> Any:
    return w.api.call("GET", url, who)


def test_totals_and_per_user_sums_sorted_by_total_tokens_with_last_used_at(w: World, bob: User) -> None:
    insert_usage(w.api, w.architect, at("2026-03-10T10:00:00Z"), input=100, output=50)
    insert_usage(w.api, w.architect, at("2026-03-12T10:00:00Z"), input=200, output=20, ok=False, cache_read=5)
    insert_usage(w.api, bob, at("2026-03-11T10:00:00Z"), input=1000, output=500)
    res = get(w, f"/admin/ai-usage?from={iso('2026-03-01T00:00:00Z')}&to={iso('2026-04-01T00:00:00Z')}", w.admin)
    assert res.status_code == 200
    body = res.json()
    assert [u["email"] for u in body["users"]] == ["bob@example.com", "architect@example.com"]
    first, second = body["users"]
    assert first["userId"] == bob.id
    assert (first["requests"], first["failedRequests"], first["inputTokens"], first["outputTokens"]) == (
        1,
        0,
        1000,
        500,
    )
    assert first["totalTokens"] == 1500
    assert first["lastUsedAt"] == "2026-03-11T10:00:00.000Z"
    assert second["userId"] == w.architect.id
    assert (second["requests"], second["failedRequests"], second["inputTokens"], second["outputTokens"]) == (
        2,
        1,
        300,
        70,
    )
    assert (second["cacheReadTokens"], second["totalTokens"]) == (5, 370)
    assert second["lastUsedAt"] == "2026-03-12T10:00:00.000Z"
    totals = body["totals"]
    assert (totals["requests"], totals["failedRequests"], totals["inputTokens"], totals["outputTokens"]) == (
        3,
        1,
        1300,
        570,
    )
    assert totals["totalTokens"] == 1870
    assert body["from"] == "2026-03-01T00:00:00.000Z"
    assert body["to"] == "2026-04-01T00:00:00.000Z"


def test_from_is_inclusive_and_to_is_exclusive(w: World) -> None:
    insert_usage(w.api, w.architect, at("2026-03-01T00:00:00.000Z"), input=1, output=0)  # exactly from
    insert_usage(w.api, w.architect, at("2026-03-02T00:00:00.000Z"), input=10, output=0)  # exactly to
    insert_usage(w.api, w.architect, at("2026-02-28T23:59:59.999Z"), input=100, output=0)  # just before
    res = get(w, f"/admin/ai-usage?from={iso('2026-03-01T00:00:00Z')}&to={iso('2026-03-02T00:00:00Z')}", w.admin)
    totals = res.json()["totals"]
    assert (totals["requests"], totals["inputTokens"]) == (1, 1)


def test_defaults_to_the_last_30_days(w: World) -> None:
    now = datetime.now(UTC)
    insert_usage(w.api, w.architect, now - timedelta(days=2), input=7, output=0)
    insert_usage(w.api, w.architect, now - timedelta(days=40), input=1000, output=0)
    body = get(w, "/admin/ai-usage", w.admin).json()
    assert (body["totals"]["requests"], body["totals"]["inputTokens"]) == (1, 7)
    span = at(body["to"]) - at(body["from"])
    assert span == timedelta(days=30)


def test_includes_usage_whose_user_is_gone_or_unknown_without_a_name(w: World) -> None:
    insert_usage(w.api, None, datetime.now(UTC) - timedelta(seconds=1), input=3, output=0)
    user = get(w, "/admin/ai-usage", w.admin).json()["users"][0]
    assert user["userId"] is None
    assert user["email"] is None
    assert user["inputTokens"] == 3


def test_is_empty_with_zero_totals_when_nothing_was_used(w: World) -> None:
    body = get(w, "/admin/ai-usage", w.admin).json()
    assert body["users"] == []
    assert body["totals"]["requests"] == 0
    assert body["totals"]["totalTokens"] == 0


def test_400_when_from_is_not_before_to(w: World) -> None:
    later, earlier = iso("2026-03-02T00:00:00Z"), iso("2026-03-01T00:00:00Z")
    assert get(w, f"/admin/ai-usage?from={later}&to={earlier}", w.admin).status_code == 400
    assert get(w, f"/admin/ai-usage?from={later}&to={later}", w.admin).status_code == 400
    assert get(w, "/admin/ai-usage?from=not-a-date", w.admin).status_code == 400


def test_403_for_non_admins_and_401_unauthenticated(w: World) -> None:
    for url in ("/admin/ai-usage", f"/admin/ai-usage/users/{w.architect.id}"):
        assert get(w, url, w.architect).status_code == 403
        assert get(w, url).status_code == 401


def test_a_real_chat_turn_shows_up_in_the_report_for_that_user(w: World, scripted: ScriptedModel) -> None:
    scripted.reply(text_step("hi", 120, 30))
    chat(w)
    user = get(w, "/admin/ai-usage", w.admin).json()["users"][0]
    assert user["userId"] == w.architect.id
    assert (user["requests"], user["inputTokens"], user["outputTokens"]) == (1, 120, 30)


# --- user detail --------------------------------------------------------------------------------------


def test_user_detail_buckets_by_utc_day(w: World, bob: User) -> None:
    # 23:30 and 00:30 UTC are one local day apart in the Americas and one UTC day apart here.
    insert_usage(w.api, w.architect, at("2026-03-10T23:30:00Z"), input=1, output=0)
    insert_usage(w.api, w.architect, at("2026-03-11T00:30:00Z"), input=10, output=0)
    insert_usage(w.api, w.architect, at("2026-03-11T22:30:00Z"), input=100, output=0, ok=False)
    insert_usage(w.api, bob, at("2026-03-11T01:00:00Z"), input=9999, output=0)
    url = f"/admin/ai-usage/users/{w.architect.id}?from={iso('2026-03-01T00:00:00Z')}&to={iso('2026-04-01T00:00:00Z')}"
    res = get(w, url, w.admin)
    assert res.status_code == 200
    first, second = res.json()["byDay"]
    assert (first["day"], first["requests"], first["inputTokens"]) == ("2026-03-10", 1, 1)
    assert (second["day"], second["requests"], second["failedRequests"]) == ("2026-03-11", 2, 1)
    assert (second["inputTokens"], second["totalTokens"]) == (110, 110)


def test_user_detail_groups_by_provider_and_model_most_tokens_first_respecting_the_period(w: World) -> None:
    insert_usage(
        w.api, w.architect, at("2026-03-10T10:00:00Z"), provider="anthropic", model="claude-a", input=10, output=0
    )
    insert_usage(
        w.api, w.architect, at("2026-03-10T11:00:00Z"), provider="anthropic", model="claude-a", input=20, output=0
    )
    insert_usage(
        w.api, w.architect, at("2026-03-10T12:00:00Z"), provider="openai", model="claude-a", input=500, output=0
    )
    insert_usage(
        w.api, w.architect, at("2026-03-10T13:00:00Z"), provider="anthropic", model="claude-b", input=5, output=0
    )
    insert_usage(
        w.api, w.architect, at("2026-05-10T13:00:00Z"), provider="anthropic", model="claude-b", input=5000, output=0
    )
    url = f"/admin/ai-usage/users/{w.architect.id}?from={iso('2026-03-01T00:00:00Z')}&to={iso('2026-04-01T00:00:00Z')}"
    by_model = get(w, url, w.admin).json()["byModel"]
    assert [(m["provider"], m["modelId"], m["requests"], m["inputTokens"]) for m in by_model] == [
        ("openai", "claude-a", 1, 500),
        ("anthropic", "claude-a", 2, 30),
        ("anthropic", "claude-b", 1, 5),
    ]


def test_user_detail_is_empty_for_a_user_with_no_usage_and_400_for_a_bad_period(w: World, bob: User) -> None:
    body = get(w, f"/admin/ai-usage/users/{bob.id}", w.admin).json()
    assert body["byDay"] == []
    assert body["byModel"] == []
    bad = get(
        w,
        f"/admin/ai-usage/users/{bob.id}?from={iso('2026-03-02T00:00:00Z')}&to={iso('2026-03-01T00:00:00Z')}",
        w.admin,
    )
    assert bad.status_code == 400
