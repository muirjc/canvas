"""YAML the way diagram-core's `yaml` npm package (2.x, its defaults) reads and writes it.

Diagram front matter is YAML, written by whichever service saves the diagram: a diagram saved through Python
must come out byte for byte as one saved through TypeScript, so `dump` is a port of the package's
stringifier (stringify/*.js) for plain JSON-like values -- no comments, anchors or tags, which a JavaScript
object never carries.

`load` reads YAML 1.2 core schema as the package does: `yes`/`no`/`on`/`off` are strings (PyYAML's YAML 1.1
would make them booleans), `012` is twelve, `0o17` and `0x1F` are octal and hex, keys are turned into strings
as a JavaScript object's would be, and a repeated key is an error. Built on PyYAML's SafeLoader with its
implicit types replaced, so nothing new is installed.
"""

from __future__ import annotations

import math
import re
from typing import Any

import yaml

from canvas_api.github.jstext import js_number

__all__ = ["YamlError", "dump", "load"]


class YamlError(ValueError):
    """The YAML can't be read (the package throws; diagram-core lets that through)."""


# --- reading ---------------------------------------------------------------------------------------

_NULL = re.compile(r"^(?:~|[Nn]ull|NULL)?\Z")
_BOOL = re.compile(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)\Z")
_INT_OCT = re.compile(r"^0o[0-7]+\Z")
_INT_DEC = re.compile(r"^[-+]?[0-9]+\Z")
_INT_HEX = re.compile(r"^0x[0-9a-fA-F]+\Z")
_FLOAT_NAN = re.compile(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)\Z")
_FLOAT_EXP = re.compile(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+\Z")
_FLOAT = re.compile(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)\Z")


class _CoreLoader(yaml.SafeLoader):
    """SafeLoader with the YAML 1.2 core schema's implicit types instead of YAML 1.1's."""

    yaml_implicit_resolvers: dict[str | None, list[tuple[str, re.Pattern[str]]]] = {}  # noqa: RUF012 - PyYAML's own class attribute

    #: PyYAML refuses DEL and the C1 controls anywhere in the text; the package reads them (and the dumper
    #: writes a DEL raw inside double quotes).
    NON_PRINTABLE = re.compile("[^\t\n\r\x20-\x7e\x7f-\x9f\xa0-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")  # type: ignore[misc]

    def scan_plain_spaces(self, indent: int, start_mark: Any) -> list[str] | None:
        """PyYAML's own, but a tab between the words of a plain scalar is allowed (YAML 1.2, and the package
        writes one there: `label: a<TAB>b`); PyYAML stops at it and then fails on the tab."""
        chunks: list[str] = []
        length = 0
        while self.peek(length) in " \t":
            length += 1
        whitespaces = self.prefix(length)
        self.forward(length)
        ch = self.peek()
        if ch in "\r\n\x85\u2028\u2029":
            line_break = self.scan_line_break()  # type: ignore[no-untyped-call]
            self.allow_simple_key = True
            prefix = self.prefix(3)
            if prefix in ("---", "...") and self.peek(3) in "\0 \t\r\n\x85\u2028\u2029":
                return None
            breaks = []
            while self.peek() in " \t\r\n\x85\u2028\u2029":
                if self.peek() in " \t":
                    self.forward()
                else:
                    breaks.append(self.scan_line_break())  # type: ignore[no-untyped-call]
                    prefix = self.prefix(3)
                    if prefix in ("---", "...") and self.peek(3) in "\0 \t\r\n\x85\u2028\u2029":
                        return None
            if line_break != "\n":
                chunks.append(line_break)
            elif not breaks:
                chunks.append(" ")
            chunks.extend(breaks)
        elif whitespaces:
            chunks.append(whitespaces)
        return chunks

    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=True)
            marker = _js_key(key)
            if marker in seen:
                raise yaml.constructor.ConstructorError(None, None, "Map keys must be unique", key_node.start_mark)
            seen.add(marker)
        return {
            _js_key(self.construct_object(k, deep=deep)): self.construct_object(v, deep=deep) for k, v in node.value
        }


def _add(tag: str, pattern: re.Pattern[str], first: str | list[str | None]) -> None:
    _CoreLoader.add_implicit_resolver(tag, pattern, list(first))


_add("tag:yaml.org,2002:null", _NULL, ["~", "n", "N", ""])
_add("tag:yaml.org,2002:bool", _BOOL, "tTfF")
_add("tag:yaml.org,2002:int", re.compile(f"{_INT_OCT.pattern}|{_INT_HEX.pattern}|{_INT_DEC.pattern}"), "-+0123456789")
_add(
    "tag:yaml.org,2002:float",
    re.compile(f"{_FLOAT_NAN.pattern}|{_FLOAT_EXP.pattern}|{_FLOAT.pattern}"),
    "-+.0123456789",
)


def _construct_null(_loader: yaml.SafeLoader, _node: yaml.ScalarNode) -> None:
    return None


def _construct_bool(loader: yaml.SafeLoader, node: yaml.ScalarNode) -> bool:
    return str(loader.construct_scalar(node))[0] in "tT"


def _construct_int(loader: yaml.SafeLoader, node: yaml.ScalarNode) -> int | float:
    text = str(loader.construct_scalar(node))
    if text.startswith("0o"):
        value = int(text[2:], 8)
    elif text.startswith("0x"):
        value = int(text[2:], 16)
    else:
        value = int(text, 10)
    # A JavaScript number: an integer past 2**53 loses precision as it does there.
    return value if abs(value) <= 2**53 else float(value)


def _construct_float(loader: yaml.SafeLoader, node: yaml.ScalarNode) -> float:
    text = str(loader.construct_scalar(node))
    if _FLOAT_NAN.match(text):
        if text[-3:].lower() == "nan":
            return math.nan
        return -math.inf if text[0] == "-" else math.inf
    return float(text)


_CoreLoader.add_constructor("tag:yaml.org,2002:null", _construct_null)
_CoreLoader.add_constructor("tag:yaml.org,2002:bool", _construct_bool)
_CoreLoader.add_constructor("tag:yaml.org,2002:int", _construct_int)
_CoreLoader.add_constructor("tag:yaml.org,2002:float", _construct_float)


def _js_key(key: Any) -> Any:
    """A mapping key as a JavaScript object holds it: a string (null becomes "")."""
    if key is None:
        return ""
    if isinstance(key, bool):
        return "true" if key else "false"
    if isinstance(key, int):
        return str(key)
    if isinstance(key, float):
        return (
            js_number(key)
            if math.isfinite(key)
            else ("NaN" if math.isnan(key) else ("Infinity" if key > 0 else "-Infinity"))
        )
    if isinstance(key, str):
        return key
    if isinstance(key, list | tuple):
        return ",".join("" if k is None else str(_js_key(k)) for k in key)
    return "[object Object]"


#: YAML 1.1 (PyYAML) breaks lines at NEL, LS and PS; YAML 1.2 (the package) treats them as ordinary
#: characters. They stand in as Unicode noncharacters (never real text) while PyYAML reads.
_NOT_BREAKS = {"\x85": "\ufdd0", "\u2028": "\ufdd1", "\u2029": "\ufdd2"}
_BREAKS_BACK = {v: k for k, v in _NOT_BREAKS.items()}
_HIDE = str.maketrans(_NOT_BREAKS)
_SHOW = str.maketrans(_BREAKS_BACK)


def _restore(value: Any) -> Any:
    if isinstance(value, str):
        return value.translate(_SHOW)
    if isinstance(value, dict):
        return {_restore(k): _restore(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_restore(v) for v in value]
    return value


def load(text: str) -> Any:
    """YAML.parse(text): one document, YAML 1.2 core schema, JavaScript keys."""
    try:
        return _restore(yaml.load(text.translate(_HIDE), Loader=_CoreLoader))  # noqa: S506 - SafeLoader subclass
    except yaml.YAMLError as error:
        raise YamlError(str(error)) from error


# --- writing ---------------------------------------------------------------------------------------

LINE_WIDTH = 80
MIN_CONTENT_WIDTH = 20
DOUBLE_QUOTED_MIN_MULTILINE_LENGTH = 40
INDENT_STEP = "  "
FOLD_FLOW, FOLD_BLOCK, FOLD_QUOTED = "flow", "block", "quoted"

_FORCE_DOUBLE = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\ud800-\udfff]")
_PLAIN_FORBIDDEN = re.compile(r"^[\n\t ,\[\]{}#&*!|>'\"%@`]|^[?-]\Z|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]\Z")
_DOCUMENT_MARKER = re.compile(r"^(%|---|\.\.\.)", re.MULTILINE)
#: The core schema's default tags other than str: a plain string matching one would read back as that type.
_NOT_STRING = (_NULL, _BOOL, _INT_OCT, _INT_DEC, _INT_HEX, _FLOAT_NAN, _FLOAT_EXP, _FLOAT)


def _ulen(text: str) -> int:
    """JavaScript's .length: UTF-16 code units."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


class _Ctx:
    """The parts of the package's stringify context these values use."""

    __slots__ = ("all_null_values", "force_block_indent", "implicit_key", "in_flow", "indent", "indent_at_start")

    def __init__(self) -> None:
        self.indent = ""
        self.implicit_key = False
        self.in_flow: bool | None = None
        self.indent_at_start: int | None = None
        self.force_block_indent = False
        self.all_null_values = False

    def copy(self, **changes: Any) -> _Ctx:
        out = _Ctx()
        for name in self.__slots__:
            setattr(out, name, getattr(self, name))
        for name, value in changes.items():
            setattr(out, name, value)
        return out


def _fold_flow_lines(
    text: str, indent: str, mode: str, indent_at_start: int | None, on_overflow: list[bool] | None = None
) -> str:
    """foldFlowLines.js."""
    line_width, min_content_width = LINE_WIDTH, MIN_CONTENT_WIDTH
    end_step = max(1 + min_content_width, 1 + line_width - len(indent))
    if _ulen(text) <= end_step:
        return text
    # The algorithm indexes UTF-16 code units; work on a list of them.
    units = _units(text)
    n = len(units)
    folds: list[int] = []
    escaped_folds: set[int] = set()
    end = line_width - len(indent)
    if isinstance(indent_at_start, int):
        if indent_at_start > line_width - max(2, min_content_width):
            folds.append(0)
        else:
            end = line_width - indent_at_start
    split: int | None = None
    prev: str | None = None
    overflow = False
    i = -1
    esc_start = -1
    esc_end = -1
    if mode == FOLD_BLOCK:
        i = _consume_more_indented_lines(units, i, len(indent))
        if i != -1:
            end = i + end_step

    def at(k: int) -> str | None:
        return units[k] if 0 <= k < n else None

    i += 1
    ch = at(i)
    while ch:
        if mode == FOLD_QUOTED and ch == "\\":
            esc_start = i
            nxt = at(i + 1)
            i += 3 if nxt == "x" else 5 if nxt == "u" else 9 if nxt == "U" else 1
            esc_end = i
        if ch == "\n":
            if mode == FOLD_BLOCK:
                i = _consume_more_indented_lines(units, i, len(indent))
            end = i + len(indent) + end_step
            split = None
        else:
            if ch == " " and prev and prev not in (" ", "\n", "\t"):
                nxt = at(i + 1)
                if nxt and nxt not in (" ", "\n", "\t"):
                    split = i
            if i >= end:
                if split:
                    folds.append(split)
                    end = split + end_step
                    split = None
                elif mode == FOLD_QUOTED:
                    while prev in (" ", "\t"):
                        prev = ch
                        i += 1
                        ch = at(i)
                        overflow = True
                    j = i - 2 if i > esc_end + 1 else esc_start - 1
                    if j in escaped_folds:
                        return text
                    folds.append(j)
                    escaped_folds.add(j)
                    end = j + end_step
                    split = None
                else:
                    overflow = True
        prev = ch
        i += 1
        ch = at(i)
    if overflow and on_overflow is not None:
        on_overflow.append(True)
    if not folds:
        return text
    res = "".join(units[: folds[0]])
    for k, fold in enumerate(folds):
        stop = folds[k + 1] if k + 1 < len(folds) and folds[k + 1] else n
        if fold == 0:
            res = f"\n{indent}{''.join(units[:stop])}"
        else:
            if mode == FOLD_QUOTED and fold in escaped_folds:
                res += f"{units[fold]}\\"
            res += f"\n{indent}{''.join(units[fold + 1 : stop])}"
    return res


def _units(text: str) -> list[str]:
    """The string as UTF-16 code units (a lone surrogate stays a character of its own)."""
    raw = text.encode("utf-16-le", errors="surrogatepass")
    return [raw[k : k + 2].decode("utf-16-le", errors="surrogatepass") for k in range(0, len(raw), 2)]


def _consume_more_indented_lines(units: list[str], i: int, indent: int) -> int:
    n = len(units)

    def at(k: int) -> str | None:
        return units[k] if 0 <= k < n else None

    end = i
    start = i + 1
    ch = at(start)
    while ch in (" ", "\t"):
        if i < start + indent:
            i += 1
            ch = at(i)
        else:
            while True:
                i += 1
                ch = at(i)
                if not (ch and ch != "\n"):
                    break
            end = i
            start = i + 1
            ch = at(start)
    return end


def _json_string(value: str) -> str:
    """JSON.stringify(value) for a string (lone surrogates escaped, as JavaScript writes them)."""
    out = ['"']
    for unit in _units(value):
        code = ord(unit)
        if unit == '"':
            out.append('\\"')
        elif unit == "\\":
            out.append("\\\\")
        elif unit == "\b":
            out.append("\\b")
        elif unit == "\f":
            out.append("\\f")
        elif unit == "\n":
            out.append("\\n")
        elif unit == "\r":
            out.append("\\r")
        elif unit == "\t":
            out.append("\\t")
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            out.append(f"\\u{code:04x}")
        else:
            out.append(unit)
    out.append('"')
    # Rejoin surrogate pairs that were valid (they were kept as two units above).
    return "".join(out).encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="surrogatepass")


def _double_quoted(value: str, ctx: _Ctx) -> str:
    json_units = _units(_json_string(value))
    n = len(json_units)

    def at(k: int) -> str | None:
        return json_units[k] if 0 <= k < n else None

    def sl(a: int, b: int | None = None) -> str:
        return "".join(json_units[a:b])

    indent = ctx.indent or ("  " if _DOCUMENT_MARKER.search(value) else "")
    out = ""
    start = 0
    i = 0
    ch = at(i)
    while ch:
        if ch == " " and at(i + 1) == "\\" and at(i + 2) == "n":
            out += sl(start, i) + "\\ "
            i += 1
            start = i
            ch = "\\"
        if ch == "\\":
            nxt = at(i + 1)
            if nxt == "u":
                out += sl(start, i)
                code = sl(i + 2, i + 6)
                special = {
                    "0000": "\\0",
                    "0007": "\\a",
                    "000b": "\\v",
                    "001b": "\\e",
                    "0085": "\\N",
                    "00a0": "\\_",
                    "2028": "\\L",
                    "2029": "\\P",
                }
                if code in special:
                    out += special[code]
                elif code[:2] == "00":
                    out += "\\x" + code[2:]
                else:
                    out += sl(i, i + 6)
                i += 5
                start = i + 1
            elif nxt == "n":
                if ctx.implicit_key or at(i + 2) == '"' or n < DOUBLE_QUOTED_MIN_MULTILINE_LENGTH:
                    i += 1
                else:
                    out += sl(start, i) + "\n\n"
                    while at(i + 2) == "\\" and at(i + 3) == "n" and at(i + 4) != '"':
                        out += "\n"
                        i += 2
                    out += indent
                    if at(i + 2) == " ":
                        out += "\\"
                    i += 1
                    start = i + 1
            else:
                i += 1
        i += 1
        ch = at(i)
    result = out + sl(start) if start else sl(0)
    if ctx.implicit_key:
        return result
    return _fold_flow_lines(result, indent, FOLD_QUOTED, ctx.indent_at_start)


def _single_quoted(value: str, ctx: _Ctx) -> str:
    if (ctx.implicit_key and "\n" in value) or re.search(r"[ \t]\n|\n[ \t]", value):
        return _double_quoted(value, ctx)
    indent = ctx.indent or ("  " if _DOCUMENT_MARKER.search(value) else "")
    res = "'" + re.sub(r"\n+", lambda m: f"{m.group(0)}\n{indent}", value.replace("'", "''")) + "'"
    if ctx.implicit_key:
        return res
    return _fold_flow_lines(res, indent, FOLD_FLOW, ctx.indent_at_start)


def _quoted(value: str, ctx: _Ctx) -> str:
    has_double = '"' in value
    has_single = "'" in value
    if has_double and not has_single:
        return _single_quoted(value, ctx)
    return _double_quoted(value, ctx)


def _line_length_over_limit(text: str, indent_length: int) -> bool:
    limit = LINE_WIDTH - indent_length
    units = _units(text)
    n = len(units)
    if n <= limit:
        return False
    start = 0
    for i in range(n):
        if units[i] == "\n":
            if i - start > limit:
                return True
            start = i + 1
            if n - start <= limit:
                return False
    return True


def _block(value: str, ctx: _Ctx) -> str:
    """blockString: literal (|) or folded (>) block scalar."""
    if re.search(r"\n[\t ]+\Z", value):
        return _quoted(value, ctx)
    indent = ctx.indent or ("  " if ctx.force_block_indent or _DOCUMENT_MARKER.search(value) else "")
    literal = not _line_length_over_limit(value, len(indent))
    if not value:
        return "|\n" if literal else ">\n"
    end_start = len(value)
    while end_start > 0 and value[end_start - 1] in "\n\t ":
        end_start -= 1
    end = value[end_start:]
    end_nl = end.find("\n")
    if end_nl == -1:
        chomp = "-"
    elif value == end or end_nl != len(end) - 1:
        chomp = "+"
    else:
        chomp = ""
    if end:
        value = value[: -len(end)]
        if end.endswith("\n"):
            end = end[:-1]
        end = re.sub(r"(^|(?<!\n))\n+(?!\n|\Z)", lambda m: f"{m.group(0)}{indent}", end)
    start_with_space = False
    start_nl = -1
    start_end = 0
    while start_end < len(value):
        ch = value[start_end]
        if ch == " ":
            start_with_space = True
        elif ch == "\n":
            start_nl = start_end
        else:
            break
        start_end += 1
    start = value[: start_nl + 1 if start_nl < start_end else start_end]
    if start:
        value = value[len(start) :]
        start = re.sub(r"\n+", lambda m: f"{m.group(0)}{indent}", start)
    header = ("2" if indent else "1") if start_with_space else ""
    header += chomp
    if not literal:
        folded = re.sub(r"\n+", lambda m: "\n" + m.group(0), value)
        folded = re.sub(
            r"(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?", lambda m: (m.group(1) or "") + (m.group(2) or ""), folded
        )
        folded = re.sub(r"\n+", lambda m: f"{m.group(0)}{indent}", folded)
        overflowed: list[bool] = []
        body = _fold_flow_lines(f"{start}{folded}{end}", indent, FOLD_BLOCK, len(indent), overflowed)
        if not overflowed:
            return f">{header}\n{indent}{body}"
    value = re.sub(r"\n+", lambda m: f"{m.group(0)}{indent}", value)
    return f"|{header}\n{indent}{start}{value}{end}"


def _plain(value: str, ctx: _Ctx) -> str:
    if (ctx.implicit_key and "\n" in value) or (ctx.in_flow and re.search(r"[\[\]{},]", value)):
        return _quoted(value, ctx)
    if _PLAIN_FORBIDDEN.search(value):
        if ctx.implicit_key or ctx.in_flow or "\n" not in value:
            return _quoted(value, ctx)
        return _block(value, ctx)
    if not ctx.implicit_key and not ctx.in_flow and "\n" in value:
        # Where allowed, a multi-line string gets a block scalar.
        return _block(value, ctx)
    if _DOCUMENT_MARKER.search(value):
        if ctx.indent == "":
            ctx.force_block_indent = True
            return _block(value, ctx)
        if ctx.implicit_key and ctx.indent == INDENT_STEP:
            return _quoted(value, ctx)
    text = re.sub(r"\n+", lambda m: f"{m.group(0)}\n{ctx.indent}", value)
    if any(p.search(text) for p in _NOT_STRING):
        return _quoted(value, ctx)
    if ctx.implicit_key:
        return text
    return _fold_flow_lines(text, ctx.indent, FOLD_FLOW, ctx.indent_at_start)


def _string(value: str, ctx: _Ctx) -> str:
    if _FORCE_DOUBLE.search(value):
        return _double_quoted(value, ctx)
    return _plain(value, ctx)


def _number(value: float | int) -> str:
    if isinstance(value, float):
        if math.isnan(value):
            return ".nan"
        if math.isinf(value):
            return "-.inf" if value < 0 else ".inf"
        if value == 0 and math.copysign(1, value) < 0:
            return "-0"
        return js_number(value)
    return str(value)


def _is_collection(value: Any) -> bool:
    return isinstance(value, dict | list | tuple)


def _scalar(value: Any, ctx: _Ctx) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int | float):
        return _number(value)
    return _string(str(value), ctx)


def _stringify(value: Any, ctx: _Ctx) -> str:
    if isinstance(value, dict):
        return _map(value, ctx)
    if isinstance(value, list | tuple):
        return _seq(list(value), ctx)
    return _scalar(value, ctx)


_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")


def js_key_order(keys: list[str]) -> list[str]:
    """Object.keys order: keys that are array indexes first, in numeric order, then the rest as added."""
    index_keys = sorted((k for k in keys if _ARRAY_INDEX.fullmatch(k) and int(k) < 2**32 - 1), key=int)
    return index_keys + [k for k in keys if not (_ARRAY_INDEX.fullmatch(k) and int(k) < 2**32 - 1)]


def _pairs(value: dict[Any, Any]) -> list[tuple[str, Any]]:
    """A JavaScript object's entries in Object.keys order."""
    by_key = {str(k): v for k, v in value.items()}
    return [(k, by_key[k]) for k in js_key_order(list(by_key))]


def _map(value: dict[Any, Any], ctx: _Ctx) -> str:
    pairs = _pairs(value)
    if ctx.in_flow:
        return _flow(
            [_pair(k, v, ctx.copy(indent=ctx.indent + INDENT_STEP, in_flow=True)) for k, v in pairs], "{", "}", ctx
        )
    # (The package's `? key` form for an all-null map never applies here: its pair values are nodes,
    # never a bare null.)
    item_ctx = ctx.copy(indent=ctx.indent or "")
    lines = [_pair(k, v, item_ctx) for k, v in pairs]
    if not lines:
        return "{}"
    return _join_block(lines, ctx.indent)


def _seq(items: list[Any], ctx: _Ctx) -> str:
    if ctx.in_flow:
        return _flow(
            [_stringify(item, ctx.copy(indent=ctx.indent + INDENT_STEP, in_flow=True)) for item in items], "[", "]", ctx
        )
    item_ctx = ctx.copy(indent=(ctx.indent or "") + "  ")
    lines = ["- " + _stringify(item, item_ctx.copy()) for item in items]
    if not lines:
        return "[]"
    return _join_block(lines, ctx.indent)


def _join_block(lines: list[str], indent: str) -> str:
    out = lines[0]
    for line in lines[1:]:
        out += f"\n{indent}{line}" if line else "\n"
    return out


def _flow(items: list[str], start: str, end: str, ctx: _Ctx) -> str:
    if not items:
        return start + end
    lines = [f"{s}," if k < len(items) - 1 else s for k, s in enumerate(items)]
    req_newline = any("\n" in s for s in items)
    if not req_newline:
        length = sum(_ulen(line) + 2 for line in lines) + 2
        req_newline = length > LINE_WIDTH
    if req_newline:
        out = start
        for line in lines:
            out += f"\n{INDENT_STEP}{ctx.indent}{line}" if line else "\n"
        return f"{out}\n{ctx.indent}{end}"
    return f"{start} {' '.join(lines)} {end}"


def _pair(key: str, value: Any, ctx: _Ctx) -> str:
    """stringifyPair.js for a string key."""
    pair_ctx = ctx.copy(all_null_values=False, implicit_key=not ctx.all_null_values, indent=ctx.indent + INDENT_STEP)
    key_str = _string(key, pair_ctx)
    explicit_key = False
    if not pair_ctx.in_flow and _ulen(key_str) > 1024:
        explicit_key = True
    if pair_ctx.in_flow:
        if ctx.all_null_values or value is None:
            return "?" if key_str == "" else (f"? {key_str}" if explicit_key else key_str)
    elif ctx.all_null_values or (value is None and explicit_key):
        return f"? {key_str}"
    key_str = f"? {key_str}\n{ctx.indent}:" if explicit_key else f"{key_str}:"
    value_ctx = pair_ctx.copy(implicit_key=False)
    if not explicit_key and not _is_collection(value):
        value_ctx.indent_at_start = _ulen(key_str) + 1
    value_str = _stringify(value, value_ctx)
    ws = " "
    if not explicit_key and _is_collection(value):
        has_newline = "\n" in value_str
        flow = value_ctx.in_flow if value_ctx.in_flow is not None else len(value) == 0
        if has_newline or not flow:
            ws = f"\n{value_ctx.indent}"
    elif value_str == "" or value_str.startswith("\n"):
        ws = ""
    return key_str + ws + value_str


def dump(value: Any) -> str:
    """YAML.stringify(value) with the package's defaults (a trailing newline included)."""
    return _stringify(_drop_undefined(value), _Ctx()) + "\n"


def _drop_undefined(value: Any) -> Any:
    """The values written are JSON-shaped (a model as it crosses the API): None is JSON's null, written as
    null. Parsers' own None-for-undefined never gets here: to_js_json drops those fields first."""
    if isinstance(value, dict):
        return {k: _drop_undefined(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_drop_undefined(v) for v in value]
    return value
