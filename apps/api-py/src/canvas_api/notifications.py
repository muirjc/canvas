"""canvas-2h2w.4: in-app notifications about access -- someone added you to a project or shared a diagram with
you, changed or removed your access, or made you a project's owner. Written inside the change's own transaction,
so a notification exists exactly when the change does. Nobody is told about their own change.

The subject's name is kept as it was then: after "removed" the person can't read the subject any more, and the
list mustn't show a later rename to someone without access."""

from __future__ import annotations

from datetime import timedelta
from typing import Literal
from uuid import uuid4

from sqlalchemy import Connection, text

from canvas_api.timestamps import now_utc, to_db

Kind = Literal["added", "level_changed", "removed", "ownership"]
SubjectType = Literal["project", "diagram"]

#: How long a notification is kept; the nightly purge removes older ones.
NOTIFICATION_RETENTION_DAYS = 90
#: How many the list returns (newest first).
NOTIFICATION_LIST_LIMIT = 50

_SUBJECT_NAME = {
    "project": text("SELECT name FROM projects WHERE id = :id"),
    "diagram": text("SELECT name FROM diagrams WHERE id = :id"),
}
_INSERT = text(
    "INSERT INTO notifications"
    " (id, user_id, kind, actor_user_id, subject_type, subject_id, subject_name, access_level, previous_level,"
    " created_at) VALUES (:id, :user, :kind, :actor, :type, :subject, :name, :level, :previous, :at)"
)


def notify(
    conn: Connection,
    *,
    user_id: str,
    kind: Kind,
    actor_user_id: str,
    subject_type: SubjectType,
    subject_id: str,
    access_level: str | None = None,
    previous_level: str | None = None,
) -> None:
    """Tells `user_id` about a change `actor_user_id` made (nothing when they're the same person)."""
    if user_id == actor_user_id:
        return
    name = conn.execute(_SUBJECT_NAME[subject_type], {"id": subject_id}).scalar()
    conn.execute(
        _INSERT,
        {
            "id": str(uuid4()),
            "user": user_id,
            "kind": kind,
            "actor": actor_user_id,
            "type": subject_type,
            "subject": subject_id,
            "name": name if name is not None else "",
            "level": access_level,
            "previous": previous_level,
            "at": to_db(now_utc(), conn.dialect.name),
        },
    )


_PURGE_OLD = {
    "postgresql": text("DELETE FROM notifications WHERE created_at < :cutoff"),
    "sqlite": text("DELETE FROM notifications WHERE julianday(created_at) < julianday(:cutoff)"),
}


def purge_old_notifications(conn: Connection) -> int:
    """Removes notifications older than NOTIFICATION_RETENTION_DAYS; how many went."""
    cutoff = to_db(now_utc() - timedelta(days=NOTIFICATION_RETENTION_DAYS), conn.dialect.name)
    return conn.execute(_PURGE_OLD[conn.dialect.name], {"cutoff": cutoff}).rowcount or 0
