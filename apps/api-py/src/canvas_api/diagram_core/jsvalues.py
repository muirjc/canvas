"""JavaScript value semantics diagram-core relies on: Number(), Number.parseFloat, and the JSON a model
becomes (a JavaScript number has no separate integer type, an absent field is left out, NaN is null)."""

from __future__ import annotations

import math
import re
from typing import Any

from canvas_api.github.jstext import JS_WHITESPACE, js_number, js_trim

__all__ = ["js_number_value", "js_parse_float", "js_parse_int", "js_template", "js_truthy", "to_js_json"]

_LEADING_SPACE = re.compile(f"^[{JS_WHITESPACE}]+")
_DECIMAL_PREFIX = re.compile(r"^[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
_INT_PREFIX = re.compile(r"^[+-]?[0-9]+")
_STR_NUMBER = re.compile(r"^[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$")


def js_parse_float(text: str) -> float:
    """Number.parseFloat(text): the longest decimal prefix after leading whitespace, else NaN."""
    match = _DECIMAL_PREFIX.match(_LEADING_SPACE.sub("", text))
    if not match:
        return math.nan
    token = match.group(0)
    if token.lstrip("+-") == "Infinity":
        return -math.inf if token.startswith("-") else math.inf
    return float(token)


def js_parse_int(text: str) -> float:
    """Number.parseInt(text, 10): NaN when there are no digits."""
    match = _INT_PREFIX.match(_LEADING_SPACE.sub("", text))
    return float(int(match.group(0))) if match else math.nan


def js_number_value(value: Any) -> float:
    """Number(value)."""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        text = js_trim(value)
        if text == "":
            return 0.0
        lowered = text.lower()
        for prefix, digits, base in (("0x", "[0-9a-fA-F]+", 16), ("0o", "[0-7]+", 8), ("0b", "[01]+", 2)):
            if lowered.startswith(prefix):
                # Digits only: Python's int() would also take "_", a sign or spaces.
                if not re.fullmatch(digits, text[2:]):
                    return math.nan
                try:
                    return float(int(text[2:], base))
                except OverflowError:
                    return math.inf
        if _STR_NUMBER.match(text):
            body = text.lstrip("+-")
            if body == "Infinity":
                return -math.inf if text.startswith("-") else math.inf
            return float(text)
        return math.nan
    if isinstance(value, list):
        if not value:
            return 0.0
        if len(value) == 1:
            return js_number_value(_js_string(value[0]))
        return math.nan
    return math.nan


def _js_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return ",".join(_js_string(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def js_truthy(value: Any) -> bool:
    """JavaScript truthiness: an empty object or array is truthy, NaN is falsy."""
    if isinstance(value, dict | list):
        return True
    if isinstance(value, float) and value != value:
        return False
    return bool(value)


def js_template(value: Any) -> str:
    """`${value}` in a JavaScript template literal, for a value that came from JSON: None is null (pass
    UNDEFINED_TEXT yourself where the field was absent), numbers as JavaScript writes them."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        number = float(value)
        if number != number:
            return "NaN"
        if number in (math.inf, -math.inf):
            return "Infinity" if number > 0 else "-Infinity"
        return js_number(number)
    if isinstance(value, list):
        return ",".join("" if v is None else js_template(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def to_js_json(value: Any) -> Any:
    """A model as JSON.stringify would see it: integral floats become ints (JavaScript writes 40, not 40.0),
    NaN and infinities become null (kept), a None field is left out (in a parser's own dicts None stands for
    `undefined`), tuples become lists. The result is JSON-shaped: None in it is JSON's null."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value) if value.is_integer() and abs(value) < 2**53 else value
    if isinstance(value, int):
        return value
    if isinstance(value, dict):
        return {k: to_js_json(v) for k, v in value.items() if v is not None}
    if isinstance(value, list | tuple):
        return [to_js_json(v) for v in value]
    return value
