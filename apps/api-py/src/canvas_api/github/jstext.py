"""JavaScript string semantics, where the GitHub files must match the TypeScript service byte for byte.

A JavaScript string's length and slice() count UTF-16 code units (an emoji is two), and its `\\s` and
trim() use a fixed whitespace set. A diagram name truncated for a pull request title, for example, has to
end in the same place from both services.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any

#: JavaScript's `\s` (and what trim() removes).
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_TRIM_CHARS = (
    "\t\n\v\f\r \u00a0\u1680" + "".join(map(chr, range(0x2000, 0x200B))) + "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def js_len(text: str) -> int:
    """`text.length`."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def js_slice(text: str, start: int, end: int | None = None) -> str:
    """`text.slice(start, end)` for non-negative indexes. A cut inside a surrogate pair keeps the half, as
    JavaScript does (an unpaired surrogate)."""
    units = text.encode("utf-16-le", errors="surrogatepass")
    chunk = units[start * 2 : None if end is None else end * 2]
    return chunk.decode("utf-16-le", errors="surrogatepass")


def js_utf8(text: str) -> bytes:
    """Node's Buffer.from(text, "utf8"): an unpaired surrogate becomes U+FFFD."""
    units = text.encode("utf-16-le", errors="surrogatepass")
    return units.decode("utf-16-le", errors="replace").encode("utf-8")


def js_trim(text: str) -> str:
    """`text.trim()`."""
    return text.strip(_TRIM_CHARS)


def js_number(value: float) -> str:
    """JavaScript's Number::toString: the shortest digits that round-trip, written as ECMAScript does (plain
    decimal from 1e-6 up to 1e21, exponent form outside that). Python's repr() has the same digits but
    switches to exponent form at 1e-4 and 1e16, and writes the exponent as e-07."""
    if value != value or value in (float("inf"), float("-inf")):
        return "null"  # what JSON.stringify writes for them
    if value == 0:
        return "0"
    sign, digit_tuple, exponent = Decimal(repr(value)).as_tuple()
    if not isinstance(exponent, int):
        raise ValueError(f"not a finite number: {value}")
    digits = "".join(map(str, digit_tuple)).rstrip("0") or "0"
    # The decimal point sits `point` digits in: value = 0.<digits> * 10**point.
    point = exponent + len(digit_tuple)
    count = len(digits)
    if count <= point <= 21:
        text = digits + "0" * (point - count)
    elif 0 < point <= 21:
        text = f"{digits[:point]}.{digits[point:]}"
    elif -6 < point <= 0:
        text = f"0.{'0' * -point}{digits}"
    else:
        power = point - 1
        mantissa = digits if count == 1 else f"{digits[0]}.{digits[1:]}"
        text = f"{mantissa}e{'+' if power >= 0 else '-'}{abs(power)}"
    return f"-{text}" if sign else text


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]{0,9}")


def _js_string(text: str) -> str:
    # JSON.stringify is well-formed: a lone surrogate is written as an escape, never as a raw character.
    quoted = json.dumps(text, ensure_ascii=False)
    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", quoted)


def _js_keys(value: dict[str, Any]) -> list[str]:
    """Property order of a JavaScript object: array-index keys ascending first, then the rest as inserted."""
    indexes = sorted((k for k in value if _ARRAY_INDEX.fullmatch(k) and int(k) < 2**32 - 1), key=int)
    return indexes + [k for k in value if k not in indexes]


def _stringify(value: Any, indent: int | None, depth: int) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, int):
        # JavaScript has one number type: past 2**53 an integer is already rounded.
        return str(value) if abs(value) <= 2**53 else js_number(float(value))
    if isinstance(value, float):
        return js_number(value)
    if isinstance(value, dict):
        items = [
            f"{_js_string(str(k))}:{'' if indent is None else ' '}{_stringify(value[k], indent, depth + 1)}"
            for k in _js_keys(value)
        ]
        brackets = "{}"
    else:
        items = [_stringify(v, indent, depth + 1) for v in value]
        brackets = "[]"
    if not items:
        return brackets
    if indent is None:
        return brackets[0] + ",".join(items) + brackets[1]
    inner = "\n" + " " * (indent * (depth + 1))
    outer = "\n" + " " * (indent * depth)
    return brackets[0] + inner + ("," + inner).join(items) + outer + brackets[1]


def js_stringify(value: Any, indent: int | None = None) -> str:
    """`JSON.stringify(value)` / `JSON.stringify(value, null, indent)`: 2.0 is written "2" (Postgres JSONB can
    hand back 2.0 as a float), numbers use JavaScript's formatting, lone surrogates are escaped, and
    integer-like keys come first."""
    return _stringify(value, indent, 0)
