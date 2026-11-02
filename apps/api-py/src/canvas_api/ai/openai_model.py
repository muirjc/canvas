"""OpenAI models through the OpenAI SDK's Responses API (apps/api's @ai-sdk/openai provider, whose default it is)."""

from __future__ import annotations

import json
from typing import Any

import openai

from canvas_api.ai.models import Message, Step, ToolCall, ToolSpec, Usage


def to_openai_input(system: str, messages: list[Message]) -> list[Any]:
    items: list[Any] = [{"role": "system", "content": system}]
    for m in messages:
        if m.role == "user":
            items.append({"role": "user", "content": m.text})
        elif m.role == "assistant":
            if m.raw is not None:
                # A step from this turn: its output items as returned (reasoning and function calls included).
                items.extend(m.raw)
            elif m.text:
                items.append({"role": "assistant", "content": m.text})
        else:
            items.extend(
                {
                    "type": "function_call_output",
                    "call_id": r.call_id,
                    "output": r.error
                    if r.error is not None
                    else json.dumps(r.output, separators=(",", ":"), ensure_ascii=False),
                }
                for r in m.tool_results
            )
    return items


def _arguments(text: str | None) -> Any:
    """A function call's arguments. Unreadable JSON is passed on as is: the tool's input check then reports it
    to the model as a failed call, as the AI SDK does."""
    try:
        return json.loads(text or "{}")
    except ValueError:
        return text


class OpenAIModel:
    provider = "openai.responses"

    def __init__(self, api_key: str, model_id: str, client: openai.OpenAI | None = None) -> None:
        self.model_id = model_id
        self._client = client or openai.OpenAI(api_key=api_key)

    def generate(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> Step:
        request: dict[str, Any] = {"model": self.model_id, "input": to_openai_input(system, messages)}
        if tools:
            request["tools"] = [
                {
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.input_schema,
                    "strict": False,
                }
                for t in tools
            ]
        response = self._client.responses.create(**request)
        calls = [
            ToolCall(item.call_id, item.name, _arguments(item.arguments))
            for item in response.output
            if item.type == "function_call"
        ]
        u = response.usage
        usage = Usage()
        if u is not None:
            cached = u.input_tokens_details.cached_tokens if u.input_tokens_details else 0
            usage = Usage(input_tokens=u.input_tokens, output_tokens=u.output_tokens, cache_read_tokens=cached or 0)
        raw = [item.model_dump(exclude_none=True) for item in response.output]
        return Step(text=response.output_text, tool_calls=calls, usage=usage, raw=raw)
