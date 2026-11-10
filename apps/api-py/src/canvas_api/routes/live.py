"""canvas-vvi: WS /diagrams/{id}/live -- a diagram's live editing session (canvas_api/live/hub.py).

A WebSocket bypasses the HTTP middleware (paused mode, CORS, security headers), so this route checks for itself:
the Origin (a page on another site must not ride the visitor's cookie), paused mode, the session cookie (with the
password-change and two-step gates) and the visitor's access to the diagram, then re-checks the session and
access at least every RECHECK_SECONDS while messages arrive (the editor pings every 25 s), so a sign-out or a
removed share ends the connection. Messages are JSON; see docs/live-editing-design.md.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import anyio.to_thread
from fastapi import APIRouter, WebSocket
from sqlalchemy import Engine

from canvas_api.access import access_at_least, require_diagram_access
from canvas_api.auth.session import SessionUser, load_session, read_session, signed_in_user
from canvas_api.config import Settings
from canvas_api.diagram_core import DiagramCore
from canvas_api.errors import ApiError
from canvas_api.live.hub import (
    CLOSE_BAD_MESSAGE,
    CLOSE_GONE,
    CLOSE_NO_ACCESS,
    CLOSE_NOT_SIGNED_IN,
    Client,
    LiveHub,
    Room,
)
from canvas_api.routes.diagrams import get_diagram

router = APIRouter(tags=["Live editing"])

RECHECK_SECONDS = 60.0
MAX_MESSAGE_CHARS = 1_000_000
CLOSE_TRY_AGAIN_LATER = 1013
CLOSE_TOO_BIG = 1009
CLOSE_POLICY = 1008


class _Refused(Exception):
    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def _origin_allowed(websocket: WebSocket, settings: Settings) -> bool:
    origin = websocket.headers.get("origin")
    if not origin:
        return False
    if origin in settings.web_origin_list:
        return True
    # Same origin (Azure serves the web app from this service).
    return urlsplit(origin).netloc == websocket.headers.get("host")


def _signed_in(websocket: WebSocket) -> tuple[SessionUser, str]:
    settings: Settings = websocket.app.state.settings
    session = read_session(websocket)
    user = signed_in_user(session.data, settings) if session else None
    if user is None or session is None:
        raise _Refused(CLOSE_NOT_SIGNED_IN, "not-signed-in")
    if user.mustChangePassword or user.mustEnrollMfa:
        raise _Refused(CLOSE_NOT_SIGNED_IN, "sign-in-incomplete")
    return user, session.id


def _can_edit(engine: Engine, user_id: str, diagram_id: str) -> bool:
    """Whether the visitor may edit (True) or only watch (False); _Refused when they may not open it at all."""
    try:
        with engine.connect() as conn:
            level = require_diagram_access(conn, user_id, diagram_id, "view")
            if level is None:
                raise _Refused(CLOSE_GONE, "not-found")
            get_diagram(conn, diagram_id)  # 404s once it's in the bin
    except ApiError as error:
        raise _Refused(CLOSE_GONE if error.status == 404 else CLOSE_NO_ACCESS, "no-access") from error
    return access_at_least(level, "edit")


def _still_allowed(websocket: WebSocket, session_id: str, user_id: str, diagram_id: str) -> bool:
    settings: Settings = websocket.app.state.settings
    data = load_session(websocket.app.state.db, session_id)
    user = signed_in_user(data, settings) if data else None
    if user is None or user.id != user_id:
        raise _Refused(CLOSE_NOT_SIGNED_IN, "signed-out")
    return _can_edit(websocket.app.state.db, user_id, diagram_id)


def _loader(engine: Engine, core: DiagramCore, diagram_id: str) -> Any:
    def load() -> tuple[str, dict[str, Any], str]:
        try:
            with engine.connect() as conn:
                diagram = get_diagram(conn, diagram_id)
        except ApiError as error:
            raise _Refused(CLOSE_GONE, "not-found") from error
        parsed = core.parse(diagram["dslFamily"], diagram["dslContent"])
        if "model" not in parsed:
            raise _Refused(CLOSE_GONE, "unreadable")
        return diagram["dslFamily"], parsed["model"], diagram["currentVersionId"]

    return load


async def _write(websocket: WebSocket, client: Client) -> None:
    """Sends the client's messages in order; a `closed` message is sent, then the socket closed."""
    while True:
        message = await client.outbox.get()
        if message is None:
            return
        try:
            await websocket.send_text(json.dumps(message, separators=(",", ":"), ensure_ascii=False))
            if message.get("type") == "closed":
                await websocket.close(code=message["code"])
                return
        except Exception:  # the browser went away; the reader sees it too
            return


async def _refuse(websocket: WebSocket, code: int, reason: str) -> None:
    with contextlib.suppress(Exception):
        await websocket.send_text(json.dumps({"type": "closed", "code": code, "reason": reason}))
        await websocket.close(code=code)


@router.websocket("/diagrams/{id}/live")
async def live(websocket: WebSocket, id: str) -> None:
    settings: Settings = websocket.app.state.settings
    hub: LiveHub = websocket.app.state.live_hub
    if not _origin_allowed(websocket, settings):
        await websocket.close(code=CLOSE_POLICY)
        return
    await websocket.accept()
    if settings.paused:
        await _refuse(websocket, CLOSE_TRY_AGAIN_LATER, "paused")
        return
    engine: Engine = websocket.app.state.db
    try:
        user, session_id = await anyio.to_thread.run_sync(_signed_in, websocket)
        can_edit = await anyio.to_thread.run_sync(_can_edit, engine, user.id, id)
    except _Refused as refused:
        await _refuse(websocket, refused.code, refused.reason)
        return

    client = Client(websocket, uuid4().hex, user.id, user.name or user.email, can_edit)
    writer = asyncio.create_task(_write(websocket, client))
    room: Room | None = None
    try:
        room = await hub.join(id, client, _loader(engine, websocket.app.state.diagram_core, id))
        checked = time.monotonic()
        while True:
            received = await websocket.receive()
            if received["type"] == "websocket.disconnect":
                break
            text = received.get("text")
            if text is None or len(text) > MAX_MESSAGE_CHARS:
                client.send({"type": "closed", "code": CLOSE_TOO_BIG, "reason": "message-too-big"})
                break
            if time.monotonic() - checked >= RECHECK_SECONDS:
                allowed = await anyio.to_thread.run_sync(_still_allowed, websocket, session_id, user.id, id)
                hub.set_can_edit(room, client, allowed)
                checked = time.monotonic()
            try:
                message = json.loads(text)
            except ValueError:
                message = None
            kind = message.get("type") if isinstance(message, dict) else None
            if kind == "ping":
                client.send({"type": "pong"})
            elif kind == "patch" and isinstance(message, dict):
                hub.receive_patch(room, client, message.get("clientPatchId"), message.get("patch"))
            elif kind == "select" and isinstance(message, dict):
                hub.receive_selection(room, client, message.get("ids"))
            else:
                client.send({"type": "closed", "code": CLOSE_BAD_MESSAGE, "reason": "bad-message"})
                break
    except _Refused as refused:
        client.send({"type": "closed", "code": refused.code, "reason": refused.reason})
    finally:
        if room is not None:
            hub.leave(room, client)
        else:
            client.send(None)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(writer, timeout=5)
