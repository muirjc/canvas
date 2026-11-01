"""Comments on a diagram (phase 3, canvas-1bty.7; apps/api/src/comments/comment.routes.ts and
comment.service.ts).

A thread is a root comment plus replies; it may be pinned to a shape or connector and resolved. Reading
needs View, posting/replying/resolving needs Comment, editing is the author's, deleting the author's,
the diagram owner's or an admin's. A deleted comment keeps its row (body cleared) so its thread reads on.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field, StrictStr
from sqlalchemy import Connection, Engine, text

from canvas_api.access import AccessLevel, require_diagram_access
from canvas_api.auth.roles import CurrentUser
from canvas_api.db import get_engine
from canvas_api.errors import ApiError
from canvas_api.timestamps import now_utc, parse_instant, to_api_ms, to_db

router = APIRouter(tags=["Comments"])
Db = Annotated[Engine, Depends(get_engine)]

MAX_COMMENT_LENGTH = 4000


class Anchor(BaseModel):
    type: Literal["node", "edge", "container"]
    id: StrictStr = Field(min_length=1, max_length=200)


class NewComment(BaseModel):
    body: StrictStr = Field(max_length=MAX_COMMENT_LENGTH + 200)
    threadRootId: StrictStr | None = None
    anchor: Anchor | None = None


class EditedComment(BaseModel):
    body: StrictStr = Field(max_length=MAX_COMMENT_LENGTH + 200)


def _guard(conn: Connection, user_id: str, diagram_id: str, required: AccessLevel) -> None:
    """The route's access check, then 404 for a missing or deleted diagram."""
    require_diagram_access(conn, user_id, diagram_id, required)
    live = conn.execute(
        text("SELECT id FROM diagrams WHERE id = :id AND deleted_at IS NULL"), {"id": diagram_id}
    ).first()
    if live is None:
        raise ApiError(404, "Diagram not found")


def list_threads(conn: Connection, diagram_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        text(
            "SELECT c.id, c.thread_root_id, c.author_id, a.name AS author_name, c.body, c.anchor_type,"
            " c.anchor_id, c.created_at, c.edited_at, c.deleted_at, c.resolved_at, r.name AS resolved_by_name"
            " FROM diagram_comments c JOIN users a ON a.id = c.author_id"
            " LEFT JOIN users r ON r.id = c.resolved_by_user_id"
            " WHERE c.diagram_id = :id ORDER BY c.created_at, c.id"
        ),
        {"id": diagram_id},
    ).all()

    def comment(r: Any) -> dict[str, Any]:
        return {
            "id": str(r.id),
            "threadRootId": None if r.thread_root_id is None else str(r.thread_root_id),
            "author": {"id": str(r.author_id), "name": r.author_name},
            "body": "" if r.deleted_at else r.body,
            "createdAt": to_api_ms(r.created_at),
            "editedAt": to_api_ms(r.edited_at),
            "deleted": r.deleted_at is not None,
        }

    threads: dict[str, dict[str, Any]] = {}
    for r in rows:
        if r.thread_root_id is None:
            threads[str(r.id)] = {
                **comment(r),
                "anchor": {"type": r.anchor_type, "id": r.anchor_id} if r.anchor_type and r.anchor_id else None,
                "resolved": {"at": to_api_ms(r.resolved_at), "by": r.resolved_by_name} if r.resolved_at else None,
                "replies": [],
            }
    for r in rows:
        if r.thread_root_id is not None and str(r.thread_root_id) in threads:
            threads[str(r.thread_root_id)]["replies"].append(comment(r))
    # A thread whose root and every reply are deleted has nothing left to read.
    return [t for t in threads.values() if not (t["deleted"] and all(c["deleted"] for c in t["replies"]))]


_UNREAD_ALL = text(
    "SELECT COUNT(*) FROM diagram_comments WHERE diagram_id = :id AND author_id != :uid AND deleted_at IS NULL"
)
_UNREAD_SINCE = text(
    "SELECT COUNT(*) FROM diagram_comments WHERE diagram_id = :id AND author_id != :uid AND deleted_at IS NULL"
    " AND created_at > :since"
)


def unread_count(conn: Connection, diagram_id: str, user_id: str) -> int:
    """Comments by others, still visible, posted since this user last looked."""
    read = conn.execute(
        text("SELECT last_read_at FROM diagram_comment_reads WHERE user_id = :uid AND diagram_id = :id"),
        {"uid": user_id, "id": diagram_id},
    ).first()
    params: dict[str, Any] = {"id": diagram_id, "uid": user_id}
    if read is None:
        return int(conn.execute(_UNREAD_ALL, params).scalar_one())
    since = to_db(parse_instant(read.last_read_at), conn.dialect.name)
    return int(conn.execute(_UNREAD_SINCE, {**params, "since": since}).scalar_one())


def mark_read(conn: Connection, diagram_id: str, user_id: str) -> None:
    now = to_db(now_utc(), conn.dialect.name)
    conn.execute(
        text(
            "INSERT INTO diagram_comment_reads (user_id, diagram_id, last_read_at) VALUES (:uid, :id, :now)"
            " ON CONFLICT (user_id, diagram_id) DO UPDATE SET last_read_at = :now"
        ),
        {"uid": user_id, "id": diagram_id, "now": now},
    )


def _clean_body(body: str) -> str:
    trimmed = body.strip()
    if not trimmed:
        raise ApiError(400, "A comment needs some text.")
    if len(trimmed) > MAX_COMMENT_LENGTH:
        raise ApiError(400, f"Comments can be at most {MAX_COMMENT_LENGTH} characters.")
    return trimmed


def _get_comment(conn: Connection, diagram_id: str, comment_id: str) -> Any:
    row = conn.execute(
        text(
            "SELECT id, author_id, thread_root_id, deleted_at FROM diagram_comments"
            " WHERE id = :cid AND diagram_id = :id"
        ),
        {"cid": comment_id, "id": diagram_id},
    ).first()
    if row is None or row.deleted_at is not None:
        raise ApiError(404, "No such comment on this diagram.")
    return row


@router.get("/diagrams/{id}/comments")
def get_comments(id: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    with db.connect() as conn:
        _guard(conn, user.id, id, "view")
        return {"threads": list_threads(conn, id), "unread": unread_count(conn, id, user.id)}


@router.get("/diagrams/{id}/comments/unread")
def get_unread(id: str, user: CurrentUser, db: Db) -> dict[str, int]:
    """The tab's badge, without loading every thread."""
    with db.connect() as conn:
        _guard(conn, user.id, id, "view")
        return {"unread": unread_count(conn, id, user.id)}


@router.post("/diagrams/{id}/comments/read", status_code=204)
def post_read(id: str, user: CurrentUser, db: Db) -> Response:
    with db.begin() as conn:
        _guard(conn, user.id, id, "view")
        mark_read(conn, id, user.id)
    return Response(status_code=204)


@router.post("/diagrams/{id}/comments", status_code=201)
def add_comment(id: str, user: CurrentUser, db: Db, body: NewComment) -> dict[str, Any]:
    with db.begin() as conn:
        _guard(conn, user.id, id, "comment")
        text_body = _clean_body(body.body)
        if body.threadRootId:
            root = conn.execute(
                text("SELECT thread_root_id FROM diagram_comments WHERE id = :cid AND diagram_id = :id"),
                {"cid": body.threadRootId, "id": id},
            ).first()
            if root is None or root.thread_root_id is not None:
                raise ApiError(404, "No such thread on this diagram.")
        comment_id = str(uuid4())
        # Replies belong to their thread's pin; only a new thread is pinned.
        pinned = None if body.threadRootId else body.anchor
        conn.execute(
            text(
                "INSERT INTO diagram_comments"
                " (id, diagram_id, thread_root_id, author_id, body, anchor_type, anchor_id, created_at)"
                " VALUES (:cid, :id, :root, :author, :body, :atype, :aid, :at)"
            ),
            {
                "cid": comment_id,
                "id": id,
                "root": body.threadRootId or None,
                "author": user.id,
                "body": text_body,
                "atype": pinned.type if pinned else None,
                "aid": pinned.id if pinned else None,
                "at": to_db(now_utc(), conn.dialect.name),
            },
        )
        # Your own comment counts as read.
        mark_read(conn, id, user.id)
        return {"id": comment_id, "threads": list_threads(conn, id)}


@router.patch("/diagrams/{id}/comments/{commentId}")
def edit_comment(id: str, commentId: str, user: CurrentUser, db: Db, body: EditedComment) -> dict[str, Any]:
    with db.begin() as conn:
        _guard(conn, user.id, id, "comment")
        comment = _get_comment(conn, id, commentId)
        if str(comment.author_id) != user.id:
            raise ApiError(403, "Only the author can edit a comment.")
        conn.execute(
            text("UPDATE diagram_comments SET body = :body, edited_at = :at WHERE id = :cid"),
            {"body": _clean_body(body.body), "at": to_db(now_utc(), conn.dialect.name), "cid": commentId},
        )
        return {"threads": list_threads(conn, id)}


@router.delete("/diagrams/{id}/comments/{commentId}")
def delete_comment(id: str, commentId: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    """View access reaches this; the author, the diagram's owner or an admin may delete."""
    with db.begin() as conn:
        _guard(conn, user.id, id, "view")
        comment = _get_comment(conn, id, commentId)
        if str(comment.author_id) != user.id and user.role != "admin":
            owner = conn.execute(text("SELECT owner_id FROM diagrams WHERE id = :id"), {"id": id}).first()
            if owner is None or str(owner.owner_id) != user.id:
                raise ApiError(403, "Only the author, the diagram's owner or an admin can delete a comment.")
        conn.execute(
            text("UPDATE diagram_comments SET deleted_at = :at, body = '' WHERE id = :cid"),
            {"at": to_db(now_utc(), conn.dialect.name), "cid": commentId},
        )
        return {"threads": list_threads(conn, id)}


def _set_resolved(db: Engine, diagram_id: str, root_id: str, user_id: str, *, resolved: bool) -> dict[str, Any]:
    with db.begin() as conn:
        _guard(conn, user_id, diagram_id, "comment")
        # A thread can be resolved even if its first comment was deleted (its replies still read).
        root = conn.execute(
            text("SELECT thread_root_id FROM diagram_comments WHERE id = :cid AND diagram_id = :id"),
            {"cid": root_id, "id": diagram_id},
        ).first()
        if root is None:
            raise ApiError(404, "No such thread on this diagram.")
        if root.thread_root_id is not None:
            raise ApiError(400, "Resolve the thread, not a reply.")
        conn.execute(
            text("UPDATE diagram_comments SET resolved_at = :at, resolved_by_user_id = :by WHERE id = :cid"),
            {
                "at": to_db(now_utc(), conn.dialect.name) if resolved else None,
                "by": user_id if resolved else None,
                "cid": root_id,
            },
        )
        return {"threads": list_threads(conn, diagram_id)}


@router.post("/diagrams/{id}/comments/{commentId}/resolve")
def resolve_thread(id: str, commentId: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    return _set_resolved(db, id, commentId, user.id, resolved=True)


@router.post("/diagrams/{id}/comments/{commentId}/reopen")
def reopen_thread(id: str, commentId: str, user: CurrentUser, db: Db) -> dict[str, Any]:
    return _set_resolved(db, id, commentId, user.id, resolved=False)
