"""A diagram's AI chat (apps/api/src/ai/diagram-chat.service.ts).

Each turn: parse the editor's current diagram, compose the system prompt (persona, family primer, standard,
reference material, reply style, the current diagram), then call the model, run the tools it asks for and
call again, until it stops asking or the step limit is reached (the AI SDK's generateText with stopWhen).
The tools run in the diagram-core bridge (the TypeScript tool definitions); the edited diagram comes back
as DSL. The turn, its reply and its token usage are saved.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from typing import Any
from uuid import uuid4

from sqlalchemy import Connection, Engine, text

from canvas_api.ai.anthropic_model import AnthropicModel
from canvas_api.ai.mock_model import MockModel
from canvas_api.ai.models import (
    DEFAULT_MODEL_ID,
    LanguageModel,
    Message,
    ToolResult,
    ToolSpec,
    UnconfiguredAiProviderError,
)
from canvas_api.ai.openai_model import OpenAIModel
from canvas_api.ai.personas import get_persona, reference_material_for_family
from canvas_api.ai.settings import chosen_model_id
from canvas_api.ai.usage import record_usage, usage_for_messages
from canvas_api.catalog import DSL_FAMILIES
from canvas_api.config import Settings
from canvas_api.diagram_core import DiagramBridge
from canvas_api.standards import get_active_standard
from canvas_api.timestamps import to_api

log = logging.getLogger(__name__)


class DslParseError(Exception):
    pass


DEFAULT_SYSTEM_PROMPT = "You are an assistant that helps create and edit flowchart diagrams."

#: canvas-rfv: replies show in a narrow chat panel, which lists the edits made separately.
REPLY_STYLE = (
    "Your replies appear in a narrow chat panel. Keep them short: a sentence or two, or a brief list. "
    "Don't restate the whole diagram or list every edit you made -- the panel shows the changes separately. "
    "Use plain Markdown only (bold, lists, inline code); no tables or headings unless asked."
)

#: canvas-s3o: Create with AI's planning phase. No drawing tools, and this section says what the phase is for.
PLANNING_INSTRUCTIONS = "\n".join(
    [
        'The user is describing a NEW diagram in the "Create with AI" dialog. Nothing is drawn in this phase'
        " -- you have no drawing tools yet.",
        "Follow your clarifying-question practice: if anything that materially changes the diagram is unclear"
        " (scope, audience, level of detail, notation), ask concise numbered questions, offering a default for"
        " each.",
        "When you have enough, play back in a few lines what you will build -- the diagram type, scope, the main"
        ' elements, and your key assumptions -- and tell the user to click "Create diagram" when they are'
        " happy, or to reply with changes.",
        "Do not output the diagram itself (no Mermaid, code or element lists longer than a short outline) in this"
        " phase.",
    ]
)


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


# --- history ------------------------------------------------------------------------------------------

_CHAT = text("SELECT id, persona_id FROM diagram_chats WHERE diagram_id = :diagram")
_MESSAGES = text(
    "SELECT id, role, content, tool_calls, created_at FROM chat_messages WHERE diagram_chat_id = :chat"
    " ORDER BY created_at"
)


def get_chat_messages(conn: Connection, diagram_id: str, *, with_usage: bool = False) -> list[dict[str, Any]]:
    """The conversation, oldest first; empty for a diagram with no chat yet."""
    chat = conn.execute(_CHAT, {"diagram": diagram_id}).first()
    if chat is None:
        return []
    rows = conn.execute(_MESSAGES, {"chat": chat.id}).all()
    usage = usage_for_messages(conn, [str(r.id) for r in rows if r.role == "assistant"]) if with_usage else {}
    messages = []
    for r in rows:
        record: dict[str, Any] = {
            "id": str(r.id),
            "role": r.role,
            "content": r.content,
            "toolCalls": _json(r.tool_calls),
            "createdAt": to_api(r.created_at),
        }
        if str(r.id) in usage:
            record["usage"] = usage[str(r.id)]
        messages.append(record)
    return messages


def _get_or_create_chat(db: Engine, diagram_id: str, persona_id: str | None) -> tuple[str, str | None]:
    """The diagram's chat. Its persona is fixed by the first message (FR-008a)."""
    with db.begin() as conn:
        existing = conn.execute(_CHAT, {"diagram": diagram_id}).first()
        if existing:
            return str(existing.id), str(existing.persona_id) if existing.persona_id else None
        chat_id = str(uuid4())
        conn.execute(
            text("INSERT INTO diagram_chats (id, diagram_id, persona_id) VALUES (:id, :diagram, :persona)"),
            {"id": chat_id, "diagram": diagram_id, "persona": persona_id},
        )
        return chat_id, persona_id


# --- the model ------------------------------------------------------------------------------------------


def language_model_for(settings: Settings, chosen: str | None) -> LanguageModel:
    """The configured provider's model: the admin's choice, else AI_MODEL, else the provider's default."""
    provider = settings.ai_provider
    model_id = chosen or settings.ai_model
    if provider == "mock":
        return MockModel()
    if provider == "anthropic":
        if not settings.anthropic_api_key:
            raise UnconfiguredAiProviderError("AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set")
        return AnthropicModel(settings.anthropic_api_key, model_id or DEFAULT_MODEL_ID["anthropic"])
    if provider == "openai":
        if not settings.openai_api_key:
            raise UnconfiguredAiProviderError("AI_PROVIDER=openai requires OPENAI_API_KEY to be set")
        return OpenAIModel(settings.openai_api_key, model_id or DEFAULT_MODEL_ID["openai"])
    raise UnconfiguredAiProviderError(
        f'AI_PROVIDER must be set to "anthropic" or "openai" (got: {provider or "unset"})'
    )


def _system_prompt(
    conn: Connection,
    bridge: DiagramBridge,
    persona_id: str | None,
    persona_prompt: str | None,
    family: str,
    model: dict[str, Any],
    rules: dict[str, Any] | None,
    mode: str,
) -> str:
    """canvas-7wx: the persona's own prompt first, untouched; each appended section under its own heading."""
    parts = [persona_prompt if persona_prompt is not None else DEFAULT_SYSTEM_PROMPT]

    def section(heading: str, body: str) -> None:
        parts.append(f"## {heading}\n\n{body}")

    sections = bridge.ai_prompt(family, rules, model)
    if sections.get("primer"):
        section("Diagram type", sections["primer"])
    if sections.get("standard"):
        section("Diagram standard", sections["standard"])
    if persona_id:
        material = reference_material_for_family(conn, persona_id, family)
        if material:
            section("Reference material", "\n\n".join(e["content"] for e in material))
    section("Reply style", REPLY_STYLE)
    section("Current diagram", sections["currentDiagram"])
    if mode == "plan":
        section("Create with AI — planning", PLANNING_INSTRUCTIONS)
    return "\n\n".join(parts)


def _step_limit(mode: str, rules: dict[str, Any] | None) -> int:
    # canvas-s3o: a planning turn can only talk, one step. canvas-tfr: a few more under a standard, so the
    # model can fix the violations its own edits introduced within the same turn.
    if mode == "plan":
        return 1
    return 8 if rules else 5


# --- a turn ---------------------------------------------------------------------------------------------


def send_chat_message(
    db: Engine,
    bridge: DiagramBridge,
    settings: Settings,
    *,
    diagram: dict[str, Any],
    message: str,
    current_dsl: str,
    persona_id: str | None,
    mode: str,
    user_id: str | None,
    language_model: Callable[[str | None], LanguageModel] | None = None,
) -> dict[str, Any]:
    """`language_model(chosen_model_id)` makes the model (tests pass their own); default: the configured one."""
    family = diagram["dslFamily"]
    if family not in DSL_FAMILIES:
        raise DslParseError(f"No DSL family registered for: {family}")
    parsed = bridge.parse(family, current_dsl)
    if "model" not in parsed:
        raise DslParseError("currentDslContent could not be parsed")
    model: dict[str, Any] = parsed["model"]

    chat_id, chat_persona = _get_or_create_chat(db, diagram["id"], persona_id)
    with db.connect() as conn:
        persona = get_persona(conn, chat_persona) if chat_persona else None
        history = get_chat_messages(conn, diagram["id"])
        standard = get_active_standard(conn, diagram["diagramTypeId"])
        rules = standard.rules if standard else None
        system = _system_prompt(
            conn, bridge, chat_persona, persona["systemPrompt"] if persona else None, family, model, rules, mode
        )
        chosen = chosen_model_id(conn)
    lm = (language_model or (lambda c: language_model_for(settings, c)))(chosen)
    tools = (
        []
        if mode == "plan"
        else [ToolSpec(t["name"], t["description"], t["inputSchema"]) for t in bridge.ai_tools(family, rules)]
    )

    conversation = [Message(role=m["role"], text=m["content"]) for m in history]
    conversation.append(Message(role="user", text=message))
    outcomes: list[dict[str, Any]] = []
    totals = {"steps": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0}

    def record(succeeded: bool, chat_message_id: str | None = None) -> None:
        with db.begin() as conn:
            record_usage(
                conn,
                user_id=user_id,
                diagram_id=diagram["id"],
                provider=lm.provider,
                model_id=lm.model_id,
                mode=mode,
                steps=totals["steps"],
                input_tokens=totals["input"],
                output_tokens=totals["output"],
                cache_read_tokens=totals["cache_read"],
                cache_write_tokens=totals["cache_write"],
                succeeded=succeeded,
                chat_message_id=chat_message_id,
            )

    reply = ""
    try:
        for _ in range(_step_limit(mode, rules)):
            step = lm.generate(system, conversation, tools)
            # canvas-9af: every step's tokens count, so a turn that fails partway still records what it spent.
            totals["steps"] += 1
            totals["input"] += step.usage.input_tokens
            totals["output"] += step.usage.output_tokens
            totals["cache_read"] += step.usage.cache_read_tokens
            totals["cache_write"] += step.usage.cache_write_tokens
            reply = step.text
            conversation.append(
                Message(role="assistant", text=step.text, tool_calls=tuple(step.tool_calls), raw=step.raw)
            )
            if not step.tool_calls:
                break
            results = []
            for call in step.tool_calls:
                run = bridge.ai_tool(family, rules, model, call.name, call.input)
                if run.get("ok"):
                    model = run["model"]
                    outcomes.extend(run.get("outcomes", []))
                    results.append(ToolResult(call.id, call.name, output=run.get("output")))
                else:
                    results.append(ToolResult(call.id, call.name, error=str(run.get("error"))))
            conversation.append(Message(role="tool", tool_results=tuple(results)))
    except Exception:
        if totals["steps"] > 0:
            record(False)
        raise
    updated_dsl = bridge.serialize(family, model)

    # The two messages in separate statements, as the TypeScript service writes them: created_at is the
    # column default, and the conversation is read back in that order.
    assistant_id = str(uuid4())
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO chat_messages (id, diagram_chat_id, role, content) VALUES (:id, :chat, 'user', :content)"
            ),
            {"id": str(uuid4()), "chat": chat_id, "content": message},
        )
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO chat_messages (id, diagram_chat_id, role, content, tool_calls)"
                " VALUES (:id, :chat, 'assistant', :content, :tool_calls)"
            ),
            {
                "id": assistant_id,
                "chat": chat_id,
                "content": reply,
                "tool_calls": json.dumps(outcomes, separators=(",", ":"), ensure_ascii=False),
            },
        )
    # canvas-4k9: linked to the reply, so the chat panel can show each reply's tokens.
    record(True, assistant_id)
    return {
        "assistantMessage": reply,
        "assistantMessageId": assistant_id,
        "updatedDslContent": updated_dsl,
        "toolCalls": outcomes,
        "usage": {
            "inputTokens": totals["input"],
            "outputTokens": totals["output"],
            "totalTokens": totals["input"] + totals["output"],
        },
    }
