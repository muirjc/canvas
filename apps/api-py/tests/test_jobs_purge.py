"""The housekeeping purge (canvas_api/retention.py and the canvas_api.jobs.purge command).

Covers apps/api/tests/contract: diagram-purge.test.ts (purgeExpiredDiagrams, purgeProjectDiagrams),
project-purge.test.ts (purgeExpiredProjects), diagram-draft.test.ts's "an abandoned draft is purged after a
day", and comments.test.ts's purge case (comments and read markers go with the diagram). Like those, the
service functions are called directly; the job itself is run against a database of its own (tests/job_helpers.py)
for its output, --dry-run and migrating first. Aged via Python's clock, as the TypeScript tests age via Node's
(the retention boundary is app-computed).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text

from canvas_api.jobs import purge as purge_job
from canvas_api.migrations import run_migrations
from canvas_api.retention import (
    DRAFT_RETENTION_HOURS,
    ProjectPurgeResult,
    SkippedProject,
    find_abandoned_draft_ids,
    find_expired_diagram_ids,
    find_expired_project_ids,
    purge_diagrams,
    purge_expired_diagrams,
    purge_expired_projects,
    purge_project_diagrams,
)
from canvas_api.timestamps import now_utc, to_db
from tests.api import Api, User
from tests.job_helpers import JobDb, job_db_fixture  # noqa: F401 - fixture


@pytest.fixture()
def owner(api: Api) -> User:
    api.diagram_type("flowchart")
    return api.user("owner@example.com")


def age_diagram(api: Api, diagram_id: str, days: float) -> None:
    api.execute(
        "UPDATE diagrams SET deleted_at = :at WHERE id = :id",
        at=to_db(now_utc() - timedelta(days=days), api.dialect),
        id=diagram_id,
    )


def age_project(api: Api, project_id: str, days: float, by: User) -> None:
    api.execute(
        "UPDATE projects SET deleted_at = :at, deleted_by_user_id = :by WHERE id = :id",
        at=to_db(now_utc() - timedelta(days=days), api.dialect),
        by=by.id,
        id=project_id,
    )


def diagram_ids(api: Api) -> list[str]:
    with api.engine.connect() as conn:
        return sorted(str(r[0]) for r in conn.execute(text("SELECT id FROM diagrams")))


def count(api: Api, sql: str, **params: object) -> int:
    return int(api.scalar(sql, **params))


def chat(api: Api, diagram_id: str) -> str:
    chat_id = str(uuid4())
    api.execute("INSERT INTO diagram_chats (id, diagram_id) VALUES (:id, :d)", id=chat_id, d=diagram_id)
    api.execute(
        "INSERT INTO chat_messages (id, diagram_chat_id, role, content) VALUES (:id, :c, 'user', 'hello')",
        id=str(uuid4()),
        c=chat_id,
    )
    return chat_id


# --- diagram-purge.test.ts ----------------------------------------------------------------------------


def test_leaves_an_active_never_deleted_diagram_untouched(api: Api, owner: User) -> None:
    diagram = api.new_diagram(api.project(owner), owner, "Active Diagram")
    assert purge_expired_diagrams(api.engine) == []
    assert diagram_ids(api) == [diagram["id"]]


def test_leaves_a_soft_deleted_diagram_still_within_its_retention_window_untouched(api: Api, owner: User) -> None:
    diagram = api.new_diagram(api.project(owner), owner, "Recently Deleted")
    age_diagram(api, diagram["id"], 10)
    with api.engine.connect() as conn:
        assert find_expired_diagram_ids(conn) == []
    assert purge_expired_diagrams(api.engine) == []
    assert diagram_ids(api) == [diagram["id"]]


def test_physically_deletes_a_diagram_whose_retention_window_has_fully_elapsed(api: Api, owner: User) -> None:
    diagram = api.new_diagram(api.project(owner), owner, "Long Gone")
    age_diagram(api, diagram["id"], 31)
    with api.engine.connect() as conn:
        assert find_expired_diagram_ids(conn) == [diagram["id"]]
    assert purge_expired_diagrams(api.engine) == [diagram["id"]]
    assert diagram_ids(api) == []


def test_exactly_30_days_is_expired_as_the_restore_route_treats_it(api: Api, owner: User) -> None:
    diagram = api.new_diagram(api.project(owner), owner, "At The Boundary")
    age_diagram(api, diagram["id"], 30)
    with api.engine.connect() as conn:
        assert find_expired_diagram_ids(conn) == [diagram["id"]]
    admin = api.user("admin@example.com", "admin")
    assert api.call("POST", f"/diagrams/{diagram['id']}/restore", admin).status_code == 409


def test_deletes_versions_chats_messages_share_grants_comments_and_presence_with_the_diagram(
    api: Api, owner: User
) -> None:
    diagram_id = api.new_diagram(api.project(owner), owner, "Diagram With Dependents")["id"]
    other = api.user("other@example.com")
    api.grant("diagram", diagram_id, other, "view", owner)
    chat_id = chat(api, diagram_id)
    root = api.comment(diagram_id, owner, "root")
    api.comment(diagram_id, other, "reply", root=root)
    assert api.call("POST", f"/diagrams/{diagram_id}/comments/read", other).status_code == 204
    assert api.call("PUT", f"/diagrams/{diagram_id}/presence", owner, json={"sessionId": "tab-1"}).status_code == 200
    age_diagram(api, diagram_id, 45)

    assert purge_expired_diagrams(api.engine) == [diagram_id]

    assert count(api, "SELECT COUNT(*) FROM diagram_versions WHERE diagram_id = :id", id=diagram_id) == 0
    assert count(api, "SELECT COUNT(*) FROM diagram_chats WHERE diagram_id = :id", id=diagram_id) == 0
    assert count(api, "SELECT COUNT(*) FROM chat_messages WHERE diagram_chat_id = :id", id=chat_id) == 0
    assert count(api, "SELECT COUNT(*) FROM share_grants WHERE subject_id = :id", id=diagram_id) == 0
    assert count(api, "SELECT COUNT(*) FROM diagram_comments WHERE diagram_id = :id", id=diagram_id) == 0
    assert count(api, "SELECT COUNT(*) FROM diagram_comment_reads WHERE diagram_id = :id", id=diagram_id) == 0
    assert count(api, "SELECT COUNT(*) FROM diagram_edit_sessions WHERE diagram_id = :id", id=diagram_id) == 0


def test_purges_multiple_expired_diagrams_in_one_call_and_leaves_unrelated_ones_alone(api: Api, owner: User) -> None:
    project = api.project(owner)
    expired_one, expired_two, still_active, within_window = (
        api.new_diagram(project, owner, name)["id"] for name in ("Expired One", "Expired Two", "Active", "Window")
    )
    age_diagram(api, expired_one, 31)
    age_diagram(api, expired_two, 90)
    age_diagram(api, within_window, 5)

    assert sorted(purge_expired_diagrams(api.engine)) == sorted([expired_one, expired_two])
    assert diagram_ids(api) == sorted([still_active, within_window])


def test_purge_project_diagrams_removes_every_diagram_in_one_project_and_nothing_else(api: Api, owner: User) -> None:
    project = api.project(owner, "Test Project")
    live = api.new_diagram(project, owner, "Live Diagram")["id"]
    trashed = api.new_diagram(project, owner, "Recently Deleted")["id"]
    age_diagram(api, trashed, 1)
    grantee = api.user("grantee@example.com")
    api.grant("diagram", live, grantee, "view", owner)
    chat_id = chat(api, live)
    elsewhere = api.new_diagram(api.project(owner, "Other Project"), owner, "Elsewhere")["id"]

    assert sorted(purge_project_diagrams(api.engine, project)) == sorted([live, trashed])

    assert diagram_ids(api) == [elsewhere]
    assert count(api, "SELECT COUNT(*) FROM share_grants WHERE subject_id = :id", id=live) == 0
    assert count(api, "SELECT COUNT(*) FROM diagram_chats WHERE id = :id", id=chat_id) == 0
    assert count(api, "SELECT COUNT(*) FROM projects WHERE id = :id", id=project) == 1
    assert purge_project_diagrams(api.engine, project) == []


def test_purge_diagrams_with_no_ids_does_nothing(api: Api, owner: User) -> None:
    api.new_diagram(api.project(owner), owner)
    assert purge_diagrams(api.engine, []) == []
    assert len(diagram_ids(api)) == 1


# --- diagram-draft.test.ts ----------------------------------------------------------------------------


def test_an_abandoned_draft_is_purged_after_a_day_a_saved_diagram_never_is(api: Api, owner: User) -> None:
    project = api.project(owner)
    abandoned = api.new_diagram(project, owner, "AI drawn", draft=True)["id"]
    recent = api.new_diagram(project, owner, "Just drawn", draft=True)["id"]
    saved = api.new_diagram(project, owner, "Saved")["id"]
    old = to_db(now_utc() - timedelta(hours=DRAFT_RETENTION_HOURS + 1), api.dialect)
    api.execute("UPDATE diagrams SET created_at = :at WHERE id IN (:a, :b)", at=old, a=abandoned, b=saved)

    with api.engine.connect() as conn:
        assert find_abandoned_draft_ids(conn) == [abandoned]
    assert purge_expired_diagrams(api.engine) == [abandoned]
    assert diagram_ids(api) == sorted([recent, saved])


def test_a_draft_created_late_in_the_day_is_not_purged_early(api: Api, owner: User) -> None:
    """created_at as the database default writes it (SQLite: "2026-11-02 23:00:00"), compared as an instant:
    as a string it sorted before the same day's ISO cutoff, so the TypeScript service purged it hours early."""
    draft = api.diagram(api.project(owner), owner, "Late draft", draft=True)
    created = datetime(2026, 11, 2, 23, 0, tzinfo=UTC)
    stored = created.strftime("%Y-%m-%d %H:%M:%S") if api.dialect == "sqlite" else created
    api.execute("UPDATE diagrams SET created_at = :at WHERE id = :id", at=stored, id=draft)
    with api.engine.connect() as conn:
        assert find_abandoned_draft_ids(conn, now=datetime(2026, 11, 3, 10, 0, tzinfo=UTC)) == []
        assert find_abandoned_draft_ids(conn, now=datetime(2026, 11, 3, 23, 0, 1, tzinfo=UTC)) == [draft]


# --- project-purge.test.ts ----------------------------------------------------------------------------


def test_leaves_active_projects_and_projects_still_inside_their_retention_window_untouched(
    api: Api, owner: User
) -> None:
    active = api.project(owner, "Active")
    recent = api.project(owner, "Recently deleted")
    age_project(api, recent, 29, owner)
    with api.engine.connect() as conn:
        assert find_expired_project_ids(conn) == []
    assert purge_expired_projects(api.engine) == ProjectPurgeResult([], [])
    assert count(api, "SELECT COUNT(*) FROM projects WHERE id IN (:a, :b)", a=active, b=recent) == 2


def test_physically_deletes_an_empty_expired_project_and_its_project_level_share_grants(api: Api, owner: User) -> None:
    project = api.project(owner, "Expired")
    age_project(api, project, 31, owner)
    api.grant("project", project, api.user("grantee@example.com"), "view", owner)

    with api.engine.connect() as conn:
        assert find_expired_project_ids(conn) == [project]
    assert purge_expired_projects(api.engine) == ProjectPurgeResult([project], [])
    assert count(api, "SELECT COUNT(*) FROM projects WHERE id = :id", id=project) == 0
    assert count(api, "SELECT COUNT(*) FROM share_grants WHERE subject_id = :id", id=project) == 0


def test_skips_an_expired_project_holding_a_soft_deleted_diagram_that_is_still_restorable(
    api: Api, owner: User
) -> None:
    project = api.project(owner, "Expired")
    diagram = api.diagram(project, owner)
    age_diagram(api, diagram, 10)
    age_project(api, project, 31, owner)

    assert purge_expired_projects(api.engine) == ProjectPurgeResult(
        [], [SkippedProject(project, "still contains diagrams")]
    )
    assert diagram_ids(api) == [diagram]


def test_purges_the_project_once_its_expired_diagrams_are_purged_first(api: Api, owner: User) -> None:
    project = api.project(owner, "Expired")
    age_diagram(api, api.diagram(project, owner), 40)
    age_project(api, project, 31, owner)

    purge_expired_diagrams(api.engine)
    assert purge_expired_projects(api.engine).purged_project_ids == [project]
    assert count(api, "SELECT COUNT(*) FROM projects WHERE id = :id", id=project) == 0


def test_purges_an_expired_child_before_its_expired_parent_in_one_call(api: Api, owner: User) -> None:
    parent = api.project(owner, "Parent")
    child = api.project(owner, "Child", parent=parent)
    age_project(api, child, 35, owner)
    age_project(api, parent, 31, owner)

    assert purge_expired_projects(api.engine) == ProjectPurgeResult([child, parent], [])
    assert count(api, "SELECT COUNT(*) FROM projects") == 0


def test_skips_an_expired_parent_whose_sub_project_is_still_live_and_never_cascades_into_it(
    api: Api, owner: User
) -> None:
    parent = api.project(owner, "Parent")
    child = api.project(owner, "Live child", parent=parent)
    age_project(api, parent, 31, owner)

    assert purge_expired_projects(api.engine) == ProjectPurgeResult(
        [], [SkippedProject(parent, "still has sub-projects")]
    )
    assert count(api, "SELECT COUNT(*) FROM projects WHERE id IN (:a, :b)", a=parent, b=child) == 2


# --- the job ------------------------------------------------------------------------------------------


@pytest.fixture()
def seeded_job_db(job_db: JobDb, monkeypatch: pytest.MonkeyPatch) -> tuple[Api, dict[str, str]]:
    """The job's own database, migrated, with an expired diagram, an abandoned draft, a recent deletion, an
    expired empty project and an expired project still holding a restorable diagram."""
    run_migrations(job_db.engine)
    job_db.use(monkeypatch)
    api = Api(None, job_db.engine)  # type: ignore[arg-type]  # seeding only, no requests
    api.diagram_type("flowchart")
    owner = api.user("owner@example.com")
    project = api.project(owner, "Live")
    ids = {
        "expired": api.diagram(project, owner, "Expired"),
        "draft": api.diagram(project, owner, "Draft", draft=True),
        "recent": api.diagram(project, owner, "Recent"),
        "empty": api.project(owner, "Empty"),
        "busy": api.project(owner, "Busy"),
    }
    ids["kept"] = api.diagram(ids["busy"], owner, "Kept")
    age_diagram(api, ids["expired"], 31)
    age_diagram(api, ids["recent"], 2)
    age_diagram(api, ids["kept"], 2)
    api.execute(
        "UPDATE diagrams SET created_at = :at WHERE id = :id",
        at=to_db(now_utc() - timedelta(hours=DRAFT_RETENTION_HOURS + 1), api.dialect),
        id=ids["draft"],
    )
    age_project(api, ids["empty"], 31, owner)
    age_project(api, ids["busy"], 31, owner)
    return api, ids


def test_the_job_dry_run_lists_candidates_and_deletes_nothing(
    seeded_job_db: tuple[Api, dict[str, str]], capsys: pytest.CaptureFixture[str]
) -> None:
    api, ids = seeded_job_db
    before = diagram_ids(api)
    assert purge_job.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert out.splitlines()[:3] == [
        "[dry run] diagram(s) would be purged past their 30-day retention window: 1",
        f"  {ids['expired']}",
        "[dry run] unsaved AI drafts older than 24 hours that would be purged: 1",
    ]
    assert out.splitlines()[3] == (
        "[dry run] project(s) are candidates (purged only once they hold no diagrams or sub-projects)"
        " past their 30-day retention window: 2"
    )
    assert sorted(out.splitlines()[4:]) == sorted([f"  {ids['empty']}", f"  {ids['busy']}"])
    assert diagram_ids(api) == before


def test_the_job_purges_diagrams_then_projects_and_reports_the_skipped(
    seeded_job_db: tuple[Api, dict[str, str]], capsys: pytest.CaptureFixture[str]
) -> None:
    api, ids = seeded_job_db
    assert purge_job.main([]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert lines[0] == "Purged diagram(s) past their 30-day retention window: 2"
    assert sorted(lines[1:3]) == sorted([f"  {ids['expired']}", f"  {ids['draft']}"])
    assert lines[3:] == [
        "Purged project(s) past their 30-day retention window: 1",
        f"  {ids['empty']}",
        "Skipped 1 expired project(s) still in use:",
        f"  {ids['busy']} (still contains diagrams)",
        "Removed 0 notification(s) older than 90 days.",  # canvas-2h2w.4
    ]
    assert ids["recent"] in diagram_ids(api)

    assert purge_job.main([]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "No diagrams past their 30-day retention window — nothing to purge.",
        "No projects past their 30-day retention window — nothing to purge.",
        "Skipped 1 expired project(s) still in use:",
        f"  {ids['busy']} (still contains diagrams)",        "Removed 0 notification(s) older than 90 days.",
    ]


def test_the_job_migrates_an_empty_database_first(
    job_db: JobDb, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    job_db.use(monkeypatch)
    assert purge_job.main(["--dry-run"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "No diagrams past their 30-day retention window — nothing to purge.",
        "[dry run] unsaved AI drafts older than 24 hours that would be purged: 0",
        "No projects past their 30-day retention window — nothing to purge.",
    ]
    assert run_migrations(job_db.engine) == []
