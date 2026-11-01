"""Timestamps as the TypeScript service writes and returns them, on both databases.

- Postgres hands back a datetime; the TypeScript service returns a JavaScript Date's toJSON(),
  "2026-11-01T09:30:00.123Z" (UTC, milliseconds).
- SQLite stores text. A DEFAULT CURRENT_TIMESTAMP value is "2026-11-01 09:30:00" (UTC, no zone), which
  the TypeScript service rewrites to "2026-11-01T09:30:00Z" (apps/api/src/db/sqlite-timestamp-plugin.ts);
  a value the app wrote itself is already JavaScript ISO and passes through.
- Writing an instant: Postgres takes the datetime; SQLite gets JavaScript ISO text, as the TypeScript
  service's SqliteValueCoercionPlugin binds a Date (so string comparisons between the two still order).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

_SQLITE_TIMESTAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$")


def js_iso(value: datetime) -> str:
    """A JavaScript Date's toISOString(): UTC, milliseconds (truncated, as a Date holds no more)."""
    utc = value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def to_api(value: object) -> str | None:
    """A timestamp column's value as the API returns it."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return js_iso(value)
    if isinstance(value, str):
        match = _SQLITE_TIMESTAMP.match(value)
        return f"{match[1]}T{match[2]}Z" if match else value
    raise TypeError(f"not a timestamp: {value!r}")


def to_db(value: datetime, dialect: str) -> datetime | str:
    """An instant to bind for a timestamp column."""
    return js_iso(value) if dialect == "sqlite" else value


def now_utc() -> datetime:
    return datetime.now(UTC)
