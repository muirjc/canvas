"""canvas-vvi: live co-editing over WS /diagrams/{id}/live (canvas_api/live/hub.py, routes/live.py).

Every socket here shares the test client's one event loop (its portal), as the real server's one process does.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

import anyio
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from canvas_api.app import create_app
from canvas_api.config import Settings
from canvas_api.live.hub import LiveHub
from canvas_api.routes import live as live_route
from tests.api import Api, User

ORIGIN = "http://localhost:5173"
DSL = "flowchart TD\n  A[Start] --> B[End]\n"


@dataclass
class Setup:
    api: Api
    alice: User
    bob: User
    viewer: User
    project: str
    diagram: str


@pytest.fixture()
def s(api: Api) -> Setup:
    api.diagram_type("flowchart", name="Generic Flowchart")
    alice = api.user("alice@example.com", name="Alice")
    bob = api.user("bob@example.com", name="Bob")
    viewer = api.user("vic@example.com", role="viewer", name="Vic")
    project = api.project(alice)
    diagram = api.new_diagram(project, alice, "Live", dsl=DSL)["id"]
    api.grant("diagram", diagram, bob, "edit", alice)
    return Setup(api, alice, bob, viewer, project, diagram)


@contextmanager
def connect(
    client: TestClient, diagram: str, who: User | None, origin: str | None = ORIGIN
) -> Iterator[WebSocketTestSession]:
    client.cookies.clear()
    headers = {}
    if origin is not None:
        headers["origin"] = origin
    if who is not None:
        headers["cookie"] = f"cid={who.cookie}"
    with client.websocket_connect(f"/diagrams/{diagram}/live", headers=headers) as socket:
        # The server's first message (hello, or closed) ends its sign-in and access checks. Waiting for it
        # keeps two connections' checks apart: the tests' in-memory SQLite is one connection shared by every
        # thread (a file or Postgres has a pool).
        FIRST[id(socket)] = next_message(socket)
        yield socket


async def _within(stream: Any, seconds: float) -> Any:
    with anyio.fail_after(seconds):
        return await stream.receive()


def next_message(socket: WebSocketTestSession, seconds: float = 10.0) -> Any:
    """socket.receive_json(), but failing after `seconds` instead of waiting for ever (a missing message would
    otherwise hang the whole run)."""
    message = socket.portal.call(_within, socket._send_rx, seconds)
    socket._raise_on_close(message)
    return json.loads(message["text"])


FIRST: dict[int, dict[str, Any]] = {}


def receive(socket: WebSocketTestSession, kind: str) -> dict[str, Any]:
    """The next message of `kind`, passing over the others (people updates arrive whenever someone joins). The
    first message, taken by connect(), counts when it's the one asked for."""
    first = FIRST.pop(id(socket), None)
    if first is not None and first["type"] == kind:
        return first
    for _ in range(20):
        message: dict[str, Any] = next_message(socket)
        if message["type"] == kind:
            return message
    raise AssertionError(f"no {kind} message")


def rename(node: str, label: str) -> dict[str, Any]:
    return {"nodes": {"changed": [{"id": node, "set": {"label": label}}]}}


def room_closes(s: Setup) -> bool:
    """Whether the diagram's room is gone; the server sees a socket close a moment after the test does."""
    for _ in range(100):
        if hub(s).room_for(s.diagram) is None:
            return True
        time.sleep(0.02)
    return False


def hub(s: Setup) -> LiveHub:
    live_hub: LiveHub = s.api.client.app.state.live_hub  # type: ignore[attr-defined]
    return live_hub


def test_the_first_visitor_gets_the_saved_diagram_and_everyone_hears_who_is_here(s: Setup) -> None:
    client = s.api.client
    with connect(client, s.diagram, s.alice) as alice:
        hello = receive(alice, "hello")
        assert [n["id"] for n in hello["model"]["nodes"]] == ["A", "B"]
        assert hello["baseVersionId"] == s.api.current_version(s.diagram)
        assert hello["seq"] == 0
        assert hello["you"]["canEdit"] is True
        with connect(client, s.diagram, s.viewer) as vic:
            vic_hello = receive(vic, "hello")
            assert vic_hello["you"]["canEdit"] is False
            people = receive(alice, "people")["people"]
            assert {p["name"]: p["canEdit"] for p in people} == {"Alice": True, "Vic": False}


def test_a_patch_reaches_everyone_in_order_and_a_late_visitor_gets_the_live_model(s: Setup) -> None:
    client = s.api.client
    with connect(client, s.diagram, s.alice) as alice, connect(client, s.diagram, s.bob) as bob:
        me = receive(alice, "hello")["you"]["connectionId"]
        receive(bob, "hello")
        alice.send_json({"type": "patch", "clientPatchId": 1, "patch": rename("A", "Begin")})
        alice.send_json({"type": "patch", "clientPatchId": 2, "patch": rename("B", "Finish")})
        for socket in (alice, bob):
            first, second = receive(socket, "patch"), receive(socket, "patch")
            assert (first["seq"], first["clientPatchId"], first["by"]) == (1, 1, me)
            assert (second["seq"], second["clientPatchId"]) == (2, 2)
        with connect(client, s.diagram, s.viewer) as vic:
            hello = receive(vic, "hello")
            assert hello["seq"] == 2
            assert [n["label"] for n in hello["model"]["nodes"]] == ["Begin", "Finish"]


def test_someone_who_can_only_view_watches_but_cannot_change_anything(s: Setup) -> None:
    client = s.api.client
    with connect(client, s.diagram, s.alice) as alice, connect(client, s.diagram, s.viewer) as vic:
        receive(alice, "hello")
        receive(vic, "hello")
        vic.send_json({"type": "patch", "clientPatchId": "v1", "patch": rename("A", "Mine")})
        rejected = receive(vic, "rejected")
        assert rejected["clientPatchId"] == "v1"
        alice.send_json({"type": "patch", "clientPatchId": 1, "patch": rename("A", "Begin")})
        assert receive(vic, "patch")["patch"] == rename("A", "Begin")
        assert receive(alice, "patch")["seq"] == 1


@pytest.mark.parametrize(
    "patch",
    [
        {"set": {"diagramTypeId": "erd"}},
        {"nodes": {"added": [{"label": "no id"}]}},
        # A link the parser would never let through: it must not reach anyone else's browser.
        {"nodes": {"changed": [{"id": "A", "set": {"link": {"href": "javascript:alert(1)"}}}]}},
    ],
)
def test_a_patch_that_does_not_make_a_diagram_is_refused_and_goes_no_further(s: Setup, patch: Any) -> None:
    client = s.api.client
    with connect(client, s.diagram, s.alice) as alice, connect(client, s.diagram, s.bob) as bob:
        receive(alice, "hello")
        receive(bob, "hello")
        alice.send_json({"type": "patch", "clientPatchId": "bad", "patch": patch})
        assert receive(alice, "rejected")["clientPatchId"] == "bad"
        # The next good patch is number 1: the bad one never went out.
        alice.send_json({"type": "patch", "clientPatchId": "good", "patch": rename("A", "Begin")})
        message = receive(bob, "patch")
        assert (message["seq"], message["clientPatchId"]) == (1, "good")
    assert room_closes(s)


def test_one_bad_patch_in_a_batch_leaves_the_others_through(s: Setup) -> None:
    client = s.api.client
    with connect(client, s.diagram, s.alice) as alice:
        receive(alice, "hello")
        bad = {"nodes": {"changed": [{"id": "B", "set": {"link": {"href": "javascript:x"}}}]}}
        for number, patch in enumerate([rename("A", "One"), bad, rename("A", "Two")]):
            alice.send_json({"type": "patch", "clientPatchId": number, "patch": patch})
        messages = [next_message(alice) for _ in range(3)]
        assert sorted((m["type"], m["clientPatchId"]) for m in messages) == [
            ("patch", 0),
            ("patch", 2),
            ("rejected", 1),
        ]


def test_a_save_from_the_room_is_everyones_save(s: Setup) -> None:
    client = s.api.client
    base = s.api.current_version(s.diagram)
    with connect(client, s.diagram, s.alice) as alice, connect(client, s.diagram, s.bob) as bob:
        receive(alice, "hello")
        receive(bob, "hello")
        saved_dsl = "flowchart TD\n  A[Saved] --> B[End]\n"
        response = s.api.save_diagram(s.bob, s.diagram, saved_dsl, base)
        assert response.status_code == 200
        version = response.json()["diagram"]["currentVersionId"]
        for socket in (alice, bob):
            saved = receive(socket, "saved")
            assert saved["versionId"] == version
            assert saved["dsl"] == saved_dsl
            assert saved["by"]["name"] == "Bob"
        with connect(client, s.diagram, s.viewer) as vic:
            assert receive(vic, "hello")["baseVersionId"] == version


def test_a_restore_replaces_the_live_diagram_for_everyone(s: Setup) -> None:
    client = s.api.client
    first = s.api.current_version(s.diagram)
    s.api.save_diagram(s.alice, s.diagram, "flowchart TD\n  A[Second]\n")
    with connect(client, s.diagram, s.alice) as alice, connect(client, s.diagram, s.bob) as bob:
        receive(alice, "hello")
        receive(bob, "hello")
        alice.send_json({"type": "patch", "clientPatchId": 1, "patch": rename("A", "Unsaved")})
        receive(bob, "patch")
        response = s.api.call(
            "POST",
            f"/diagrams/{s.diagram}/versions/{first}/restore",
            s.bob,
            json={"baseVersionId": s.api.current_version(s.diagram)},
        )
        assert response.status_code == 200
        for socket in (alice, bob):
            reset = receive(socket, "reset")
            assert reset["reason"] == "restored"
            assert [n["label"] for n in reset["model"]["nodes"]] == ["Start", "End"]
            assert reset["baseVersionId"] == response.json()["diagram"]["currentVersionId"]


def test_deleting_the_diagram_ends_the_session(s: Setup) -> None:
    client = s.api.client
    with connect(client, s.diagram, s.bob) as bob:
        receive(bob, "hello")
        assert s.api.call("DELETE", f"/diagrams/{s.diagram}", s.alice).status_code == 204
        closed = receive(bob, "closed")
        assert closed["code"] == 4404
        with pytest.raises(WebSocketDisconnect) as ended:
            next_message(bob)
        assert ended.value.code == 4404


def test_a_page_on_another_site_cannot_open_a_session(s: Setup) -> None:
    for origin in (None, "https://evil.example"):
        with pytest.raises(WebSocketDisconnect) as refused, connect(s.api.client, s.diagram, s.alice, origin):
            pass
        assert refused.value.code == 1008


@pytest.mark.parametrize("who", ["nobody", "unfinished sign-in"])
def test_only_a_signed_in_person_gets_in(s: Setup, who: str) -> None:
    user = None
    if who == "unfinished sign-in":
        user = s.api.user("new@example.com")
        session = {
            "user": {"id": user.id, "email": user.email, "name": "New", "role": "architect", "mustChangePassword": 1},
            "authenticatedAt": 9999999999999,
        }
        s.api.execute("UPDATE sessions SET data = :d WHERE user_id = :u", d=json.dumps(session), u=user.id)
    with connect(s.api.client, s.diagram, user) as socket:
        assert receive(socket, "closed")["code"] == 4401


def test_someone_elses_draft_cannot_be_opened(s: Setup) -> None:
    draft = s.api.new_diagram(s.project, s.alice, "Draft", dsl=DSL, draft=True)["id"]
    with connect(s.api.client, draft, s.bob) as socket:
        assert receive(socket, "closed")["code"] == 4404
    with connect(s.api.client, "00000000-0000-0000-0000-000000000000", s.bob) as socket:
        assert receive(socket, "closed")["code"] == 4404


def test_a_removed_share_or_a_sign_out_is_noticed_while_connected(s: Setup, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live_route, "RECHECK_SECONDS", 0.0)
    client = s.api.client
    with connect(client, s.diagram, s.alice) as alice, connect(client, s.diagram, s.bob) as bob:
        receive(alice, "hello")
        receive(bob, "hello")
        receive(alice, "people")  # Bob joining
        s.api.execute("DELETE FROM share_grants WHERE grantee_user_id = :u", u=s.bob.id)
        bob.send_json({"type": "ping"})
        people = receive(alice, "people")["people"]
        assert {p["name"]: p["canEdit"] for p in people} == {"Alice": True, "Bob": False}
        bob.send_json({"type": "patch", "clientPatchId": 1, "patch": rename("A", "Late")})
        assert receive(bob, "rejected")["clientPatchId"] == 1
        s.api.execute("UPDATE sessions SET revoked = :yes, data = '{}' WHERE user_id = :u", yes=True, u=s.bob.id)
        bob.send_json({"type": "ping"})
        assert receive(bob, "closed")["code"] == 4401


def test_a_message_that_is_not_one_ends_the_session(s: Setup) -> None:
    with connect(s.api.client, s.diagram, s.alice) as alice:
        receive(alice, "hello")
        alice.send_text("not json")
        assert receive(alice, "closed")["code"] == 4400


def test_ping_gets_pong(s: Setup) -> None:
    with connect(s.api.client, s.diagram, s.alice) as alice:
        receive(alice, "hello")
        alice.send_json({"type": "ping"})
        assert receive(alice, "pong") == {"type": "pong"}


def test_the_room_goes_when_the_last_person_leaves(s: Setup) -> None:
    with connect(s.api.client, s.diagram, s.alice) as alice:
        receive(alice, "hello")
        assert hub(s).room_for(s.diagram) is not None
    assert room_closes(s)


def test_no_sessions_while_paused(settings: Settings, engine: Engine, s: Setup) -> None:
    paused = settings.model_copy(update={"paused_setting": "true"})
    with TestClient(create_app(paused, engine)) as client, connect(client, s.diagram, s.alice) as socket:
        assert receive(socket, "closed")["code"] == 1013


def test_a_selection_reaches_the_others_and_a_newcomer_sees_it(s: Setup) -> None:
    client = s.api.client
    with connect(client, s.diagram, s.alice) as alice, connect(client, s.diagram, s.viewer) as vic:
        me = receive(alice, "hello")["you"]["connectionId"]
        receive(vic, "hello")
        receive(alice, "people")  # Vic joining
        # Watchers select too (to comment); the selection goes to everyone else, not back.
        vic.send_json({"type": "select", "ids": ["A"]})
        message = receive(alice, "selection")
        assert message["ids"] == ["A"]
        alice.send_json({"type": "select", "ids": ["A", "B"]})
        assert receive(vic, "selection") == {"type": "selection", "connectionId": me, "ids": ["A", "B"]}
        with connect(client, s.diagram, s.bob) as bob:
            people = receive(bob, "hello")["people"]
            assert {p["name"]: p["selection"] for p in people} == {"Alice": ["A", "B"], "Vic": ["A"], "Bob": []}


@pytest.mark.parametrize("ids", ["A", [1], [""], ["x" * 201], ["a"] * 501])
def test_a_selection_that_is_not_a_list_of_ids_ends_the_session(s: Setup, ids: Any) -> None:
    with connect(s.api.client, s.diagram, s.alice) as alice:
        receive(alice, "hello")
        alice.send_json({"type": "select", "ids": ids})
        assert receive(alice, "closed")["code"] == 4400
