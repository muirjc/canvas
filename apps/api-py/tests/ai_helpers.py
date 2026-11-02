"""Helpers for the AI route tests (phase 8, canvas-1bty.12): a scripted language model, and seeding.

The TypeScript tests give the AI SDK a MockLanguageModelV4 with scripted steps; here `ScriptedModel` is the
`LanguageModel` (canvas_api/ai/models.py) the chat loop talks to, returning the same kind of steps and
recording what the loop sent it.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from canvas_api.ai.models import Message, Step, ToolCall, ToolSpec, Usage
from canvas_api.timestamps import to_db
from tests.api import Api, User


def text_step(text: str, input: int = 1, output: int = 1, cache_read: int = 0, cache_write: int = 0) -> Step:
    return Step(text=text, usage=Usage(input, output, cache_read, cache_write))


def tool_step(
    name: str = "addNode",
    tool_input: dict[str, Any] | None = None,
    input: int = 1,
    output: int = 1,
    cache_read: int = 0,
    cache_write: int = 0,
    call_id: str = "call-1",
) -> Step:
    call = ToolCall(call_id, name, tool_input if tool_input is not None else {"label": "Start", "shape": "rectangle"})
    return Step(text="", tool_calls=[call], usage=Usage(input, output, cache_read, cache_write))


@dataclass
class Call:
    system: str
    messages: list[Message]
    tools: list[ToolSpec]


@dataclass
class ScriptedModel:
    """Answers each `generate` with `handler(call_number, call)` (default: a one-token "ok")."""

    provider: str = "test-provider"
    model_id: str = "test-model"
    handler: Callable[[int, Call], Step] = field(default=lambda _n, _call: text_step("ok"))
    calls: list[Call] = field(default_factory=list)
    #: The admin's chosen model id each time the route asked for the model (None = no choice).
    chosen: list[str | None] = field(default_factory=list)

    def generate(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> Step:
        # The loop keeps appending to its conversation, so keep a snapshot of what this call was sent.
        call = Call(system, list(messages), list(tools))
        self.calls.append(call)
        return self.handler(len(self.calls), call)

    def factory(self, chosen: str | None) -> ScriptedModel:
        self.chosen.append(chosen)
        return self

    def reply(self, step_or_text: Step | str) -> None:
        step = text_step(step_or_text) if isinstance(step_or_text, str) else step_or_text
        self.handler = lambda _n, _call: step

    def script(self, *steps: Step | Exception) -> None:
        """The steps in order, counted from the next call; an exception is raised instead of returned."""

        base = len(self.calls)

        def handler(n: int, _call: Call) -> Step:
            item = steps[n - base - 1]
            if isinstance(item, Exception):
                raise item
            return item

        self.handler = handler


def last_user_text(call: Call) -> str:
    return next(m.text for m in reversed(call.messages) if m.role == "user")


# --- seeding ------------------------------------------------------------------------------------------


def enable_chat(api: Api, on: bool = True) -> None:
    api.execute("UPDATE ai_settings SET chat_enabled = :v", v=on)


def persona(
    api: Api,
    name: str = "Business Architect",
    category: str = "Business",
    prompt: str = "You help.",
    status: str = "active",
) -> str:
    persona_id = str(uuid4())
    api.execute(
        "INSERT INTO ai_personas (id, name, category, system_prompt, status)"
        " VALUES (:id, :name, :cat, :prompt, :status)",
        id=persona_id,
        name=name,
        cat=category,
        prompt=prompt,
        status=status,
    )
    return persona_id


def reference_material(api: Api, persona_id: str, content: str, families: list[str] | None = None) -> str:
    entry_id = str(uuid4())
    api.execute(
        "INSERT INTO ai_persona_reference_material (id, persona_id, content) VALUES (:id, :persona, :content)",
        id=entry_id,
        persona=persona_id,
        content=content,
    )
    for position, family in enumerate(families or []):
        api.execute(
            "INSERT INTO ai_persona_reference_material_families (reference_material_id, diagram_family, position)"
            " VALUES (:id, :family, :position)",
            id=entry_id,
            family=family,
            position=position,
        )
    return entry_id


def insert_usage(
    api: Api,
    user: User | str | None,
    at: datetime,
    *,
    input: int = 10,
    output: int = 5,
    model: str = "claude-x",
    provider: str = "anthropic",
    cache_read: int = 0,
    cache_write: int = 0,
    ok: bool = True,
) -> None:
    api.execute(
        "INSERT INTO ai_usage (id, occurred_at, user_id, diagram_id, provider, model_id, mode, steps, input_tokens,"
        " output_tokens, cache_read_tokens, cache_write_tokens, succeeded) VALUES (:id, :at, :user, NULL, :provider,"
        " :model, 'build', 1, :input, :output, :cr, :cw, :ok)",
        id=str(uuid4()),
        at=to_db(at, api.dialect),
        user=user.id if isinstance(user, User) else user,
        provider=provider,
        model=model,
        input=input,
        output=output,
        cr=cache_read,
        cw=cache_write,
        ok=ok,
    )


def usage_rows(api: Api) -> list[dict[str, Any]]:
    from sqlalchemy import text

    with api.engine.connect() as conn:
        rows = conn.execute(text("SELECT * FROM ai_usage ORDER BY occurred_at")).mappings().all()
    return [dict(r) for r in rows]


def tolerant_api(api: Api) -> Api:
    """The same app, but a server error becomes a 500 response (the default client re-raises it)."""
    return Api(TestClient(api.client.app, raise_server_exceptions=False), api.engine)


def audit_details(api: Api, event: str) -> list[dict[str, Any]]:
    from sqlalchemy import text

    with api.engine.connect() as conn:
        rows = conn.execute(text("SELECT detail FROM audit_events WHERE event = :e ORDER BY occurred_at"), {"e": event})
        return [json.loads(r.detail) if isinstance(r.detail, str) else r.detail for r in rows]


@dataclass
class World:
    api: Api
    admin: User
    architect: User
    other: User
    project: str
    diagram_id: str
    #: A persona (Business Architect) for tests that name one in their first message.
    persona_id: str = ""

    def chat(self, message: str = "hello", who: User | None = None, **extra: Any) -> Any:
        payload = {"message": message, "currentDslContent": "flowchart TD\n", **extra}
        return self.api.call("POST", f"/diagrams/{self.diagram_id}/chat/messages", who or self.architect, json=payload)

    def history(self, who: User | None = None) -> Any:
        return self.api.call("GET", f"/diagrams/{self.diagram_id}/chat/messages", who or self.architect)


def chat_world(api: Api, *, admin: User | None = None, architect: User | None = None) -> World:
    """An admin, an architect with a project holding one flowchart diagram, a second user; chat switched on."""
    api.diagram_type("flowchart", "flowchart")
    admin = admin or api.user("admin@example.com", "admin")
    architect = architect or api.user("architect@example.com")
    other = api.user("other@example.com")
    project = api.project(architect, "Chat Project")
    diagram = api.new_diagram(project, architect, "D", "flowchart")
    enable_chat(api)
    return World(
        api,
        admin,
        architect,
        other,
        project,
        diagram["id"],
        persona(api, "Business Architect", prompt="You are a business architect."),
    )
