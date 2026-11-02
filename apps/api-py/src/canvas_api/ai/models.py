"""The language model a chat turn talks to, behind one small interface (apps/api's LanguageModel from the AI SDK).

A turn is a list of `Message`s in a provider-neutral form. Each provider (anthropic_model.py, openai_model.py,
mock_model.py) turns it into its own request, makes one call, and answers with a `Step`: the text, the tool
calls and the tokens. The loop in chat.py runs the tools and calls again until the model stops asking for
them, as the AI SDK's generateText does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    input: Any


@dataclass(frozen=True)
class ToolResult:
    call_id: str
    name: str
    #: The tool's output (sent as JSON), or None when it failed.
    output: Any = None
    #: Why the call failed (bad input, unknown tool, an error in the tool), sent to the model as an error result.
    error: str | None = None


@dataclass(frozen=True)
class Message:
    role: Literal["user", "assistant", "tool"]
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    tool_results: tuple[ToolResult, ...] = ()
    #: The provider's own form of an assistant step (Anthropic content blocks, OpenAI output items), replayed
    #: as is within the turn so nothing the provider needs back (thinking, reasoning) is lost.
    raw: Any = None


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    #: JSON Schema, as the AI SDK sends it (from the bridge's ai-tools op).
    input_schema: dict[str, Any]


@dataclass
class Usage:
    #: All input tokens, cached ones included (the AI SDK's inputTokens).
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class Step:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    raw: Any = None


class LanguageModel(Protocol):
    #: Recorded with each turn's usage and used to price it, as the AI SDK names them ("anthropic.messages",
    #: "openai.responses", "mock-provider").
    provider: str
    model_id: str

    def generate(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> Step: ...


class UnconfiguredAiProviderError(Exception):
    pass


DEFAULT_MODEL_ID = {"anthropic": "claude-sonnet-5", "openai": "gpt-4o"}


def default_model_id(provider: str | None, configured: str | None) -> str | None:
    """The model a chat uses when the admin hasn't chosen one (canvas-tj1)."""
    if provider in DEFAULT_MODEL_ID:
        return configured or DEFAULT_MODEL_ID[provider]
    if provider == "mock":
        return "mock"
    return None
