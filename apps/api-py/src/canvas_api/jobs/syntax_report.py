"""Mermaid syntax dry run (canvas-7p3y): reads every saved diagram with THIS build's diagram-core and lists the
ones it can't open, and the ones whose saved text it would write differently on the next save. Run it with the new code
BEFORE releasing a change to the Mermaid syntax Canvas reads or writes (docs/admin-guide/operations.md, "Moving to a
newer Mermaid version"). Local databases only for now: the Azure database is private to its VNet (decided with the
user: add an Azure job when a real syntax change needs one). Read-only: it runs no migrations and changes nothing.

Usage:
  python -m canvas_api.jobs.syntax_report           # a summary, then one line per diagram that needs a look
  python -m canvas_api.jobs.syntax_report --json    # the same as JSON, for a script or a ticket
Exit status: 0 when every diagram opens, 1 when any can't (a rewrite on the next save alone is not a failure).
Env: DB_CLIENT (postgres | sqlite), DATABASE_URL, SESSION_SECRET (unused, but Settings requires it).
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy import Connection, text

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.diagram_core import DiagramCore, DiagramCoreError

# Every diagram that isn't in the bin and isn't an unsaved AI draft, with the text of its current version.
_DIAGRAMS = text(
    "SELECT d.id, d.name, d.project_id, dt.dsl_family, v.dsl_content"
    " FROM diagrams d"
    " JOIN diagram_types dt ON dt.id = d.diagram_type_id"
    " JOIN diagram_versions v ON v.id = d.current_version_id"
    " WHERE d.deleted_at IS NULL AND d.draft = :no"
    " ORDER BY dt.dsl_family, d.name, d.id"
)


@dataclass
class Finding:
    id: str
    name: str
    project_id: str
    family: str
    #: "unreadable": this build can't open it; "rewritten": the next save writes different text.
    problem: str
    detail: str


@dataclass
class SyntaxReport:
    checked: int = 0
    by_family: dict[str, int] = field(default_factory=dict)
    findings: list[Finding] = field(default_factory=list)

    @property
    def unreadable(self) -> list[Finding]:
        return [f for f in self.findings if f.problem == "unreadable"]

    @property
    def rewritten(self) -> list[Finding]:
        return [f for f in self.findings if f.problem == "rewritten"]


def _first_difference(before: str, after: str) -> str:
    """Where the saved text and the rewrite first differ, as `line N: "old" -> "new"`."""
    old_lines, new_lines = before.splitlines(), after.splitlines()
    for number, (old, new) in enumerate(zip(old_lines, new_lines, strict=False), start=1):
        if old != new:
            return f"line {number}: {old.strip()!r} -> {new.strip()!r}"
    longer = max(len(old_lines), len(new_lines))
    shorter = min(len(old_lines), len(new_lines))
    return f"line {shorter + 1}: {longer - shorter} line(s) {'added' if len(new_lines) > len(old_lines) else 'removed'}"


def build_report(conn: Connection, core: DiagramCore | None = None) -> SyntaxReport:
    core = core or DiagramCore()
    report = SyntaxReport()
    for row in conn.execute(_DIAGRAMS, {"no": False}):
        report.checked += 1
        family = str(row.dsl_family)
        report.by_family[family] = report.by_family.get(family, 0) + 1
        dsl = str(row.dsl_content)

        def finding(problem: str, detail: str, row: Any = row, family: str = family) -> Finding:
            return Finding(str(row.id), str(row.name), str(row.project_id), family, problem, detail)

        try:
            parsed = core.parse(family, dsl)
        except DiagramCoreError as error:
            report.findings.append(finding("unreadable", f"{type(error).__name__}: {error}"))
            continue
        if "errors" in parsed:
            first = parsed["errors"][0] if parsed["errors"] else {}
            line = f"line {first.get('line')}: " if first.get("line") is not None else ""
            report.findings.append(finding("unreadable", f"{line}{first.get('message', 'could not be read')}"))
            continue
        try:
            rewritten = core.serialize(family, parsed["model"])
        except DiagramCoreError as error:
            report.findings.append(finding("unreadable", f"saving fails: {error}"))
            continue
        if rewritten != dsl:
            report.findings.append(finding("rewritten", _first_difference(dsl, rewritten)))
    return report


def _print(report: SyntaxReport) -> None:
    families = ", ".join(f"{family} {count}" for family, count in sorted(report.by_family.items()))
    print(f"Checked {report.checked} diagram(s){f' ({families})' if families else ''}.")
    print(f"Can't be opened by this build: {len(report.unreadable)}")
    for f in report.unreadable:
        print(f"  {f.id}  {f.family}  {f.name!r} (project {f.project_id}): {f.detail}")
    print(f"Saved text would change on the next save: {len(report.rewritten)}")
    for f in report.rewritten:
        print(f"  {f.id}  {f.family}  {f.name!r} (project {f.project_id}): {f.detail}")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    settings = Settings()  # type: ignore[call-arg]  # read from the environment
    engine = create_db_engine(settings)
    try:
        with engine.connect() as conn:
            report = build_report(conn)
    finally:
        engine.dispose()
    if "--json" in args:
        print(
            json.dumps(
                {
                    "checked": report.checked,
                    "byFamily": report.by_family,
                    "findings": [asdict(f) for f in report.findings],
                },
                indent=2,
            )
        )
    else:
        _print(report)
    return 1 if report.unreadable else 0


if __name__ == "__main__":
    sys.exit(main())
