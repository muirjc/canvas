"""canvas-7p3y: the Mermaid syntax dry run (canvas_api.jobs.syntax_report) -- every saved diagram read with this
build's diagram-core: which can't be opened, which would be written differently on the next save."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest
from sqlalchemy import text

from canvas_api.diagram_core import DiagramCore
from canvas_api.jobs import syntax_report
from canvas_api.migrations import run_migrations
from tests.api import Api, User
from tests.job_helpers import JobDb, job_db_fixture  # noqa: F401 - fixture

CORE = DiagramCore()
CANONICAL = CORE.serialize("flowchart", CORE.parse("flowchart", "flowchart TD\n  a[A] --> b[B]\n")["model"])


def saved(api: Api, owner: User, project: str, name: str, dsl: str, type_id: str = "flowchart", **kw: bool) -> str:
    diagram_id = api.diagram(project, owner, name, type_id, **kw)
    version_id = str(uuid4())
    with api.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO diagram_versions (id, diagram_id, sequence_number, dsl_content, author_id)"
                " VALUES (:id, :diagram, 1, :dsl, :author)"
            ),
            {"id": version_id, "diagram": diagram_id, "dsl": dsl, "author": owner.id},
        )
        conn.execute(
            text("UPDATE diagrams SET current_version_id = :v WHERE id = :id"), {"v": version_id, "id": diagram_id}
        )
    return diagram_id


@pytest.fixture()
def owner(api: Api) -> User:
    api.diagram_type("flowchart")
    api.diagram_type("c4-context", "c4")
    return api.user("owner@example.com")


def test_lists_what_this_build_cant_open_and_what_it_would_rewrite(api: Api, owner: User) -> None:
    project = api.project(owner)
    fine = saved(api, owner, project, "Fine", CANONICAL)
    broken = saved(api, owner, project, "Broken", "flowchart TD\n  a --> b\n  this is not mermaid\n")
    rewritten = saved(api, owner, project, "Hand written", "flowchart TD\n  a --> b --> c\n")
    c4 = saved(api, owner, project, "Context", 'C4Context\n  System(a, "A")\n  Lay_X(a, b)\n', "c4-context")
    saved(api, owner, project, "In the bin", "nonsense", deleted=True)
    saved(api, owner, project, "Unsaved AI draft", "nonsense", draft=True)

    with api.engine.connect() as conn:
        report = syntax_report.build_report(conn)

    assert report.checked == 4
    assert report.by_family == {"flowchart": 3, "c4": 1}
    assert {f.id for f in report.unreadable} == {broken, c4}
    assert [f.id for f in report.rewritten] == [rewritten]
    assert fine not in {f.id for f in report.findings}
    broken_finding = next(f for f in report.unreadable if f.id == broken)
    assert broken_finding.detail.startswith("line 3: ")
    assert broken_finding.name == "Broken" and broken_finding.project_id == project
    assert report.rewritten[0].detail == "line 1: 'flowchart TD' -> '---'"  # Canvas adds its front matter


def test_the_job_prints_a_summary_and_fails_when_a_diagram_cant_be_opened(
    job_db: JobDb, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    job_db.use(monkeypatch)
    run_migrations(job_db.engine)
    api = Api(None, job_db.engine)  # type: ignore[arg-type]  # seeding helpers only, no requests
    api.diagram_type("flowchart")
    owner = api.user("owner@example.com")
    project = api.project(owner)
    saved(api, owner, project, "Fine", CANONICAL)

    assert syntax_report.main([]) == 0
    out = capsys.readouterr().out
    assert "Checked 1 diagram(s) (flowchart 1)." in out
    assert "Can't be opened by this build: 0" in out

    broken = saved(api, owner, project, "Broken", "flowchart TD\n  ???\n")
    assert syntax_report.main(["--json"]) == 1
    data = json.loads(capsys.readouterr().out)
    assert data["checked"] == 2
    assert [(f["id"], f["problem"]) for f in data["findings"]] == [(broken, "unreadable")]

    # canvas-dfam: the Azure job prints numbered lines, so its logs can be put back in order.
    assert syntax_report.main(["--numbered"]) == 1
    lines = capsys.readouterr().out.splitlines()
    assert [line[:7] for line in lines] == [f"{n:06d} " for n in range(1, len(lines) + 1)]
    assert lines[0] == "000001 Checked 2 diagram(s) (flowchart 2)."
    assert lines[1] == "000002 Can't be opened by this build: 1"
    assert lines[2].startswith(f"000003   {broken}  flowchart  'Broken'")
    assert lines[-1] == f"{len(lines):06d} END OF REPORT"
