"""The AI tools' input schemas: just enough of zod 4 for apps/api/src/ai/diagram-tools.ts.

One definition gives both what the AI SDK derives from a zod schema: the JSON Schema sent to the provider
(`tool_json_schema`, byte for byte as zod's toJSONSchema writes it, key order included) and the check of a tool
call's input (`check_input`), with zod's issues for the common failures -- a missing field, a wrong type, a value
not in an enum, too short an array -- in the order and wording zod reports them. Rarer wording may differ (only the
model reads it). As in zod, unknown keys are dropped and an optional key that's absent stays absent.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, replace
from typing import Any

__all__ = ["Arr", "Bool", "Enum", "Num", "Obj", "Schema", "Str", "check_input", "js_stringify", "tool_json_schema"]

_ABSENT: Any = object()
Issue = dict[str, Any]


@dataclass(frozen=True)
class Schema:
    optional: bool = False
    description: str | None = None

    def opt(self) -> Schema:
        return replace(self, optional=True)

    def describe(self, description: str) -> Schema:
        return replace(self, description=description)

    def json_schema(self) -> dict[str, Any]:
        # zod writes a .describe() on an .optional() wrapper first, and one on the inner schema last.
        own = self._own_schema()
        if self.description is None:
            return own
        if self.optional:
            return {"description": self.description, **own}
        return {**own, "description": self.description}

    def _own_schema(self) -> dict[str, Any]:
        raise NotImplementedError

    def check(self, value: Any, path: list[Any], issues: list[Issue]) -> Any:
        raise NotImplementedError


def _received(value: Any) -> str:
    if value is _ABSENT:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "nan" if isinstance(value, float) and math.isnan(value) else "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _invalid_type(expected: str, value: Any, path: list[Any], issues: list[Issue]) -> None:
    issues.append(
        {
            "expected": expected,
            "code": "invalid_type",
            "path": list(path),
            "message": f"Invalid input: expected {expected}, received {_received(value)}",
        }
    )


@dataclass(frozen=True)
class Str(Schema):
    def _own_schema(self) -> dict[str, Any]:
        return {"type": "string"}

    def check(self, value: Any, path: list[Any], issues: list[Issue]) -> Any:
        if not isinstance(value, str):
            _invalid_type("string", value, path, issues)
        return value


@dataclass(frozen=True)
class Num(Schema):
    def _own_schema(self) -> dict[str, Any]:
        return {"type": "number"}

    def check(self, value: Any, path: list[Any], issues: list[Issue]) -> Any:
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
            _invalid_type("number", value, path, issues)
        return value


@dataclass(frozen=True)
class Bool(Schema):
    def _own_schema(self) -> dict[str, Any]:
        return {"type": "boolean"}

    def check(self, value: Any, path: list[Any], issues: list[Issue]) -> Any:
        if not isinstance(value, bool):
            _invalid_type("boolean", value, path, issues)
        return value


@dataclass(frozen=True)
class Enum(Schema):
    values: tuple[str, ...] = ()

    def _own_schema(self) -> dict[str, Any]:
        return {"type": "string", "enum": list(self.values)}

    def check(self, value: Any, path: list[Any], issues: list[Issue]) -> Any:
        if not (isinstance(value, str) and value in self.values):
            quoted = [js_stringify(v) for v in self.values]
            message = (
                f"Invalid input: expected {quoted[0]}"
                if len(quoted) == 1
                else f"Invalid option: expected one of {'|'.join(quoted)}"
            )
            issue = {"code": "invalid_value", "values": list(self.values), "path": list(path), "message": message}
            issues.append(issue)
        return value


@dataclass(frozen=True)
class Arr(Schema):
    item: Schema = field(default_factory=Str)
    min_items: int | None = None

    def _own_schema(self) -> dict[str, Any]:
        own: dict[str, Any] = {} if self.min_items is None else {"minItems": self.min_items}
        return {**own, "type": "array", "items": self.item.json_schema()}

    def check(self, value: Any, path: list[Any], issues: list[Issue]) -> Any:
        if not isinstance(value, list):
            _invalid_type("array", value, path, issues)
            return value
        parsed = [self.item.check(v, [*path, i], issues) for i, v in enumerate(value)]
        if self.min_items is not None and len(value) < self.min_items:
            issues.append(
                {
                    "origin": "array",
                    "code": "too_small",
                    "minimum": self.min_items,
                    "inclusive": True,
                    "path": list(path),
                    "message": f"Too small: expected array to have >={self.min_items} items",
                }
            )
        return parsed


@dataclass(frozen=True)
class Obj(Schema):
    shape: tuple[tuple[str, Schema], ...] = ()

    @staticmethod
    def of(**shape: Schema) -> Obj:
        return Obj(shape=tuple(shape.items()))

    def _own_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {key: schema.json_schema() for key, schema in self.shape},
            "required": [key for key, schema in self.shape if not schema.optional],
            "additionalProperties": False,
        }

    def check(self, value: Any, path: list[Any], issues: list[Issue]) -> Any:
        if not isinstance(value, dict):
            _invalid_type("object", value, path, issues)
            return value
        parsed: dict[str, Any] = {}
        for key, schema in self.shape:
            item = value.get(key, _ABSENT)
            if item is _ABSENT and schema.optional:
                continue
            parsed[key] = schema.check(item, [*path, key], issues)
        return parsed


def tool_json_schema(schema: Obj) -> dict[str, Any]:
    """The input schema as the AI SDK sends it to a provider."""
    return {"$schema": "http://json-schema.org/draft-07/schema#", **schema.json_schema()}


def _js_value(value: Any) -> Any:
    """A JSON value as JavaScript holds it: an integral float is a plain integer."""
    if isinstance(value, float) and value.is_integer() and abs(value) < 2**53:
        return int(value)
    if isinstance(value, dict):
        return {k: _js_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_js_value(v) for v in value]
    return value


def js_stringify(value: Any, indent: int | None = None) -> str:
    """JSON.stringify(value[, null, indent]) for JSON values."""
    if indent is None:
        return json.dumps(_js_value(value), separators=(",", ":"), ensure_ascii=False)
    return json.dumps(_js_value(value), indent=indent, ensure_ascii=False)


def check_input(name: str, schema: Obj, value: Any) -> tuple[Any, str | None]:
    """(the parsed input, None), or (None, the AI SDK's InvalidToolInputError text)."""
    issues: list[Issue] = []
    parsed = schema.check(value, [], issues)
    if not issues:
        return parsed, None
    return None, (
        f"Invalid input for tool {name}: Type validation failed: Value: {js_stringify(value)}.\n"
        f"Error message: {js_stringify(issues, 2)}"
    )
