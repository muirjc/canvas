"""The rule-based stand-in for a real AI provider when AI_PROVIDER=mock (apps/api/src/ai/mock-nlu.ts).

Recognises a few fixed phrasings the e2e specs are written against and answers with one tool call or a
fixed reply, so the whole chat pipeline (HTTP, tools, persistence, usage) runs end to end without a real
model. Token usage is an estimate (about 4 characters per token) so usage tracking has non-zero numbers.
"""

from __future__ import annotations

import json
import math
import re
import time
from typing import Any

from canvas_api.ai.models import Message, Step, ToolCall, ToolSpec, Usage

VAGUE_CREATE = re.compile(r"^(create|draw|make|build)\b.*\bdiagram\b", re.IGNORECASE)
CLARIFYING_QUESTION = "Before I draw this, what are the main steps or elements you want included?"
DRAW_NOW = re.compile(r"create the diagram now|go ahead and draw", re.IGNORECASE)
#: Requests the rules below can turn into a drawing (used to replay one on "create the diagram now").
CONCRETE_REQUEST = [
    re.compile(r"add (?:an? )?(?:\S+ )?shape (?:called|named)", re.IGNORECASE),
    re.compile(r"add (?:an? )?[a-z][a-z0-9_]* (?:called|named)", re.IGNORECASE),
]
SHAPE_WORDS = ("rectangle", "rounded-rectangle", "circle", "diamond", "cylinder")
COLOR_WORDS = {
    "red": "#c0392b",
    "green": "#27ae60",
    "blue": "#2980b9",
    "yellow": "#f1c40f",
    "orange": "#e67e22",
    "purple": "#8e44ad",
    "black": "#000000",
    "white": "#ffffff",
    "gray": "#7f8c8d",
    "grey": "#7f8c8d",
}
VISIBILITY_WORDS = {"private": "-", "public": "+", "protected": "#", "package": "~"}
FORMATTED_SUMMARY = "\n".join(
    [
        "Here is a **summary** of the diagram:",
        "",
        "- First point",
        "- Second point with `inline code`",
        "",
        "```",
        "flowchart TD",
        "  A --> B",
        "```",
        "",
        "See <b>this</b> and [the docs](https://example.com/docs).",
    ]
)

_KIND = re.compile(r"add (?:an? )?([a-z][a-z0-9_]*) (?:called|named) ['\"]?([^'\".]+)['\"]?", re.IGNORECASE)
_ADD = re.compile(r"add (?:an? )?(?:(\S+) )?shape (?:called|named) ['\"]?([^'\".]+)['\"]?", re.IGNORECASE)
_CONNECT = re.compile(r"connect ['\"]?([^'\".]+?)['\"]? to ['\"]?([^'\".]+)['\"]?", re.IGNORECASE)
_REMOVE = re.compile(r"remove (?:the )?shape (?:called |named )?['\"]?([^'\".]+)['\"]?", re.IGNORECASE)
_RENAME = re.compile(r"rename ['\"]?([^'\".]+?)['\"]? to ['\"]?([^'\".]+)['\"]?", re.IGNORECASE)
_COLOR = re.compile(
    r"(?:make|color) (?:the )?['\"]?([^'\".]+?)['\"]? ?(?:node |shape )?(" + "|".join(COLOR_WORDS) + r")\b",
    re.IGNORECASE,
)
_ROLE = re.compile(
    r"set (?:the )?role of ['\"]?([^'\".]+?)['\"]? to (person|system|container|component|participant|actor)\b",
    re.IGNORECASE,
)
_ATTRIBUTE = re.compile(r"give ['\"]?([^'\".]+?)['\"]? an attribute (\S+) (\S+?)(?: (PK|FK|UK))?$", re.IGNORECASE)
_CLASS_MEMBERS = re.compile(
    r"give ['\"]?([^'\".]+?)['\"]? an? (private|public|protected|package) (\S+) (\S+) attribute and an?"
    r" (private|public|protected|package) (\S+) method",
    re.IGNORECASE,
)
_RELATION = re.compile(
    r"make (?:the )?connector between ['\"]?([^'\".]+?)['\"]? and ['\"]?([^'\".]+?)['\"]? an?"
    r" (inheritance|composition|aggregation|association|dependency|realization)",
    re.IGNORECASE,
)
_GROUP = re.compile(
    r"group ['\"]?([^'\".]+?)['\"]? and ['\"]?([^'\".]+?)['\"]? into a (?:container|group|boundary|box)"
    r" (?:called |named )?['\"]?([^'\".]+)['\"]?",
    re.IGNORECASE,
)
_ACTIVATE = re.compile(r"^activate ['\"]?([^'\".]+?)['\"]?$", re.IGNORECASE)


def _find_id_by_label(system: str, label: str) -> str | None:
    """A shape's id from its label, read off the "Current shapes" summary in the system prompt."""
    match = re.search(rf'- (\S+): "{re.escape(label)}"', system, re.IGNORECASE)
    return match[1] if match else None


def _find_edge_id(system: str, source_id: str, target_id: str) -> str | None:
    match = re.search(rf"- (\S+): {re.escape(source_id)} -> {re.escape(target_id)}", system)
    return match[1] if match else None


def _prompt(system: str, messages: list[Message]) -> list[dict[str, Any]]:
    """The conversation as the AI SDK hands it to a model, for the token estimate."""
    prompt: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for m in messages:
        if m.role == "user":
            prompt.append({"role": "user", "content": [{"type": "text", "text": m.text}]})
        elif m.role == "assistant":
            parts: list[dict[str, Any]] = [{"type": "text", "text": m.text}] if m.text else []
            parts += [
                {"type": "tool-call", "toolCallId": c.id, "toolName": c.name, "input": c.input} for c in m.tool_calls
            ]
            prompt.append({"role": "assistant", "content": parts})
        else:
            prompt.append(
                {
                    "role": "tool",
                    "content": [
                        {
                            "type": "tool-result",
                            "toolCallId": r.call_id,
                            "toolName": r.name,
                            "output": {"type": "error-text", "value": r.error}
                            if r.error is not None
                            else {"type": "json", "value": r.output},
                        }
                        for r in m.tool_results
                    ],
                }
            )
    return prompt


def _js_length(value: Any) -> int:
    """JSON.stringify(value).length."""
    text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


class MockModel:
    provider = "mock-provider"
    model_id = "mock-model-id"

    def generate(self, system: str, messages: list[Message], tools: list[ToolSpec]) -> Step:
        step = self._respond(system, messages, {t.name for t in tools})
        content: list[dict[str, Any]] = (
            [
                {
                    "type": "tool-call",
                    "toolCallId": c.id,
                    "toolName": c.name,
                    "input": json.dumps(c.input, separators=(",", ":"), ensure_ascii=False),
                }
                for c in step.tool_calls
            ]
            if step.tool_calls
            else [{"type": "text", "text": step.text}]
        )
        step.usage = Usage(
            input_tokens=math.ceil(_js_length(_prompt(system, messages)) / 4),
            output_tokens=math.ceil(_js_length(content) / 4),
        )
        return step

    def _respond(self, system: str, messages: list[Message], tools: set[str]) -> Step:
        # A tool result already came back this turn: finish with a short confirmation, so each user message
        # makes exactly one tool call.
        if messages and messages[-1].role == "tool":
            return _reply("Done.")
        user_texts = [m.text for m in messages if m.role == "user"]
        text = user_texts[-1] if user_texts else ""

        # canvas-rfv: a reply in Markdown, so e2e can check the chat panel formats it.
        if re.fullmatch(r"show a formatted summary", text.strip(), re.IGNORECASE):
            return _reply(FORMATTED_SUMMARY)
        # A test-only hook: echoes the system prompt so e2e can see what reached the model.
        if re.fullmatch(r"what do you know about this diagram\??", text.strip(), re.IGNORECASE):
            return _reply(system)

        # canvas-s3o: Create with AI's planning phase offers no tools; the mock only talks.
        if not tools:
            if VAGUE_CREATE.search(text.strip()):
                return _reply(CLARIFYING_QUESTION)
            return _reply(f"Here's what I'll build: \"{text.strip()}\". Click Create diagram when you're ready.")

        # canvas-s3o: the dialog's Create diagram message acts on the latest concrete request before it.
        if DRAW_NOW.search(text):
            earlier = next((t for t in reversed(user_texts[:-1]) if any(r.search(t) for r in CONCRETE_REQUEST)), None)
            if earlier:
                text = earlier

        def label_id(label: str) -> str:
            return _find_id_by_label(system, label.strip()) or label.strip()

        # canvas-tfr: "add a <kind id> called X" -> addElement, when the standard offers that kind.
        m = _KIND.search(text)
        if m and m[1] != "shape" and "addElement" in tools:
            return _call("addElement", {"kind": m[1].lower(), "label": m[2].strip()})
        m = _ADD.search(text)
        if m:
            shape = m[1] if m[1] in SHAPE_WORDS else "rectangle"
            return _call("addNode", {"shape": shape, "label": m[2].strip()})
        m = _CONNECT.search(text)
        if m:
            source = _find_id_by_label(system, m[1].strip())
            target = _find_id_by_label(system, m[2].strip())
            return _call("addEdge", {"sourceId": source or m[1].strip(), "targetId": target or m[2].strip()})
        m = _REMOVE.search(text)
        if m:
            return _call("removeNode", {"nodeId": label_id(m[1])})
        m = _RENAME.search(text)
        if m:
            return _call("updateNodeLabel", {"nodeId": label_id(m[1]), "label": m[2].strip()})
        m = _COLOR.search(text)
        if m:
            return _call("updateNodeStyle", {"nodeId": label_id(m[1]), "fillColor": COLOR_WORDS[m[2].lower()]})

        # 010-ai-diagram-knowledge: one rule per family-specific tool, each only when this turn offers it.
        m = _ROLE.search(text)
        if m and "setNodeRole" in tools:
            return _call("setNodeRole", {"nodeId": label_id(m[1]), "role": m[2].lower()})
        m = _ATTRIBUTE.search(text)
        if m and "setEntityAttributes" in tools:
            keys = [m[4].upper()] if m[4] else []
            return _call(
                "setEntityAttributes",
                {"nodeId": label_id(m[1]), "attributes": [{"type": m[2], "name": m[3], "keys": keys}]},
            )
        m = _CLASS_MEMBERS.search(text)
        if m and "setClassMembers" in tools:
            return _call(
                "setClassMembers",
                {
                    "nodeId": label_id(m[1]),
                    "members": [
                        {"kind": "attribute", "visibility": VISIBILITY_WORDS[m[2].lower()], "type": m[3], "name": m[4]},
                        {"kind": "method", "visibility": VISIBILITY_WORDS[m[5].lower()], "name": m[6], "params": ""},
                    ],
                },
            )
        m = _RELATION.search(text)
        if m and "setRelationshipKind" in tools:
            edge_id = _find_edge_id(system, label_id(m[1]), label_id(m[2]))
            if edge_id:
                return _call("setRelationshipKind", {"edgeId": edge_id, "umlRelationKind": m[3].lower()})
        m = _GROUP.search(text)
        if m and "groupIntoContainer" in tools:
            return _call("groupIntoContainer", {"nodeIds": [label_id(m[1]), label_id(m[2])], "label": m[3].strip()})
        m = _ACTIVATE.search(text)
        if m and "activateParticipant" in tools:
            return _call("activateParticipant", {"participantId": label_id(m[1])})

        # canvas-ltm: a vague "create a ... diagram" names nothing concrete, so ask first.
        if VAGUE_CREATE.search(text.strip()):
            return _reply(CLARIFYING_QUESTION)
        # canvas-ltm: the dialog's "Just draw it": draw something rather than ask again.
        if DRAW_NOW.search(text) and "addNode" in tools:
            return _call("addNode", {"shape": "rectangle", "label": "Draft step"})
        return _reply("I'm not sure how to help with that.")


def _reply(text: str) -> Step:
    return Step(text=text)


def _call(name: str, input: dict[str, Any]) -> Step:
    return Step(text="", tool_calls=[ToolCall(f"mock-{int(time.time() * 1000)}", name, input)])
