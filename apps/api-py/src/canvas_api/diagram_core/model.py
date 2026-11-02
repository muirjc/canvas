"""The diagram model (packages/diagram-core/src/model/diagram-model.ts). Models are plain dicts shaped exactly
like the TypeScript objects (the same keys; a missing field is a missing key), so they cross the API and the
golden corpus unchanged."""

from __future__ import annotations

import ipaddress
import re
from typing import Any

__all__ = ["create_empty_diagram_model", "is_allowed_link_href", "url_protocol"]

Model = dict[str, Any]


def create_empty_diagram_model(diagram_type_id: str) -> Model:
    return {"diagramTypeId": diagram_type_id, "nodes": [], "edges": [], "containers": []}


# --- links (jmuir-dzd.5) ------------------------------------------------------------------------------
#
# The TypeScript check resolves the href with the WHATWG URL parser against https://relative-path-base.invalid/
# and allows only an http: or https: result, so a browser can never see a `javascript:` (or any other) link,
# however it is disguised. These follow the same standard's steps for the parts that decide the scheme and
# whether parsing fails: leading/trailing C0-control-or-space stripped, tab/newline removed anywhere, the
# scheme read up to the first ":", and for http(s) a host that must be present and valid.

_C0_OR_SPACE = "".join(chr(c) for c in range(0x21))
_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+\-.]*):")
#: Forbidden host code points (URL standard), for the special schemes' (http, https) hosts.
_FORBIDDEN_HOST = (
    set("\x00\t\n\r #/:<>?@[\\]^|%") | {chr(c) for c in range(0x01, 0x20)} | {chr(c) for c in range(0x7F, 0xA0)}
)  # DEL and C1 controls (IDNA rejects them)
_SPECIAL = {"http", "https", "ws", "wss", "ftp", "file"}


def _preprocess(href: str) -> str:
    text = href.strip(_C0_OR_SPACE)
    return text.replace("\t", "").replace("\n", "").replace("\r", "")


def _ipv4_number(part: str) -> int | None:
    """The URL standard's IPv4 number parser: decimal, 0x hex, or leading-0 octal; None when it isn't one."""
    if part == "":
        return None
    base = 10
    digits = part
    if len(part) >= 2 and part[:2] in ("0x", "0X"):
        base, digits = 16, part[2:]
    elif len(part) >= 2 and part[0] == "0":
        base, digits = 8, part[1:]
    if digits == "":
        return 0
    alphabet = "0123456789abcdefABCDEF"[: 22 if base == 16 else base]
    if any(ch not in alphabet for ch in digits):
        return None
    return int(digits, base)


def _is_valid_ipv4_host(host: str) -> bool | None:
    """None when the host doesn't end in a number (so it's a domain); else whether it's a valid IPv4 address."""
    parts = host.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return None
        parts.pop()
    last = parts[-1]
    if _ipv4_number(last) is None and not (last.isascii() and last.isdigit()):
        return None
    if len(parts) > 4:
        return False
    numbers = [_ipv4_number(part) for part in parts]
    if any(n is None for n in numbers):
        return False
    values = [n for n in numbers if n is not None]
    if any(n > 255 for n in values[:-1]):
        return False
    return bool(values[-1] < 256 ** (5 - len(values)))


def _valid_special_host(rest: str) -> bool:
    """The authority after `http(s)://` (slashes and backslashes alike): a non-empty, valid host."""
    authority = re.split(r"[/\\?#]", rest.lstrip("/\\"), maxsplit=1)[0]
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    host = authority
    if host.startswith("["):
        close = host.find("]")
        if close < 0:
            return False
        tail = host[close + 1 :]
        if tail and not (tail.startswith(":") and (tail[1:] == "" or (tail[1:].isascii() and tail[1:].isdigit()))):
            return False
        if tail[1:] and int(tail[1:]) > 65535:
            return False
        inner = host[1:close]
        if "%" in inner:
            return False
        try:
            ipaddress.IPv6Address(inner)
        except ValueError:
            return False
        return True
    host = host.split(":", 1)[0] if ":" in host else host
    port = authority[len(host) + 1 :] if ":" in authority else ""
    if port and not (port.isascii() and port.isdigit()):
        return False
    if port and int(port) > 65535:
        return False
    if not host:
        return False
    # Percent-decoded first; a "%" left over (not followed by two hex digits, or decoded from %25) is forbidden.
    decoded = re.sub(r"%([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), host)
    if any(ch in _FORBIDDEN_HOST for ch in decoded):
        return False
    return _is_valid_ipv4_host(decoded) is not False


def url_protocol(href: str) -> str | None:
    """`new URL(href, base).protocol` without the colon, or None when the URL parser would throw."""
    text = _preprocess(href)
    match = _SCHEME.match(text)
    if not match:
        # No scheme: resolved against the https base. Only a scheme-relative "//" form has a host to check.
        if re.match(r"^[/\\]{2}", text):
            return "https" if _valid_special_host(text[2:]) else None
        return "https"
    scheme = match.group(1).lower()
    rest = text[match.end() :]
    if scheme in _SPECIAL:
        if scheme == "https" and not re.match(r"^[/\\]{2}", rest):
            # Same scheme as the base and no authority: a path relative to the base.
            return "https"
        if scheme == "file":
            return "file"
        return scheme if _valid_special_host(rest) else None
    return scheme


def is_allowed_link_href(href: str) -> bool:
    return url_protocol(href) in ("http", "https")
