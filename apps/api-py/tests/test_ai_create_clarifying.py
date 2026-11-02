"""Create with AI: the clarifying-question chat flow (canvas-ltm, canvas-s3o): the cases of
apps/api/tests/contract/create-ai-clarifying.test.ts, through the route with AI_PROVIDER=mock (the rule-based
model in canvas_api/ai/mock_model.py). A vague request gets a text-only question (no tool calls, DSL untouched);
the answer and the "Create diagram" message are handled by concrete mock rules; the exchange is persisted in order.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from canvas_api.config import Settings
from tests.ai_helpers import World, chat_world
from tests.api import Api

EMPTY_DSL = "flowchart TD\n"
QUESTION = "Before I draw this, what are the main steps or elements you want included?"


@pytest.fixture()
def w(api: Api, ai_env: Callable[..., Settings], needs_bridge: str) -> World:
    ai_env(ai_provider="mock")
    return chat_world(api)


def send(w: World, message: str, dsl: str, with_persona: bool = False, mode: str | None = None) -> dict[str, Any]:
    extra: dict[str, Any] = {"currentDslContent": dsl}
    if with_persona:
        extra["personaId"] = w.persona_id
    if mode:
        extra["mode"] = mode
    response = w.chat(message, **extra)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def test_asks_a_question_for_a_vague_request_then_draws_once_answered_and_persists_the_exchange_in_order(
    w: World,
) -> None:
    first = send(w, "Create a diagram of our order process", EMPTY_DSL, True)
    assert first["toolCalls"] == []
    assert first["assistantMessage"] == QUESTION
    assert first["updatedDslContent"] == EMPTY_DSL

    second = send(w, "Add a shape called Order Received", first["updatedDslContent"])
    assert len(second["toolCalls"]) == 1
    assert "Order Received" in second["updatedDslContent"]

    messages = w.history().json()["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant"]
    assert messages[0]["content"] == "Create a diagram of our order process"
    assert messages[2]["content"] == "Add a shape called Order Received"


def test_draws_a_placeholder_step_when_told_to_go_ahead_and_draw(w: World) -> None:
    first = send(w, "Create a diagram of our order process", EMPTY_DSL, True)
    draw = send(w, "Please go ahead and draw the diagram now with sensible defaults.", first["updatedDslContent"])
    assert len(draw["toolCalls"]) == 1
    assert "Draft step" in draw["updatedDslContent"]


# --- canvas-s3o: plan vs build mode -------------------------------------------------------------------


def test_plan_mode_never_draws_a_concrete_request_is_played_back_and_the_dsl_untouched(w: World) -> None:
    plan = send(w, "Add a shape called Order Received", EMPTY_DSL, True, "plan")
    assert plan["toolCalls"] == []
    assert plan["updatedDslContent"] == EMPTY_DSL
    assert plan["assistantMessage"] == (
        "Here's what I'll build: \"Add a shape called Order Received\". Click Create diagram when you're ready."
    )


def test_plan_mode_answers_a_vague_request_with_the_clarifying_question(w: World) -> None:
    plan = send(w, "Create a diagram of our order process", EMPTY_DSL, True, "plan")
    assert plan["toolCalls"] == []
    assert plan["assistantMessage"] == QUESTION
    assert plan["updatedDslContent"] == EMPTY_DSL


def test_plan_mode_adds_the_planning_section_to_the_system_prompt_build_mode_does_not(w: World) -> None:
    ask = "what do you know about this diagram?"
    plan = send(w, ask, EMPTY_DSL, True, "plan")
    assert "## Create with AI — planning" in plan["assistantMessage"]
    build = send(w, ask, EMPTY_DSL, False, "build")
    assert "## Create with AI — planning" not in build["assistantMessage"]
    default = send(w, ask, EMPTY_DSL)
    assert "## Create with AI — planning" not in default["assistantMessage"]


def test_a_build_turn_after_a_plan_turn_draws_what_was_planned_and_history_keeps_all_four_messages_in_order(
    w: World,
) -> None:
    plan = send(w, "Add a shape called Order Received", EMPTY_DSL, True, "plan")
    assert plan["updatedDslContent"] == EMPTY_DSL
    build_message = "Please create the diagram now, as discussed."
    build = send(w, build_message, plan["updatedDslContent"], False, "build")
    assert len(build["toolCalls"]) == 1
    assert "Order Received" in build["updatedDslContent"]

    messages = w.history().json()["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user", "assistant"]
    assert messages[0]["content"] == "Add a shape called Order Received"
    assert messages[2]["content"] == build_message


def test_rejects_an_invalid_mode_with_400(w: World) -> None:
    response = w.chat("Add a shape called X", currentDslContent=EMPTY_DSL, mode="draw")
    assert response.status_code == 400


def test_defaults_to_build_a_concrete_request_without_a_mode_draws_immediately(w: World) -> None:
    result = send(w, "Add a shape called Order Received", EMPTY_DSL)
    assert len(result["toolCalls"]) == 1
    assert "Order Received" in result["updatedDslContent"]
