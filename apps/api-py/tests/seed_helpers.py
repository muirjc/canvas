"""Comparing whole databases for the seed job tests (test_jobs_seed.py, test_jobs_seed_parity.py)."""

from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy import Engine, inspect, text

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_JSON_COLUMNS = {
    ("standards", "allowed_icon_library_refs"),
    ("standards", "color_palette"),
    ("standards", "font_constraints"),
    ("standards", "kind_rules"),
}


def dump_tables(engine: Engine) -> dict[str, list[tuple[Any, ...]]]:
    """Every table's rows, sorted, with what a re-run or the other service would generate differently normalised:
    timestamps become "set or not", a standard's id its type and version, a persona's id its name, any other uuid
    "<uuid>", booleans 0/1. JSON columns compare as values plus, where stored as text (SQLite), the text itself."""
    with engine.connect() as conn:
        names: dict[str, str] = {}
        for row in conn.execute(text("SELECT id, diagram_type_id, version FROM standards")):
            names[str(row.id)] = f"standard:{row.diagram_type_id}@v{row.version}"
        for row in conn.execute(text("SELECT id, name FROM ai_personas")):
            names[str(row.id)] = f"persona:{row.name}"

        def value(table: str, column: str, raw: Any) -> Any:
            if column.endswith("_at"):
                return raw is not None
            if (table, column) in _JSON_COLUMNS:
                parsed = json.loads(raw) if isinstance(raw, str) else raw
                # On SQLite the text itself must match too (key order, spacing).
                return (json.dumps(parsed, sort_keys=True), raw if isinstance(raw, str) else None)
            if isinstance(raw, bool):
                return int(raw)
            text_value = str(raw) if raw is not None and not isinstance(raw, int | float) else raw
            if isinstance(text_value, str) and _UUID.match(text_value):
                return names.get(text_value, "<uuid>")
            return text_value

        dump: dict[str, list[tuple[Any, ...]]] = {}
        for table in sorted(inspect(conn).get_table_names()):
            columns = [c["name"] for c in inspect(conn).get_columns(table)]
            rows = conn.execute(text(f"SELECT * FROM {table}")).mappings().all()  # noqa: S608 - names from the db
            dump[table] = sorted(
                (tuple((c, value(table, c, r[c])) for c in columns) for r in rows),
                key=repr,
            )
    return dump


def compare_dumps(ts: dict[str, list[tuple[Any, ...]]], py: dict[str, list[tuple[Any, ...]]]) -> None:
    assert sorted(ts) == sorted(py)
    for table in ts:
        assert len(ts[table]) == len(py[table]), table
        assert ts[table] == py[table], table
