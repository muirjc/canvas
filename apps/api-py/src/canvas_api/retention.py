"""How long deleted things stay restorable, and the purge that physically removes them afterwards.

Ports the retention parts of apps/api/src/diagrams/diagram.service.ts (DIAGRAM_RETENTION_DAYS,
DRAFT_RETENTION_HOURS, findExpiredDiagramIds, findAbandonedDraftIds, purgeExpiredDiagrams, purgeDiagrams,
purgeProjectDiagrams) and apps/api/src/projects/project.service.ts (PROJECT_RETENTION_DAYS,
findExpiredProjectIds, purgeExpiredProjects). The routes use the constants for their restore windows and
`delete_diagram_rows` to discard a draft; the purge job (canvas_api.jobs.purge) and the local e2e reset
(canvas_api.jobs.e2e_reset) use the rest. No HTTP route purges anything.

Timestamps are compared as instants on SQLite (julianday() on both sides): a column's DEFAULT
CURRENT_TIMESTAMP is "2026-11-01 09:30:00" while the app binds JavaScript ISO text, and comparing the two
as strings puts every time of a day before any ISO time of the same day. (The TypeScript service compared the
strings, so on SQLite it purged a draft created late in the day as soon as the cutoff reached that date.)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import Connection, Engine, TextClause, text

from canvas_api.timestamps import now_utc, to_db

#: Soft-deleted diagrams older than this are no longer restorable, and the purge removes them.
DIAGRAM_RETENTION_DAYS = 30
#: Drafts (Create with AI, Import, templates) nobody saved within this many hours are removed by the purge.
DRAFT_RETENTION_HOURS = 24
#: Soft-deleted projects older than this are no longer restorable, and the purge removes them once empty.
PROJECT_RETENTION_DAYS = 30


def diagram_retention_boundary(now: datetime | None = None) -> datetime:
    """A diagram deleted at or before this instant is past its retention window."""
    return (now or now_utc()) - timedelta(days=DIAGRAM_RETENTION_DAYS)


def project_retention_boundary(now: datetime | None = None) -> datetime:
    """A project deleted at or before this instant is past its retention window."""
    return (now or now_utc()) - timedelta(days=PROJECT_RETENTION_DAYS)


# --- diagrams -----------------------------------------------------------------------------------------

_EXPIRED_DIAGRAMS = {
    "postgresql": text("SELECT id FROM diagrams WHERE deleted_at IS NOT NULL AND deleted_at <= :boundary"),
    "sqlite": text(
        "SELECT id FROM diagrams WHERE deleted_at IS NOT NULL AND julianday(deleted_at) <= julianday(:boundary)"
    ),
}

_ABANDONED_DRAFTS = {
    "postgresql": text("SELECT id FROM diagrams WHERE draft = :yes AND created_at < :cutoff"),
    "sqlite": text("SELECT id FROM diagrams WHERE draft = :yes AND julianday(created_at) < julianday(:cutoff)"),
}

#: A diagram's dependents, then the diagram, as purgeDiagrams does. diagram_versions, presence
#: (diagram_edit_sessions) and GitHub submissions cascade with the diagram; chat history, share grants and
#: notifications (a polymorphic subject_id with no foreign key) don't. Comments and their read markers are
#: deleted explicitly, replies before their thread roots.
#: current_version_id is cleared first so no engine has to order the diagram <-> version references itself.
_DELETE_DIAGRAM = (
    text("UPDATE diagrams SET current_version_id = NULL WHERE id = :id"),
    text("DELETE FROM chat_messages WHERE diagram_chat_id IN (SELECT id FROM diagram_chats WHERE diagram_id = :id)"),
    text("DELETE FROM diagram_chats WHERE diagram_id = :id"),
    text("DELETE FROM share_grants WHERE subject_type = 'diagram' AND subject_id = :id"),
    text("DELETE FROM notifications WHERE subject_type = 'diagram' AND subject_id = :id"),  # canvas-2h2w.4
    text("DELETE FROM diagram_comment_reads WHERE diagram_id = :id"),
    text("DELETE FROM diagram_comments WHERE diagram_id = :id AND thread_root_id IS NOT NULL"),
    text("DELETE FROM diagram_comments WHERE diagram_id = :id"),
    text("DELETE FROM diagrams WHERE id = :id"),
)


def _ids(conn: Connection, statement: TextClause, params: dict[str, object]) -> list[str]:
    return [str(row[0]) for row in conn.execute(statement, params)]


def find_expired_diagram_ids(conn: Connection, now: datetime | None = None) -> list[str]:
    """Soft-deleted diagrams past DIAGRAM_RETENTION_DAYS: the same boundary the restore route refuses at, so
    nothing returned here can be brought back through the app."""
    dialect = conn.dialect.name
    return _ids(conn, _EXPIRED_DIAGRAMS[dialect], {"boundary": to_db(diagram_retention_boundary(now), dialect)})


def find_abandoned_draft_ids(conn: Connection, now: datetime | None = None) -> list[str]:
    """Drafts whose creator never saved them (tab closed, browser crashed) within DRAFT_RETENTION_HOURS."""
    dialect = conn.dialect.name
    cutoff = (now or now_utc()) - timedelta(hours=DRAFT_RETENTION_HOURS)
    return _ids(conn, _ABANDONED_DRAFTS[dialect], {"yes": True, "cutoff": to_db(cutoff, dialect)})


def delete_diagram_rows(conn: Connection, diagram_id: str) -> None:
    """Physically deletes one diagram and its dependents, inside the caller's transaction."""
    for statement in _DELETE_DIAGRAM:
        conn.execute(statement, {"id": diagram_id})


def purge_diagrams(engine: Engine, ids: list[str]) -> list[str]:
    """Physically deletes the given diagrams and their dependents in one transaction (all or none). Returns
    the ids it was given."""
    if not ids:
        return []
    with engine.begin() as conn:
        for diagram_id in ids:
            delete_diagram_rows(conn, diagram_id)
    return ids


def purge_expired_diagrams(engine: Engine) -> list[str]:
    """Diagrams past their retention window, then abandoned drafts. Returns the ids purged."""
    with engine.connect() as conn:
        ids = find_expired_diagram_ids(conn) + find_abandoned_draft_ids(conn)
    return purge_diagrams(engine, list(dict.fromkeys(ids)))


def purge_project_diagrams(engine: Engine, project_id: str) -> list[str]:
    """Every diagram in one project, live, soft-deleted or draft (the local e2e reset of the "Smoke Test"
    fixture; never a user-facing action). The project and its project-level grants stay."""
    with engine.connect() as conn:
        ids = _ids(conn, text("SELECT id FROM diagrams WHERE project_id = :id"), {"id": project_id})
    return purge_diagrams(engine, ids)


# --- projects -----------------------------------------------------------------------------------------

_EXPIRED_PROJECTS = {
    "postgresql": text("SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= :boundary"),
    "sqlite": text(
        "SELECT id FROM projects WHERE deleted_at IS NOT NULL AND julianday(deleted_at) <= julianday(:boundary)"
    ),
}
_HAS_DIAGRAMS = text("SELECT 1 FROM diagrams WHERE project_id = :id LIMIT 1")
_HAS_CHILDREN = text("SELECT 1 FROM projects WHERE parent_project_id = :id LIMIT 1")


@dataclass
class SkippedProject:
    id: str
    reason: str


@dataclass
class ProjectPurgeResult:
    purged_project_ids: list[str] = field(default_factory=list)
    #: Expired projects left in place because something still points at them.
    skipped: list[SkippedProject] = field(default_factory=list)


def find_expired_project_ids(conn: Connection, now: datetime | None = None) -> list[str]:
    """Soft-deleted projects past PROJECT_RETENTION_DAYS: the candidates purge_expired_projects considers."""
    dialect = conn.dialect.name
    return _ids(conn, _EXPIRED_PROJECTS[dialect], {"boundary": to_db(project_retention_boundary(now), dialect)})


def purge_expired_projects(engine: Engine) -> ProjectPurgeResult:
    """Physically deletes projects past their retention window that nothing references any more: no diagram
    rows in any state (diagrams.project_id doesn't cascade, and a soft-deleted diagram still inside its own
    window must stay restorable) and no sub-projects (parent_project_id DOES cascade, so deleting the parent
    would silently take them along). Anything still referenced is skipped and reported. Expired children go
    before their expired parents, one pass per level. Project share grants have no foreign key, so they are
    deleted explicitly. The purge job runs purge_expired_diagrams first."""
    result = ProjectPurgeResult()
    with engine.connect() as conn:
        remaining = find_expired_project_ids(conn)
    reasons: dict[str, str] = {}
    while remaining:
        reasons = {}
        with engine.connect() as conn:
            for project_id in remaining:
                if conn.execute(_HAS_DIAGRAMS, {"id": project_id}).first() is not None:
                    reasons[project_id] = "still contains diagrams"
                elif conn.execute(_HAS_CHILDREN, {"id": project_id}).first() is not None:
                    reasons[project_id] = "still has sub-projects"
        ready = [project_id for project_id in remaining if project_id not in reasons]
        if not ready:
            break
        with engine.begin() as conn:
            for project_id in ready:
                conn.execute(
                    text("DELETE FROM share_grants WHERE subject_type = 'project' AND subject_id = :id"),
                    {"id": project_id},
                )
                conn.execute(
                    text("DELETE FROM notifications WHERE subject_type = 'project' AND subject_id = :id"),
                    {"id": project_id},
                )
                conn.execute(text("DELETE FROM projects WHERE id = :id"), {"id": project_id})
        result.purged_project_ids.extend(ready)
        remaining = [project_id for project_id in remaining if project_id in reasons]
    result.skipped = [SkippedProject(p, reasons.get(p, "still referenced")) for p in remaining]
    return result
