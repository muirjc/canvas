"""canvas-2h2w.4: your notifications (canvas_api/notifications.py writes them): the newest, and marking them read."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, Field, StrictStr
from sqlalchemy import Connection, Engine, text

from canvas_api.auth.roles import CurrentUser
from canvas_api.db import get_engine
from canvas_api.notifications import NOTIFICATION_LIST_LIMIT
from canvas_api.timestamps import now_utc, to_api, to_db

router = APIRouter(tags=["Notifications"])
Db = Annotated[Engine, Depends(get_engine)]

_LIST = text(
    "SELECT n.id, n.kind, n.subject_type, n.subject_id, n.subject_name, n.access_level, n.previous_level,"
    " n.created_at, n.read_at, a.name AS actor_name"
    " FROM notifications n LEFT JOIN users a ON a.id = n.actor_user_id"
    " WHERE n.user_id = :user ORDER BY n.created_at DESC, n.id DESC LIMIT :limit"
)
_UNREAD = text("SELECT COUNT(*) FROM notifications WHERE user_id = :user AND read_at IS NULL")
_READ_ONE = text("UPDATE notifications SET read_at = :at WHERE id = :id AND user_id = :user AND read_at IS NULL")
_READ_ALL = text("UPDATE notifications SET read_at = :at WHERE user_id = :user AND read_at IS NULL")


class MarkReadBody(BaseModel):
    #: The notifications to mark read; left out = all of them.
    ids: list[StrictStr] | None = Field(default=None, max_length=NOTIFICATION_LIST_LIMIT)


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def _unread(conn: Connection, user_id: str) -> int:
    return int(conn.execute(_UNREAD, {"user": user_id}).scalar() or 0)


@router.get("/me/notifications")
def my_notifications(user: CurrentUser, db: Db) -> dict[str, Any]:
    """The newest notifications (read and unread) and how many are unread in all."""
    with db.connect() as conn:
        rows = conn.execute(_LIST, {"user": user.id, "limit": NOTIFICATION_LIST_LIMIT}).all()
        return {
            "notifications": [
                {
                    "id": str(r.id),
                    "kind": r.kind,
                    "subjectType": r.subject_type,
                    "subjectId": str(r.subject_id),
                    "subjectName": r.subject_name,
                    "accessLevel": r.access_level,
                    "previousLevel": r.previous_level,
                    "actorName": r.actor_name,
                    "createdAt": to_api(r.created_at),
                    "read": r.read_at is not None,
                }
                for r in rows
            ],
            "unreadCount": _unread(conn, user.id),
        }


@router.post("/me/notifications/read")
def mark_notifications_read(
    user: CurrentUser, db: Db, body: Annotated[MarkReadBody | None, Body()] = None
) -> dict[str, int]:
    """Marks the given notifications (only your own; others' ids are ignored), or all of yours, as read."""
    with db.begin() as conn:
        at = to_db(now_utc(), conn.dialect.name)
        if body is None or body.ids is None:
            conn.execute(_READ_ALL, {"at": at, "user": user.id})
        else:
            for notification_id in dict.fromkeys(body.ids):
                if not _is_uuid(notification_id):
                    continue  # never anyone's notification (and Postgres would refuse it as a uuid)
                conn.execute(_READ_ONE, {"at": at, "id": notification_id, "user": user.id})
        return {"unreadCount": _unread(conn, user.id)}
