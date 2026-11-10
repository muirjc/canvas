"""canvas-vvi: live co-editing. One room per open diagram, in memory (Canvas runs one API process).

The room holds the live model (saved or not), a sequence number and the version everyone in it last saved.
People with edit access send patches (diagram_core/live_patch.py); the hub applies them in arrival order and
sends each to everyone, the sender's own copy being its acknowledgement, so every browser ends on the room's
model. Before a patch goes out, the patched model must still write and read back as Mermaid (the same check a
save makes) and every web address in it must be one the parser allows, so a hand-made patch can't hand other
browsers something the parser would never produce (a `javascript:` link, say). That check is batched: at most
every CHECK_INTERVAL seconds per room.

Everything here runs on the event loop; saves arrive from the threadpool through notify_saved/notify_deleted.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import anyio.to_thread
from starlette.websockets import WebSocket

from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.live_patch import apply_patch, patch_problem
from canvas_api.diagram_core.model import is_allowed_link_href
from canvas_api.timestamps import now_utc, to_api

log = logging.getLogger(__name__)

CHECK_INTERVAL = 0.1
#: Most ids one person's selection may hold.
MAX_SELECTION = 500
#: The largest live model (as JSON) a room keeps.
MAX_MODEL_BYTES = 5_000_000
#: Close codes the editor understands (4000-4999 are the application's own).
CLOSE_NOT_SIGNED_IN = 4401
CLOSE_NO_ACCESS = 4403
CLOSE_GONE = 4404
CLOSE_BAD_MESSAGE = 4400


@dataclass
class Client:
    socket: WebSocket
    connection_id: str
    user_id: str
    name: str
    can_edit: bool
    since: str = field(default_factory=lambda: to_api(now_utc()) or "")
    #: The ids this person has selected (shown to the others in their colour; never saved).
    selection: list[str] = field(default_factory=list)
    outbox: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)

    def send(self, message: dict[str, Any] | None) -> None:
        """Queues a message for this connection; None ends its writer."""
        self.outbox.put_nowait(message)

    def person(self) -> dict[str, Any]:
        return {
            "connectionId": self.connection_id,
            "userId": self.user_id,
            "name": self.name,
            "canEdit": self.can_edit,
            "since": self.since,
            "selection": self.selection,
        }


@dataclass
class Room:
    diagram_id: str
    family: str
    model: dict[str, Any]
    base_version_id: str
    seq: int = 0
    clients: dict[str, Client] = field(default_factory=dict)
    queue: list[tuple[Client, Any, dict[str, Any]]] = field(default_factory=list)
    flushing: asyncio.Task[None] | None = None
    checked_at: float = 0.0

    def broadcast(self, message: dict[str, Any], except_for: Client | None = None) -> None:
        for client in self.clients.values():
            if client is not except_for:
                client.send(message)

    def people(self) -> list[dict[str, Any]]:
        return [client.person() for client in self.clients.values()]


#: Loads a diagram for its first visitor: (family, model, current version id). Runs in a worker thread.
RoomLoader = Callable[[], tuple[str, dict[str, Any], str]]


class LiveHub:
    def __init__(self, core: DiagramCore) -> None:
        self._core = core
        self._rooms: dict[str, Room] = {}
        self._joining: dict[str, asyncio.Lock] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # --- joining and leaving ---------------------------------------------------------------------------

    async def join(self, diagram_id: str, client: Client, load: RoomLoader) -> Room:
        self._loop = asyncio.get_running_loop()
        lock = self._joining.setdefault(diagram_id, asyncio.Lock())
        async with lock:
            room = self._rooms.get(diagram_id)
            if room is None:
                family, model, version_id = await anyio.to_thread.run_sync(load)
                room = Room(diagram_id, family, model, version_id)
                self._rooms[diagram_id] = room
            room.clients[client.connection_id] = client
        client.send(
            {
                "type": "hello",
                "seq": room.seq,
                "model": room.model,
                "baseVersionId": room.base_version_id,
                "you": client.person(),
                "people": room.people(),
            }
        )
        # The newcomer's hello already lists everyone.
        room.broadcast({"type": "people", "people": room.people()}, except_for=client)
        return room

    def leave(self, room: Room, client: Client) -> None:
        room.clients.pop(client.connection_id, None)
        client.send(None)
        if room.clients:
            room.broadcast({"type": "people", "people": room.people()})
            return
        if self._rooms.get(room.diagram_id) is room:
            # The last one out: unsaved live changes go, as an unsaved tab's do.
            del self._rooms[room.diagram_id]
            if room.flushing is not None:
                room.flushing.cancel()

    def set_can_edit(self, room: Room, client: Client, can_edit: bool) -> None:
        if client.can_edit != can_edit:
            client.can_edit = can_edit
            room.broadcast({"type": "people", "people": room.people()})

    def room_for(self, diagram_id: str) -> Room | None:
        return self._rooms.get(diagram_id)

    # --- selections -------------------------------------------------------------------------------------

    def receive_selection(self, room: Room, client: Client, ids: Any) -> None:
        """Anyone may select, watchers too (to comment). Only the shape of the list is checked: ids that name
        nothing are simply not drawn."""
        if not isinstance(ids, list) or len(ids) > MAX_SELECTION or not all(_is_id(i) for i in ids):
            client.send({"type": "closed", "code": CLOSE_BAD_MESSAGE, "reason": "bad-selection"})
            return
        if ids == client.selection:
            return
        client.selection = list(ids)
        message = {"type": "selection", "connectionId": client.connection_id, "ids": client.selection}
        room.broadcast(message, except_for=client)

    # --- patches ------------------------------------------------------------------------------------------

    def receive_patch(self, room: Room, client: Client, client_patch_id: Any, patch: Any) -> None:
        if not client.can_edit:
            client.send(_rejected(client_patch_id, "You can only watch this diagram."))
            return
        if problem := patch_problem(patch):
            client.send(_rejected(client_patch_id, problem))
            return
        room.queue.append((client, client_patch_id, patch))
        if room.flushing is None or room.flushing.done():
            room.flushing = asyncio.create_task(self._flush(room))

    async def _flush(self, room: Room) -> None:
        while room.queue:
            wait = room.checked_at + CHECK_INTERVAL - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            batch, room.queue = room.queue, []
            start = room.model
            candidate = start
            for _, _, patch in batch:
                candidate = apply_patch(candidate, patch)
            if await self._still_a_diagram(room, candidate):
                accepted = batch
                room.model = candidate
            else:
                # Find the patch (or patches) at fault: each in turn on what was accepted before it.
                accepted = []
                current = start
                for entry in batch:
                    attempt = apply_patch(current, entry[2])
                    if await self._still_a_diagram(room, attempt):
                        accepted.append(entry)
                        current = attempt
                    else:
                        entry[0].send(_rejected(entry[1], "That change doesn't make a diagram Canvas can save."))
                room.model = current
            room.checked_at = time.monotonic()
            for client, client_patch_id, patch in accepted:
                room.seq += 1
                room.broadcast(
                    {
                        "type": "patch",
                        "seq": room.seq,
                        "by": client.connection_id,
                        "clientPatchId": client_patch_id,
                        "patch": patch,
                    }
                )

    async def _still_a_diagram(self, room: Room, model: dict[str, Any]) -> bool:
        def check() -> bool:
            if len(json.dumps(model, separators=(",", ":"), ensure_ascii=False)) > MAX_MODEL_BYTES:
                return False
            if not _links_allowed(model):
                return False
            try:
                dsl = self._core.serialize(room.family, model)
                return "model" in self._core.parse(room.family, dsl)
            except Exception:  # any failure to write or read it back means "not a diagram"
                return False

        return await anyio.to_thread.run_sync(check)

    # --- saves, from the HTTP routes (a worker thread) -------------------------------------------------

    def notify_saved(
        self,
        diagram_id: str,
        *,
        base_version_id: str,
        version_id: str,
        dsl: str,
        by: dict[str, Any],
        at: str,
        restored: bool,
    ) -> None:
        """After a save or restore commits. A save from the room's own base is everyone's save (`saved`); a
        restore, or a save from elsewhere, replaces the live model (`reset`)."""
        if diagram_id not in self._rooms or self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(
            self._saved(diagram_id, base_version_id, version_id, dsl, by, at, restored), self._loop
        )

    async def _saved(
        self,
        diagram_id: str,
        base_version_id: str,
        version_id: str,
        dsl: str,
        by: dict[str, Any],
        at: str,
        restored: bool,
    ) -> None:
        room = self._rooms.get(diagram_id)
        if room is None:
            return
        if not restored and room.base_version_id == base_version_id:
            room.base_version_id = version_id
            room.seq += 1
            room.broadcast({"type": "saved", "seq": room.seq, "versionId": version_id, "by": by, "at": at, "dsl": dsl})
            return
        parsed = await anyio.to_thread.run_sync(lambda: self._core.parse(room.family, dsl))
        if "model" not in parsed:
            log.warning("live room reset skipped: the saved version doesn't parse")
            return
        room.model = parsed["model"]
        room.base_version_id = version_id
        room.queue = []
        room.seq += 1
        room.broadcast(
            {
                "type": "reset",
                "seq": room.seq,
                "model": room.model,
                "baseVersionId": version_id,
                "by": by,
                "reason": "restored" if restored else "saved-elsewhere",
            }
        )

    def notify_deleted(self, diagram_id: str) -> None:
        if diagram_id not in self._rooms or self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._deleted(diagram_id), self._loop)

    async def _deleted(self, diagram_id: str) -> None:
        room = self._rooms.get(diagram_id)
        if room is None:
            return
        for client in list(room.clients.values()):
            # The connection's writer closes the socket after sending this.
            client.send({"type": "closed", "code": CLOSE_GONE, "reason": "deleted"})


#: Fields that hold a web address somewhere in a model (a node's link, sequence participant links, a flowchart
#: shape's image). Writing the model back would quietly drop a bad one, so the round trip alone can't see it.
_ADDRESS_KEYS = frozenset({"href", "url", "img", "src"})


def _links_allowed(value: Any, key: str | None = None) -> bool:
    """Every address in the model is one the parser lets through (http, https or relative)."""
    if isinstance(value, dict):
        return all(_links_allowed(v, k) for k, v in value.items())
    if isinstance(value, list):
        return all(_links_allowed(v, key) for v in value)
    if isinstance(value, str) and key in _ADDRESS_KEYS:
        return is_allowed_link_href(value)
    return True


def _is_id(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 200


def _rejected(client_patch_id: Any, message: str) -> dict[str, Any]:
    return {"type": "rejected", "clientPatchId": client_patch_id, "message": message}
