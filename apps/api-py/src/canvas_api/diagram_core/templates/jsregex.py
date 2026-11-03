"""JavaScript regex classes the template compilers spell out (Python's differ: `\\s` misses U+FEFF and includes
U+001C-U+001F, `.` matches U+2028/U+2029, `\\d` matches every Unicode digit)."""

from __future__ import annotations

from canvas_api.github.jstext import JS_WHITESPACE

S = f"[{JS_WHITESPACE}]"
"""JavaScript's `\\s`."""
NS = f"[^{JS_WHITESPACE}]"
"""JavaScript's `\\S`."""
DOT = "[^\\n\\r\\u2028\\u2029]"
"""JavaScript's `.` without the s flag."""
D = "[0-9]"
"""JavaScript's `\\d`."""
