"""The rule-based stand-in for an AI provider (AI_PROVIDER=mock; canvas_api/ai/mock_model.py, a port of
apps/api/src/ai/mock-nlu.ts), which the e2e AI specs (apps/web/tests/e2e/ai-*.spec.ts) are written against.

Each phrase rule: the tool and input it picks, its fallbacks, and that it declines when the tool isn't offered
this turn. Then a whole chat turn through the route with AI_PROVIDER=mock.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from canvas_api.ai.mock_model import (
    CLARIFYING_QUESTION,
    COLOR_WORDS,
    FORMATTED_SUMMARY,
    MockModel,
)
from canvas_api.ai.models import Message, Step, ToolCall, ToolResult, ToolSpec
from canvas_api.config import Settings
from tests.ai_helpers import chat_world, usage_rows
from tests.api import Api

BASIC_TOOLS = ["addNode", "removeNode", "addEdge", "updateNodeLabel", "updateNodeStyle", "removeEdge"]
UNKNOWN = "I'm not sure how to help with that."
SYSTEM = "\n".join(
    [
        "You are an assistant.",
        "Current shapes:",
        '- n1: "Start" (rectangle)',
        '- n2: "Check Order" (diamond)',
        '- Customer: "Customer" (rectangle)',
        '- Account: "Account" (rectangle)',
        "",
        "Current connectors:",
        "- e1: n1 -> n2",
        "- e2: Customer -> Account",
    ]
)


def tools(*names: str) -> list[ToolSpec]:
    return [ToolSpec(n, "", {}) for n in names]


def ask(text: str, offered: list[str] | None = None, system: str = SYSTEM, earlier: list[str] | None = None) -> Step:
    messages = [Message(role="user", text=t) for t in earlier or []] + [Message(role="user", text=text)]
    return MockModel().generate(system, messages, tools(*(BASIC_TOOLS if offered is None else offered)))


def only_call(step: Step) -> ToolCall:
    assert step.text == ""
    [call] = step.tool_calls
    return call


def assert_call(step: Step, name: str, tool_input: dict[str, Any]) -> None:
    call = only_call(step)
    assert (call.name, call.input) == (name, tool_input)
    assert call.id.startswith("mock-")


# --- general rules ------------------------------------------------------------------------------------


def test_identifies_itself_for_usage_recording() -> None:
    assert (MockModel.provider, MockModel.model_id) == ("mock-provider", "mock-model-id")


def test_finishes_with_done_once_a_tool_result_came_back_so_each_message_makes_one_tool_call() -> None:
    messages = [
        Message(role="user", text="Add a shape called X"),
        Message(role="assistant", tool_calls=(ToolCall("c", "addNode", {}),)),
        Message(role="tool", tool_results=(ToolResult("c", "addNode", output={"applied": True}),)),
    ]
    step = MockModel().generate(SYSTEM, messages, tools(*BASIC_TOOLS))
    assert (step.text, step.tool_calls) == ("Done.", [])


def test_replies_in_markdown_to_show_a_formatted_summary() -> None:
    assert ask("  Show a formatted summary ").text == FORMATTED_SUMMARY
    assert "**summary**" in FORMATTED_SUMMARY
    # Only the exact phrase.
    assert ask("show a formatted summary please").text == UNKNOWN


@pytest.mark.parametrize("phrase", ["what do you know about this diagram?", "What do you know about this diagram"])
def test_echoes_the_system_prompt_for_the_introspection_phrase(phrase: str) -> None:
    assert ask(phrase).text == SYSTEM


def test_introspection_works_with_no_tools_offered() -> None:
    assert ask("what do you know about this diagram?", offered=[]).text == SYSTEM


def test_with_no_tools_offered_a_vague_create_gets_the_clarifying_question() -> None:
    assert ask("Create a diagram of our order process", offered=[]).text == CLARIFYING_QUESTION
    assert ask("build me a flowchart diagram", offered=[]).text == CLARIFYING_QUESTION


def test_with_no_tools_offered_anything_else_is_played_back() -> None:
    step = ask("  Add a shape called Order Received ", offered=[])
    assert step.tool_calls == []
    assert step.text == (
        "Here's what I'll build: \"Add a shape called Order Received\". Click Create diagram when you're ready."
    )


# --- addNode ------------------------------------------------------------------------------------------


def test_add_a_shape_called_x_adds_a_rectangle() -> None:
    assert_call(ask("Add a shape called Order Received"), "addNode", {"shape": "rectangle", "label": "Order Received"})


@pytest.mark.parametrize("shape", ["rectangle", "rounded-rectangle", "circle", "diamond", "cylinder"])
def test_add_a_named_shape_uses_it(shape: str) -> None:
    assert_call(ask(f"add a {shape} shape called Foo"), "addNode", {"shape": shape, "label": "Foo"})


def test_an_unknown_shape_word_falls_back_to_a_rectangle() -> None:
    assert_call(ask("add a hexagon shape called Foo"), "addNode", {"shape": "rectangle", "label": "Foo"})


def test_add_a_shape_named_with_quotes_and_a_trailing_period() -> None:
    assert_call(ask("Add a shape named 'Ship it'."), "addNode", {"shape": "rectangle", "label": "Ship it"})


# --- addElement (canvas-tfr) --------------------------------------------------------------------------


def test_add_a_kind_called_x_calls_add_element_when_the_standard_offers_it() -> None:
    step = ask("add a primary_activity called Operations", offered=[*BASIC_TOOLS, "addElement"])
    assert_call(step, "addElement", {"kind": "primary_activity", "label": "Operations"})


def test_the_kind_id_is_lower_cased() -> None:
    step = ask("Add an External_System named CRM", offered=[*BASIC_TOOLS, "addElement"])
    assert_call(step, "addElement", {"kind": "external_system", "label": "CRM"})


def test_add_a_kind_declines_when_add_element_is_not_offered() -> None:
    assert ask("add a primary_activity called Operations").text == UNKNOWN


def test_the_word_shape_is_never_a_kind() -> None:
    step = ask("add a shape called Foo", offered=[*BASIC_TOOLS, "addElement"])
    assert only_call(step).name == "addNode"


# --- addEdge ------------------------------------------------------------------------------------------


def test_connect_x_to_y_resolves_ids_from_the_labels_in_the_system_prompt() -> None:
    assert_call(ask("connect Start to Check Order"), "addEdge", {"sourceId": "n1", "targetId": "n2"})


def test_connect_falls_back_to_the_text_for_a_label_it_cannot_find() -> None:
    assert_call(ask("connect 'Start' to Nowhere"), "addEdge", {"sourceId": "n1", "targetId": "Nowhere"})
    assert_call(ask("connect Ghost to Start"), "addEdge", {"sourceId": "Ghost", "targetId": "n1"})


def test_label_lookup_ignores_case() -> None:
    assert_call(ask("connect start to check order"), "addEdge", {"sourceId": "n1", "targetId": "n2"})


# --- removeNode / updateNodeLabel / updateNodeStyle ---------------------------------------------------


def test_remove_the_shape_x() -> None:
    assert_call(ask("remove the shape Start"), "removeNode", {"nodeId": "n1"})
    assert_call(ask("Remove shape called Check Order"), "removeNode", {"nodeId": "n2"})


def test_remove_falls_back_to_the_text_for_an_unknown_label() -> None:
    assert_call(ask("remove shape Ghost"), "removeNode", {"nodeId": "Ghost"})


def test_rename_x_to_y() -> None:
    assert_call(ask("rename Start to Begin"), "updateNodeLabel", {"nodeId": "n1", "label": "Begin"})
    assert_call(ask("rename 'Ghost' to 'Spirit'"), "updateNodeLabel", {"nodeId": "Ghost", "label": "Spirit"})


@pytest.mark.parametrize("word", sorted(COLOR_WORDS))
def test_make_x_a_color_sets_the_fill(word: str) -> None:
    assert_call(ask(f"make Start {word}"), "updateNodeStyle", {"nodeId": "n1", "fillColor": COLOR_WORDS[word]})


def test_color_forms() -> None:
    assert_call(ask("color the Start node red"), "updateNodeStyle", {"nodeId": "n1", "fillColor": "#c0392b"})
    assert_call(ask("make the Check Order shape Blue"), "updateNodeStyle", {"nodeId": "n2", "fillColor": "#2980b9"})
    assert_call(ask("make Ghost green"), "updateNodeStyle", {"nodeId": "Ghost", "fillColor": "#27ae60"})


# --- 010-ai-diagram-knowledge: one rule per family-specific tool --------------------------------------


def test_set_the_role_of_x_to_y() -> None:
    step = ask("set the role of Customer to Person", offered=["setNodeRole"])
    assert_call(step, "setNodeRole", {"nodeId": "Customer", "role": "person"})
    assert_call(
        ask("set role of Ghost to actor", offered=["setNodeRole"]), "setNodeRole", {"nodeId": "Ghost", "role": "actor"}
    )


def test_give_x_an_attribute() -> None:
    offered = ["setEntityAttributes"]
    assert_call(
        ask("give Customer an attribute string name", offered=offered),
        "setEntityAttributes",
        {"nodeId": "Customer", "attributes": [{"type": "string", "name": "name", "keys": []}]},
    )
    assert_call(
        ask("give Customer an attribute string id pk", offered=offered),
        "setEntityAttributes",
        {"nodeId": "Customer", "attributes": [{"type": "string", "name": "id", "keys": ["PK"]}]},
    )


def test_give_x_attribute_and_method() -> None:
    step = ask("give Account a private string owner attribute and a public close method", offered=["setClassMembers"])
    assert_call(
        step,
        "setClassMembers",
        {
            "nodeId": "Account",
            "members": [
                {"kind": "attribute", "visibility": "-", "type": "string", "name": "owner"},
                {"kind": "method", "visibility": "+", "name": "close", "params": ""},
            ],
        },
    )
    protected = ask("give Account a protected int n attribute and a package go method", offered=["setClassMembers"])
    members = only_call(protected).input["members"]
    assert (members[0]["visibility"], members[1]["visibility"]) == ("#", "~")


def test_make_the_connector_between_x_and_y_a_relation_kind() -> None:
    step = ask("make the connector between Customer and Account an inheritance", offered=["setRelationshipKind"])
    assert_call(step, "setRelationshipKind", {"edgeId": "e2", "umlRelationKind": "inheritance"})


def test_the_relation_rule_falls_through_when_no_such_connector_exists() -> None:
    step = ask("make the connector between Start and Account a composition", offered=["setRelationshipKind"])
    assert step.text == UNKNOWN


def test_group_x_and_y_into_a_container() -> None:
    step = ask("group Start and Check Order into a boundary called Orders", offered=["groupIntoContainer"])
    assert_call(step, "groupIntoContainer", {"nodeIds": ["n1", "n2"], "label": "Orders"})


def test_activate_x() -> None:
    assert_call(
        ask("activate Customer", offered=["activateParticipant"]), "activateParticipant", {"participantId": "Customer"}
    )
    assert_call(
        ask("Activate Ghost", offered=["activateParticipant"]), "activateParticipant", {"participantId": "Ghost"}
    )
    # Anchored: only the whole message.
    assert ask("please activate Customer", offered=["activateParticipant"]).text == UNKNOWN


@pytest.mark.parametrize(
    ("message", "tool_name"),
    [
        ("set the role of Customer to Person", "setNodeRole"),
        ("give Customer an attribute string name", "setEntityAttributes"),
        ("give Account a private string owner attribute and a public close method", "setClassMembers"),
        ("make the connector between Customer and Account an inheritance", "setRelationshipKind"),
        ("group Start and Check Order into a box called Orders", "groupIntoContainer"),
        ("activate Customer", "activateParticipant"),
    ],
)
def test_each_family_rule_declines_when_its_tool_is_not_offered(message: str, tool_name: str) -> None:
    assert ask(message).text == UNKNOWN
    assert [call.name for call in ask(message, offered=[*BASIC_TOOLS, tool_name]).tool_calls] == [tool_name]


# --- canvas-ltm: Create with AI -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "message", ["Create a diagram of our order process", "make a sequence diagram", "Draw me a diagram"]
)
def test_a_vague_create_request_gets_the_clarifying_question(message: str) -> None:
    step = ask(message)
    assert (step.text, step.tool_calls) == (CLARIFYING_QUESTION, [])


def test_go_ahead_and_draw_draws_a_placeholder_step() -> None:
    assert_call(ask("Please go ahead and draw it"), "addNode", {"shape": "rectangle", "label": "Draft step"})
    # "create the diagram now" reads as a vague create request (the question rule is checked first), as in TypeScript.
    assert ask("create the diagram now").text == CLARIFYING_QUESTION


def test_go_ahead_and_draw_declines_without_add_node() -> None:
    assert ask("go ahead and draw", offered=["removeNode"]).text == UNKNOWN


def test_create_the_diagram_now_replays_the_latest_concrete_earlier_request() -> None:
    step = ask(
        "Please create the diagram now, as discussed.",
        earlier=["Add a shape called First", "Add a rectangle shape called Order Received", "thanks, sounds good"],
    )
    assert_call(step, "addNode", {"shape": "rectangle", "label": "Order Received"})


def test_replay_also_recognises_the_add_a_kind_called_form() -> None:
    step = ask(
        "go ahead and draw",
        offered=[*BASIC_TOOLS, "addElement"],
        earlier=["add a margin called Profit", "ok"],
    )
    assert_call(step, "addElement", {"kind": "margin", "label": "Profit"})


def test_go_ahead_and_draw_after_a_vague_request_draws_the_placeholder() -> None:
    step = ask("go ahead and draw the diagram", earlier=["Create a diagram of our order process"])
    assert_call(step, "addNode", {"shape": "rectangle", "label": "Draft step"})


def test_anything_else_is_not_understood() -> None:
    step = ask("tell me a joke")
    assert (step.text, step.tool_calls) == (UNKNOWN, [])


# --- usage estimate -----------------------------------------------------------------------------------


def test_reports_a_deterministic_estimate_of_about_4_characters_per_token() -> None:
    a = ask("Add a shape called Start")
    b = ask("Add a shape called Start")
    assert a.usage == b.usage
    assert a.usage.input_tokens > 0
    assert a.usage.output_tokens > 0
    # The prompt is the system prompt and the message, as JSON; the output is the tool call as JSON.
    prompt = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": [{"type": "text", "text": "Add a shape called Start"}]},
    ]
    assert a.usage.input_tokens == -(-len(json.dumps(prompt, separators=(",", ":"), ensure_ascii=False)) // 4)
    assert (a.usage.cache_read_tokens, a.usage.cache_write_tokens) == (0, 0)


def test_the_estimate_counts_utf16_units_like_javascript() -> None:
    plain = ask("tell me a joke")
    emoji = ask("tell me a joke \U0001f600")
    # One astral character is two UTF-16 code units in JavaScript's string length.
    assert emoji.usage.input_tokens - plain.usage.input_tokens in (1, 2)


# --- a whole chat turn through the route with AI_PROVIDER=mock ----------------------------------------


@pytest.fixture()
def mock_world(api: Api, ai_env: Callable[..., Settings], needs_bridge: str) -> Any:
    ai_env(ai_provider="mock")
    return chat_world(api)


def test_a_full_turn_through_the_route_draws_with_one_tool_call_then_confirms(mock_world: Any) -> None:
    w = mock_world
    response = w.chat("Add a shape called Order Received")
    assert response.status_code == 200
    body = response.json()
    assert body["assistantMessage"] == "Done."
    assert body["toolCalls"] == [{"tool": "addNode", "applied": True}]
    assert "Order Received" in body["updatedDslContent"]
    assert body["usage"]["inputTokens"] > 0
    assert body["usage"]["totalTokens"] == body["usage"]["inputTokens"] + body["usage"]["outputTokens"]

    # Two model calls (the tool call, then "Done."), recorded as one turn by the mock provider.
    [row] = usage_rows(w.api)
    assert (row["provider"], row["model_id"], row["steps"], row["mode"]) == (
        "mock-provider",
        "mock-model-id",
        2,
        "build",
    )
    messages = w.history().json()["messages"]
    assert [(m["role"], m["content"]) for m in messages] == [
        ("user", "Add a shape called Order Received"),
        ("assistant", "Done."),
    ]
    assert messages[1]["toolCalls"] == [{"tool": "addNode", "applied": True}]


def test_a_turn_resolves_ids_from_the_current_diagram_summary(mock_world: Any) -> None:
    w = mock_world
    first = w.chat("Add a shape called Alpha").json()["updatedDslContent"]
    second = w.chat("Add a shape called Beta", currentDslContent=first).json()["updatedDslContent"]
    connected = w.chat("connect Alpha to Beta", currentDslContent=second).json()
    assert connected["toolCalls"] == [{"tool": "addEdge", "applied": True}]
    assert "-->" in connected["updatedDslContent"]


def test_a_turn_that_names_nothing_it_understands_changes_nothing(mock_world: Any) -> None:
    body = mock_world.chat("tell me a joke").json()
    assert body["assistantMessage"] == UNKNOWN
    assert body["toolCalls"] == []
    assert body["updatedDslContent"].strip() == "flowchart TD"


def test_the_mock_provider_lists_its_one_model(mock_world: Any) -> None:
    w = mock_world
    models = w.api.call("GET", "/admin/ai-models", w.admin).json()
    assert [m["id"] for m in models["models"]] == ["mock"]
