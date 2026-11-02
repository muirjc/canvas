"""Claude through the Anthropic SDK (apps/api's @ai-sdk/anthropic provider)."""

from __future__ import annotations

import json
from typing import Any

import anthropic

from canvas_api.ai.models import Message, Step, ToolCall, ToolSpec, Usage

#: Room for a reply plus its tool calls; non-streaming, so it stays well inside the SDK's request timeout.
MAX_TOKENS = 16000


def _tool_result_content(output: Any) -> str:
    # The AI SDK sends a JSON tool output as its JSON.stringify text.
    return json.dumps(output, separators=(",", ":"), ensure_ascii=False)


def to_anthropic_messages(messages: list[Message]) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "user":
            converted.append({"role": "user", "content": [{"type": "text", "text": m.text}]})
        elif m.role == "assistant":
            if m.raw is not None:
                # A step from this turn: its content blocks as Claude returned them (thinking included).
                converted.append({"role": "assistant", "content": m.raw})
            elif m.text:
                # Earlier turns are stored as text only. An empty reply has no content to send (the API
                # rejects empty text blocks), so it is left out.
                converted.append({"role": "assistant", "content": [{"type": "text", "text": m.text}]})
        else:
            converted.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": r.call_id,
                            "content": r.error if r.error is not None else _tool_result_content(r.output),
                            **({"is_error": True} if r.error is not None else {}),
                        }
                        for r in m.tool_results
                    ],
                }
            )
    return converted


class AnthropicModel:
    provider = "anthropic.messages"

    def __init__(self, api_key: str, model_id: str, client: anthropic.Anthropic | None = None) -> None:
        self.model_id = model_id
        self._client = client or anthropic.Anthropic(api_key=api_key)

    def generate(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> Step:
        request: dict[str, Any] = {
            "model": self.model_id,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": to_anthropic_messages(messages),
        }
        if tools:
            request["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.input_schema} for t in tools
            ]
        response = self._client.messages.create(**request)
        text = "".join(block.text for block in response.content if block.type == "text")
        calls = [ToolCall(block.id, block.name, block.input) for block in response.content if block.type == "tool_use"]
        u = response.usage
        cache_read = u.cache_read_input_tokens or 0
        cache_write = u.cache_creation_input_tokens or 0
        usage = Usage(
            input_tokens=u.input_tokens + cache_read + cache_write,
            output_tokens=u.output_tokens,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
        )
        # The blocks themselves go back on the next step, so nothing Claude needs (thinking) is lost.
        return Step(text=text, tool_calls=calls, usage=usage, raw=list(response.content))
