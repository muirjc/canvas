"""AI cost and chat usage (canvas-zs0, canvas-4k9): the cases of apps/api/tests/contract/ai-cost-and-chat-usage.test.ts.

Model prices, the estimated cost in the usage reports, token counts in the chat panel and on the account, and
the usage-display setting. The model is scripted (tests/ai_helpers.py) and the chat runs through the bridge.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import pytest

from tests.ai_helpers import (
    ScriptedModel,
    World,
    chat_world,
    insert_usage,
    text_step,
    tolerant_api,
    tool_step,
    usage_rows,
)
from tests.api import Api

PRICE = {
    "provider": "anthropic",
    "modelId": "claude-x",
    "inputPerMillion": 3,
    "outputPerMillion": 15,
    "cacheReadPerMillion": 0.3,
    "cacheWritePerMillion": 3.75,
}
PRICE_QUERY = "?provider=anthropic&modelId=claude-x"


def iso(value: str) -> str:
    return quote(datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%Y-%m-%dT%H:%M:%S.000Z"))


def at(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@pytest.fixture()
def w(api: Api, scripted: ScriptedModel, needs_bridge: str) -> World:
    return chat_world(api)


def put_price(w: World, body: dict[str, Any], who: Any = None) -> Any:
    return w.api.call("PUT", "/admin/ai-prices", who or w.admin, json=body)


def set_show(w: World, show: bool) -> Any:
    return w.api.call("PATCH", "/admin/ai-settings", w.admin, json={"showUsageToUsers": show})


# --- prices -------------------------------------------------------------------------------------------


def test_price_upserts_lists_and_defaults_the_cache_prices_to_0(w: World) -> None:
    created = put_price(w, {"provider": "p", "modelId": "m", "inputPerMillion": 1, "outputPerMillion": 2})
    assert created.status_code == 200
    [price] = created.json()["prices"]
    assert price | {"updatedAt": None} == {
        "provider": "p",
        "modelId": "m",
        "inputPerMillion": 1,
        "outputPerMillion": 2,
        "cacheReadPerMillion": 0,
        "cacheWritePerMillion": 0,
        "updatedAt": None,
    }

    updated = put_price(
        w, {"provider": "p", "modelId": "m", "inputPerMillion": 5, "outputPerMillion": 6, "cacheReadPerMillion": 0.5}
    )
    assert len(updated.json()["prices"]) == 1
    assert updated.json()["prices"][0]["inputPerMillion"] == 5
    assert updated.json()["prices"][0]["outputPerMillion"] == 6
    assert updated.json()["prices"][0]["cacheReadPerMillion"] == 0.5
    assert len(w.api.call("GET", "/admin/ai-prices", w.admin).json()["prices"]) == 1


def test_price_validates_and_strips_unknown_properties(w: World) -> None:
    assert put_price(w, {**PRICE, "inputPerMillion": -1}).status_code == 400
    assert put_price(w, {"provider": "p", "modelId": "m", "inputPerMillion": 1}).status_code == 400
    assert put_price(w, {**PRICE, "provider": ""}).status_code == 400
    assert put_price(w, {**PRICE, "inputPerMillion": "3"}).status_code == 400
    assert w.api.call("GET", "/admin/ai-prices", w.admin).json()["prices"] == []
    # Unknown properties are dropped, not rejected and not stored.
    extra = put_price(w, {**PRICE, "currency": "EUR"})
    assert extra.status_code == 200
    assert "currency" not in extra.json()["prices"][0]


def test_price_delete_removes_one_and_404s_when_there_is_none(w: World) -> None:
    put_price(w, PRICE)
    removed = w.api.call("DELETE", f"/admin/ai-prices{PRICE_QUERY}", w.admin)
    assert removed.status_code == 200
    assert removed.json()["prices"] == []
    assert w.api.call("DELETE", f"/admin/ai-prices{PRICE_QUERY}", w.admin).status_code == 404


def test_prices_are_admin_only(w: World) -> None:
    assert w.api.call("GET", "/admin/ai-prices", w.architect).status_code == 403
    assert put_price(w, PRICE, w.architect).status_code == 403
    assert w.api.call("DELETE", "/admin/ai-prices?provider=a&modelId=b", w.architect).status_code == 403
    assert w.api.call("GET", "/admin/ai-prices").status_code == 401


def test_unpriced_models_lists_models_with_usage_but_no_price_and_drops_one_once_priced(w: World) -> None:
    now = datetime.now(UTC)
    insert_usage(w.api, w.architect, now, provider="anthropic", model="claude-x")
    insert_usage(w.api, w.architect, now, provider="openai", model="gpt-y")
    before = w.api.call("GET", "/admin/ai-prices", w.admin).json()["unpricedModels"]
    assert before == [{"provider": "anthropic", "modelId": "claude-x"}, {"provider": "openai", "modelId": "gpt-y"}]
    put_price(w, PRICE)
    assert w.api.call("GET", "/admin/ai-prices", w.admin).json()["unpricedModels"] == [
        {"provider": "openai", "modelId": "gpt-y"}
    ]


def test_price_set_and_removed_are_audited(w: World) -> None:
    put_price(w, PRICE)
    w.api.call("DELETE", f"/admin/ai-prices{PRICE_QUERY}", w.admin)
    events = w.api.call("GET", "/admin/audit?limit=50", w.admin).json()["events"]
    set_event = next(e for e in events if e["event"] == "ai_price_set")
    removed = next(e for e in events if e["event"] == "ai_price_removed")
    assert set_event["actorEmail"] == "admin@example.com"
    assert set_event["detail"].items() >= {"provider": "anthropic", "modelId": "claude-x", "inputPerMillion": 3}.items()
    assert removed["actorEmail"] == "admin@example.com"
    assert removed["detail"].items() >= {"provider": "anthropic", "modelId": "claude-x"}.items()


# --- estimated cost -----------------------------------------------------------------------------------

FROM = "2026-03-01T00:00:00Z"
TO = "2026-04-01T00:00:00Z"


@pytest.fixture()
def priced(w: World) -> World:
    put_price(w, PRICE)
    # Priced model: 1M input (200k cache read, 100k cache write), 100k output = $4.035.
    insert_usage(
        w.api,
        w.architect,
        at("2026-03-10T10:00:00Z"),
        input=1_000_000,
        output=100_000,
        cache_read=200_000,
        cache_write=100_000,
    )
    # Unpriced model on the same user and day.
    insert_usage(w.api, w.architect, at("2026-03-10T11:00:00Z"), model="mystery", input=500, output=500)
    # A second user with only the priced model: 1M input, no output = $3.
    insert_usage(w.api, w.other, at("2026-03-11T10:00:00Z"), input=1_000_000, output=0)
    return w


def report(w: World) -> Any:
    return w.api.call("GET", f"/admin/ai-usage?from={iso(FROM)}&to={iso(TO)}", w.admin).json()


def test_per_user_and_total_cost_count_only_priced_models(priced: World) -> None:
    body = report(priced)
    arch = next(u for u in body["users"] if u["userId"] == priced.architect.id)
    other = next(u for u in body["users"] if u["userId"] == priced.other.id)
    assert arch["estimatedCost"] == pytest.approx(4.035, abs=1e-6)
    assert arch["unpricedTokens"] == 1000
    assert arch["requests"] == 2
    assert arch["totalTokens"] == 1_100_000 + 1000
    assert other["estimatedCost"] == pytest.approx(3, abs=1e-6)
    assert other["unpricedTokens"] == 0
    assert body["totals"]["estimatedCost"] == pytest.approx(7.035, abs=1e-6)
    assert body["totals"]["unpricedTokens"] == 1000
    assert body["totals"]["requests"] == 3


def test_with_no_prices_at_all_the_cost_is_0_and_every_token_is_unpriced(priced: World) -> None:
    priced.api.call("DELETE", f"/admin/ai-prices{PRICE_QUERY}", priced.admin)
    body = report(priced)
    assert body["totals"]["estimatedCost"] == 0
    assert body["totals"]["unpricedTokens"] == body["totals"]["totalTokens"]


def test_user_detail_has_cost_by_day_and_by_model_with_a_priced_flag(priced: World) -> None:
    url = f"/admin/ai-usage/users/{priced.architect.id}?from={iso(FROM)}&to={iso(TO)}"
    body = priced.api.call("GET", url, priced.admin).json()
    assert len(body["byDay"]) == 1
    assert body["byDay"][0]["day"] == "2026-03-10"
    assert body["byDay"][0]["unpricedTokens"] == 1000
    assert body["byDay"][0]["requests"] == 2
    assert body["byDay"][0]["estimatedCost"] == pytest.approx(4.035, abs=1e-6)
    by_model = {m["modelId"]: m for m in body["byModel"]}
    assert by_model["claude-x"]["priced"] is True
    assert by_model["claude-x"]["unpricedTokens"] == 0
    assert by_model["claude-x"]["estimatedCost"] == pytest.approx(4.035, abs=1e-6)
    assert by_model["mystery"]["priced"] is False
    assert by_model["mystery"]["estimatedCost"] == 0
    assert by_model["mystery"]["unpricedTokens"] == 1000


def test_changing_a_price_reprices_history(priced: World) -> None:
    zero = {**PRICE, "inputPerMillion": 0, "outputPerMillion": 0, "cacheReadPerMillion": 0, "cacheWritePerMillion": 0}
    put_price(priced, zero)
    body = report(priced)
    assert body["totals"]["estimatedCost"] == 0
    assert body["totals"]["unpricedTokens"] == 1000


# --- usage in the chat panel --------------------------------------------------------------------------


def test_post_returns_the_turn_usage_and_message_id_and_get_has_per_reply_usage_and_a_total(
    w: World, scripted: ScriptedModel
) -> None:
    scripted.reply(text_step("hi", 120, 30))
    res = w.chat()
    assert res.status_code == 200
    assert res.json()["usage"] == {"inputTokens": 120, "outputTokens": 30, "totalTokens": 150}
    assistant_id = res.json()["assistantMessageId"]
    assert assistant_id

    messages = w.history().json()
    reply = next(m for m in messages["messages"] if m["id"] == assistant_id)
    assert reply["role"] == "assistant"
    assert reply["usage"] == {"inputTokens": 120, "outputTokens": 30, "totalTokens": 150}
    assert "usage" not in next(m for m in messages["messages"] if m["role"] == "user")
    assert messages["usageTotal"] == {"requests": 1, "inputTokens": 120, "outputTokens": 30, "totalTokens": 150}


def test_the_usage_row_links_to_the_stored_assistant_message(w: World) -> None:
    res = w.chat()
    stored = w.api.scalar("SELECT id FROM chat_messages WHERE role = 'assistant'")
    [row] = usage_rows(w.api)
    assert res.json()["assistantMessageId"] == str(stored)
    assert str(row["chat_message_id"]) == str(stored)


def test_usage_total_sums_the_diagrams_turns_including_a_failed_turns_partial_usage(
    w: World, scripted: ScriptedModel
) -> None:
    scripted.reply(text_step("a", 120, 30))
    w.chat()
    scripted.script(tool_step(input=100, output=20), RuntimeError("boom"))
    failing = tolerant_api(w.api)
    failing.client.cookies.set("cid", w.architect.cookie)
    res = failing.client.post(
        f"/diagrams/{w.diagram_id}/chat/messages",
        json={"message": "add a node", "currentDslContent": "flowchart TD\n"},
    )
    assert res.status_code >= 500

    rows = usage_rows(w.api)
    assert len(rows) == 2
    assert rows[0]["chat_message_id"] is not None
    assert rows[1]["chat_message_id"] is None
    assert w.history().json()["usageTotal"] == {
        "requests": 2,
        "inputTokens": 220,
        "outputTokens": 50,
        "totalTokens": 270,
    }


def test_when_an_admin_turns_display_off_non_admins_get_no_usage_but_admins_still_do(
    w: World, scripted: ScriptedModel
) -> None:
    scripted.reply(text_step("hi", 120, 30))
    assert set_show(w, False).status_code == 200

    post = w.chat()
    assert post.status_code == 200
    assert "usage" not in post.json()
    get = w.history().json()
    assert "usageTotal" not in get
    assert all("usage" not in m for m in get["messages"])
    # No usage fields anywhere in the body.
    import json
    import re

    assert not re.search(r'"(usage|usageTotal|inputTokens|outputTokens|totalTokens)"', json.dumps(get))

    admin_get = w.history(w.admin).json()
    assert admin_get["usageTotal"]["requests"] == 1
    assert admin_get["usageTotal"]["totalTokens"] == 150
    assert next(m for m in admin_get["messages"] if m["role"] == "assistant")["usage"]["totalTokens"] == 150

    # Recording is unaffected by the display setting.
    assert len(usage_rows(w.api)) == 1
    # An admin sending a message still gets usage back.
    assert w.chat(who=w.admin).json()["usage"]


def test_turning_display_back_on_restores_it(w: World) -> None:
    set_show(w, False)
    set_show(w, True)
    assert w.chat().json()["usage"]


def test_chat_responses_never_include_a_cost(w: World) -> None:
    put_price(w, {**PRICE, "provider": "test-provider", "modelId": "test-model"})
    w.chat()
    assert "cost" not in w.history(w.admin).text.lower()


# --- GET /me/ai-usage ---------------------------------------------------------------------------------


def test_me_counts_only_this_months_own_rows(w: World) -> None:
    now = datetime.now(UTC)
    insert_usage(w.api, w.architect, now, input=100, output=20)
    insert_usage(w.api, w.architect, now, input=1, output=1)
    two_months_ago = datetime(now.year + (now.month - 2 - 1) // 12, (now.month - 3) % 12 + 1, 15, tzinfo=UTC)
    insert_usage(w.api, w.architect, two_months_ago, input=5000, output=5000)
    insert_usage(w.api, w.other, now, input=9000, output=9000)
    res = w.api.call("GET", "/me/ai-usage", w.architect)
    assert res.status_code == 200
    body = res.json()
    assert body["visible"] is True
    assert (body["requests"], body["inputTokens"], body["outputTokens"], body["totalTokens"]) == (2, 101, 21, 122)
    start = datetime(now.year, now.month, 1, tzinfo=UTC)
    end = datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=UTC)
    assert body["from"] == start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert body["to"] == end.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert "cost" not in res.text.lower()


def test_me_is_zero_for_a_user_with_no_usage(w: World) -> None:
    body = w.api.call("GET", "/me/ai-usage", w.architect).json()
    assert body["visible"] is True
    assert body["requests"] == 0
    assert body["totalTokens"] == 0


def test_me_is_not_visible_to_non_admins_when_off_but_admins_still_see_totals(w: World) -> None:
    now = datetime.now(UTC)
    insert_usage(w.api, w.architect, now, input=10, output=5)
    insert_usage(w.api, w.admin, now, input=7, output=3)
    set_show(w, False)
    assert w.api.call("GET", "/me/ai-usage", w.architect).json() == {"visible": False}
    admin = w.api.call("GET", "/me/ai-usage", w.admin).json()
    assert admin["visible"] is True
    assert admin["totalTokens"] == 10


def test_me_requires_authentication(w: World) -> None:
    assert w.api.call("GET", "/me/ai-usage").status_code == 401


# --- PATCH /admin/ai-settings -------------------------------------------------------------------------


def test_patch_rejects_an_empty_body_and_wrongly_typed_values(w: World) -> None:
    patch = lambda body: w.api.call("PATCH", "/admin/ai-settings", w.admin, json=body).status_code  # noqa: E731
    assert patch({}) == 400
    assert patch({"showUsageToUsers": "no"}) == 400
    assert patch({"chatEnabled": 1}) == 400


def test_patch_ignores_an_unknown_property(w: World) -> None:
    before = w.api.call("PATCH", "/admin/ai-settings", w.admin, json={"chatEnabled": True}).json()
    res = w.api.call("PATCH", "/admin/ai-settings", w.admin, json={"chatEnabled": False, "nope": True})
    assert res.status_code == 200
    assert res.json()["chatEnabled"] is False
    assert res.json()["showUsageToUsers"] == before["showUsageToUsers"]
    assert "nope" not in res.json()


def test_patch_one_setting_leaves_the_other_alone(w: World) -> None:
    patch = lambda body: w.api.call("PATCH", "/admin/ai-settings", w.admin, json=body)  # noqa: E731
    a = patch({"chatEnabled": False})
    assert a.status_code == 200
    assert (a.json()["chatEnabled"], a.json()["showUsageToUsers"]) == (False, True)
    b = patch({"showUsageToUsers": False})
    assert (b.json()["chatEnabled"], b.json()["showUsageToUsers"]) == (False, False)
    c = patch({"chatEnabled": True, "showUsageToUsers": True})
    assert (c.json()["chatEnabled"], c.json()["showUsageToUsers"]) == (True, True)


def test_patch_is_admin_only(w: World) -> None:
    res = w.api.call("PATCH", "/admin/ai-settings", w.architect, json={"showUsageToUsers": False})
    assert res.status_code == 403
