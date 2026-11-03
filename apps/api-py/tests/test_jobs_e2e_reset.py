"""The local e2e reset, canvas_api.jobs.e2e_reset (a port of apps/api/src/seed/reset-e2e.ts, which had no
tests of its own; purgeProjectDiagrams is covered in test_jobs_purge.py). Runs against a database of its own
(tests/job_helpers.py), as the job builds its engine from the environment.
"""

from __future__ import annotations

import pytest
from sqlalchemy import inspect, text

from canvas_api.jobs import e2e_reset
from canvas_api.migrations import run_migrations
from tests.api import Api
from tests.job_helpers import JobDb, job_db_fixture  # noqa: F401 - fixture


def ids(api: Api, sql: str) -> list[str]:
    with api.engine.connect() as conn:
        return sorted(str(r[0]) for r in conn.execute(text(sql)))


@pytest.fixture()
def seeded(job_db: JobDb, monkeypatch: pytest.MonkeyPatch) -> Api:
    run_migrations(job_db.engine)
    job_db.use(monkeypatch)
    monkeypatch.delenv("NODE_ENV", raising=False)
    api = Api(None, job_db.engine)  # type: ignore[arg-type]  # seeding only, no requests
    api.diagram_type("flowchart")
    return api


def test_clears_the_smoke_test_project_and_the_e2e_user_accounts(
    seeded: Api, capsys: pytest.CaptureFixture[str]
) -> None:
    api = seeded
    architect = api.user("architect@example.com")
    smoke = api.project(architect, "Smoke Test")
    api.diagram(smoke, architect, "Live")
    api.diagram(smoke, architect, "Binned", deleted=True)
    api.diagram(smoke, architect, "Draft", draft=True)
    kept = api.diagram(api.project(architect, "Elsewhere"), architect, "Kept")
    api.grant("project", smoke, api.user("viewer@example.com", "viewer"), "view", architect)

    gone = api.user("e2e-user-1700000000000@example.com")  # with a session (Api.user signs in)
    api.execute("INSERT INTO users_personas (user_id, persona, position) VALUES (:u, 'technical', 0)", u=gone.id)
    api.credentials(gone)
    busy = api.user("e2e-user-1700000000001@example.com")
    api.project(busy, "Owned by an e2e user")  # owns something: left alone
    other = api.user("someone-else@example.com")

    assert e2e_reset.main() == 0
    assert capsys.readouterr().out.splitlines() == [
        "e2e reset: removed 1 of 2 e2e user account(s).",
        'e2e reset: removed 3 diagram(s) from the "Smoke Test" project.',
    ]
    assert ids(api, "SELECT id FROM diagrams") == [kept]
    assert smoke in ids(api, "SELECT id FROM projects")
    assert ids(api, "SELECT subject_id FROM share_grants") == [smoke]
    remaining = ids(api, "SELECT id FROM users")
    assert gone.id not in remaining
    assert {busy.id, other.id, architect.id} <= set(remaining)
    assert api.scalar("SELECT COUNT(*) FROM sessions WHERE user_id = :u", u=busy.id) == 1

    assert e2e_reset.main() == 0
    assert capsys.readouterr().out.splitlines() == [
        "e2e reset: removed 0 of 1 e2e user account(s).",
        'e2e reset: removed 0 diagram(s) from the "Smoke Test" project.',
    ]


def test_without_a_smoke_test_project_there_is_nothing_to_clear(
    seeded: Api, capsys: pytest.CaptureFixture[str]
) -> None:
    assert e2e_reset.main() == 0
    assert capsys.readouterr().out == 'e2e reset: no "Smoke Test" project yet -- nothing to clear.\n'


def test_migrates_an_empty_database_first(
    job_db: JobDb, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    job_db.use(monkeypatch)
    monkeypatch.delenv("NODE_ENV", raising=False)
    assert e2e_reset.main() == 0
    assert capsys.readouterr().out == 'e2e reset: no "Smoke Test" project yet -- nothing to clear.\n'
    assert run_migrations(job_db.engine) == []


def test_refuses_with_node_env_production_before_touching_the_database(
    job_db: JobDb, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    job_db.use(monkeypatch)
    monkeypatch.setenv("NODE_ENV", "production")
    assert e2e_reset.main() == 1
    captured = capsys.readouterr()
    assert captured.err == "e2e:reset refuses to run with NODE_ENV=production.\n"
    assert inspect(job_db.engine).get_table_names() == []
