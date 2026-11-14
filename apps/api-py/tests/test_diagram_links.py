"""canvas-8uh1.2: the links index and its routes, GET /diagrams/:id/links and /diagrams/:id/used-in.

Links live in a diagram's own text (front matter `canvas.links`); the index copies them out whenever the text is
written (create, save, restore, import) and goes with the diagram when it is purged. Every response is checked
against the API contract (tests/api.py).
"""

from __future__ import annotations

from typing import Any

import pytest

from canvas_api.retention import purge_diagrams
from tests.api import Api, User


def _linking(*links: tuple[str, str]) -> str:
    """A flowchart whose nodes A, B, C exist, with `canvas.links` front matter."""
    lines = ["---", "canvas:", "  links:"] + [f"    {element}: {target}" for element, target in links]
    return "\n".join([*lines, "---", "flowchart TD", "  A --> B", "  B --> C", ""])


@pytest.fixture()
def owner(api: Api) -> User:
    api.diagram_type("flowchart", name="Generic Flowchart")
    return api.user("owner@example.com", name="Ozzy Owner")


@pytest.fixture()
def other(api: Api) -> User:
    return api.user("other@example.com", name="Olga Other")


@pytest.fixture()
def project(api: Api, owner: User, other: User) -> str:
    project_id = api.project(owner, "Payments")
    api.grant("project", project_id, other, "edit", owner)  # so Olga can make drafts there
    return project_id


def _links(api: Api, who: User, diagram_id: str) -> list[dict[str, Any]]:
    response = api.call("GET", f"/diagrams/{diagram_id}/links", who)
    assert response.status_code == 200, response.text
    links: list[dict[str, Any]] = response.json()["links"]
    return links


def _used_in(api: Api, who: User, diagram_id: str) -> list[dict[str, Any]]:
    response = api.call("GET", f"/diagrams/{diagram_id}/used-in", who)
    assert response.status_code == 200, response.text
    used: list[dict[str, Any]] = response.json()["usedIn"]
    return used


def test_a_diagram_with_no_links_has_none_and_is_used_nowhere(api: Api, owner: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, "Plain")
    assert _links(api, owner, diagram["id"]) == []
    assert _used_in(api, owner, diagram["id"]) == []


def test_links_made_on_create_are_listed_in_order_with_the_target_diagram(
    api: Api, owner: User, other: User, project: str
) -> None:
    container = api.new_diagram(project, owner, "Payments containers")
    context = api.new_diagram(project, owner, "Context", dsl=_linking(("B", container["id"]), ("A", container["id"])))
    expected_target = {
        "id": container["id"],
        "name": "Payments containers",
        "diagramTypeId": "flowchart",
        "projectId": project,
        "projectName": "Payments",
    }
    # Model order (A before B), not front-matter order; anyone signed in may read them.
    for who in (owner, other):
        assert _links(api, who, context["id"]) == [
            {"elementId": "A", "diagramId": container["id"], "status": "available", "diagram": expected_target},
            {"elementId": "B", "diagramId": container["id"], "status": "available", "diagram": expected_target},
        ]
    assert _used_in(api, other, container["id"]) == [
        {
            "diagramId": context["id"],
            "name": "Context",
            "diagramTypeId": "flowchart",
            "projectId": project,
            "projectName": "Payments",
            "elementIds": ["A", "B"],
        }
    ]


def test_a_save_replaces_the_links_and_a_restore_brings_old_ones_back(api: Api, owner: User, project: str) -> None:
    one = api.new_diagram(project, owner, "One")
    two = api.new_diagram(project, owner, "Two")
    source = api.new_diagram(project, owner, "Source", dsl=_linking(("A", one["id"])))
    first_version = api.current_version(source["id"])

    assert api.save_diagram(owner, source, _linking(("C", two["id"]))).status_code == 200
    assert [(link["elementId"], link["diagramId"]) for link in _links(api, owner, source["id"])] == [("C", two["id"])]
    assert _used_in(api, owner, one["id"]) == []
    assert [u["diagramId"] for u in _used_in(api, owner, two["id"])] == [source["id"]]

    restored = api.call(
        "POST",
        f"/diagrams/{source['id']}/versions/{first_version}/restore",
        owner,
        json={"baseVersionId": api.current_version(source["id"])},
    )
    assert restored.status_code == 200, restored.text
    assert [link["diagramId"] for link in _links(api, owner, source["id"])] == [one["id"]]

    assert api.save_diagram(owner, source, "flowchart TD\n  A --> B\n").status_code == 200
    assert _links(api, owner, source["id"]) == []


def test_a_conflicting_save_leaves_the_links_as_they_were(api: Api, owner: User, project: str) -> None:
    one = api.new_diagram(project, owner, "One")
    source = api.new_diagram(project, owner, "Source", dsl=_linking(("A", one["id"])))
    stale = api.current_version(source["id"])
    assert api.save_diagram(owner, source, _linking(("A", one["id"]), ("B", one["id"]))).status_code == 200
    conflict = api.save_diagram(owner, source, "flowchart TD\n  A --> B\n", base=stale)
    assert conflict.status_code == 409
    assert [link["elementId"] for link in _links(api, owner, source["id"])] == ["A", "B"]


def test_imported_text_is_indexed(api: Api, owner: User, project: str) -> None:
    target = api.new_diagram(project, owner, "Target")
    response = api.call(
        "POST",
        f"/projects/{project}/diagrams/import",
        owner,
        json={"name": "Imported", "dslContent": _linking(("B", target["id"])), "diagramTypeId": "flowchart"},
    )
    assert response.status_code == 201, response.text
    assert [u["name"] for u in _used_in(api, owner, target["id"])] == ["Imported"]


def test_each_state_of_a_linked_diagram(api: Api, owner: User, other: User, project: str) -> None:
    binned = api.new_diagram(project, owner, "Binned")
    draft = api.new_diagram(project, other, "Olga's draft", draft=True)
    purged = api.new_diagram(project, owner, "Purged")
    source = api.new_diagram(
        project, owner, "Source", dsl=_linking(("A", binned["id"]), ("B", draft["id"]), ("C", purged["id"]))
    )
    assert api.call("DELETE", f"/diagrams/{binned['id']}", owner).status_code == 204
    purge_diagrams(api.engine, [purged["id"]])
    by_element = {link["elementId"]: link for link in _links(api, owner, source["id"])}
    assert {k: v["status"] for k, v in by_element.items()} == {"A": "deleted", "B": "unavailable", "C": "missing"}
    assert all(link["diagram"] is None for link in by_element.values())
    # The draft's creator can open it, so for them it is available.
    assert next(link for link in _links(api, other, source["id"]) if link["elementId"] == "B")["status"] == "available"
    # An id no diagram has, and one that isn't a Canvas diagram id at all, are missing.
    unknown = "00000000-0000-4000-8000-000000000000"
    assert api.save_diagram(owner, source, _linking(("A", unknown), ("B", "c4-container-x"))).status_code == 200
    assert [link["status"] for link in _links(api, owner, source["id"])] == ["missing", "missing"]


def test_used_in_leaves_out_the_bin_and_other_peoples_drafts(api: Api, owner: User, other: User, project: str) -> None:
    target = api.new_diagram(project, owner, "Target")
    kept = api.new_diagram(project, owner, "Kept", dsl=_linking(("A", target["id"])))
    binned = api.new_diagram(project, owner, "Binned", dsl=_linking(("A", target["id"])))
    olgas = api.new_diagram(project, other, "Olga draft", dsl=_linking(("A", target["id"])), draft=True)
    assert api.call("DELETE", f"/diagrams/{binned['id']}", owner).status_code == 204
    assert [u["diagramId"] for u in _used_in(api, owner, target["id"])] == [kept["id"]]
    assert [u["diagramId"] for u in _used_in(api, other, target["id"])] == [kept["id"], olgas["id"]]
    # Restoring from the bin brings its link back: the rows stay with a soft-deleted diagram.
    admin = api.user("admin@example.com", "admin")
    assert api.call("POST", f"/diagrams/{binned['id']}/restore", admin).status_code == 200
    assert {u["name"] for u in _used_in(api, owner, target["id"])} == {"Kept", "Binned"}


def test_purging_a_diagram_removes_its_rows(api: Api, owner: User, project: str) -> None:
    target = api.new_diagram(project, owner, "Target")
    source = api.new_diagram(project, owner, "Source", dsl=_linking(("A", target["id"])))
    purge_diagrams(api.engine, [source["id"]])
    assert api.scalar("SELECT COUNT(*) FROM diagram_links WHERE source_diagram_id = :id", id=source["id"]) == 0
    assert _used_in(api, owner, target["id"]) == []


def test_the_routes_need_sign_in_and_a_diagram_you_can_see(api: Api, owner: User, other: User, project: str) -> None:
    diagram = api.new_diagram(project, owner, "D")
    draft = api.new_diagram(project, owner, "Draft", draft=True)
    for route in ("links", "used-in"):
        assert api.call("GET", f"/diagrams/{diagram['id']}/{route}").status_code == 401
        assert api.call("GET", f"/diagrams/{draft['id']}/{route}", other).status_code == 404
        assert api.call("GET", f"/diagrams/00000000-0000-4000-8000-000000000000/{route}", owner).status_code == 404
    assert api.call("DELETE", f"/diagrams/{diagram['id']}", owner).status_code == 204
    assert api.call("GET", f"/diagrams/{diagram['id']}/links", owner).status_code == 404


# --- canvas-8uh1.6: frames ----------------------------------------------------------------------------


def _framing(*frames: tuple[str, str]) -> str:
    """A flowchart with `canvas.frames` front matter, one frame per (frame id, diagram id)."""
    lines = ["---", "canvas:", "  frames:"]
    for i, (frame_id, target) in enumerate(frames):
        lines += [
            f"    - id: {frame_id}",
            f"      diagramId: {target}",
            f"      x: {400 + 400 * i}",
            "      y: 40",
            "      width: 360",
            "      height: 240",
        ]
    return "\n".join([*lines, "---", "flowchart TD", "  A --> B", ""])


def test_frames_are_indexed_and_count_as_used_in(api: Api, owner: User, project: str) -> None:
    target = api.new_diagram(project, owner, "Target")
    source = api.new_diagram(project, owner, "Source", dsl=_framing(("f1", target["id"])))
    assert _used_in(api, owner, target["id"]) == [
        {
            "diagramId": source["id"],
            "name": "Source",
            "diagramTypeId": "flowchart",
            "projectId": project,
            "projectName": "Payments",
            "elementIds": ["f1"],
        }
    ]
    assert _links(api, owner, source["id"]) == []  # frames aren't links
    assert api.save_diagram(owner, source, "flowchart TD\n  A --> B\n").status_code == 200
    assert _used_in(api, owner, target["id"]) == []


def test_frame_contents_give_each_framed_diagrams_state_and_drawing(
    api: Api, owner: User, other: User, project: str
) -> None:
    inner_target = api.new_diagram(project, owner, "Deepest")
    inner = api.new_diagram(project, owner, "Inner", dsl=_framing(("f1", inner_target["id"])))
    binned = api.new_diagram(project, owner, "Binned")
    draft = api.new_diagram(project, other, "Olga's draft", draft=True)
    assert api.call("DELETE", f"/diagrams/{binned['id']}", owner).status_code == 204
    source = api.new_diagram(project, owner, "Source")
    unknown = "00000000-0000-4000-8000-000000000000"
    ids = ",".join([inner["id"], binned["id"], draft["id"], unknown, "nonsense", inner["id"]])
    response = api.call("GET", f"/diagrams/{source['id']}/frame-contents?ids={ids}", owner)
    assert response.status_code == 200, response.text
    frames = response.json()["frames"]
    assert [(f["diagramId"], f["status"]) for f in frames] == [
        (inner["id"], "available"),
        (binned["id"], "deleted"),
        (draft["id"], "unavailable"),
        (unknown, "missing"),
        ("nonsense", "missing"),
    ]
    first = frames[0]
    assert first["diagram"]["name"] == "Inner"
    assert first["svg"].startswith("<svg")
    # One level deep: the framed diagram's own frame is a placeholder, not Deepest's drawing.
    assert 'class="diagram-frame"' in first["svg"]
    assert "Embedded diagram" in first["svg"]
    assert all(f["svg"] is None and f["diagram"] is None for f in frames[1:])
    # Olga sees her own draft.
    mine = api.call("GET", f"/diagrams/{source['id']}/frame-contents?ids={draft['id']}", other).json()["frames"]
    assert mine[0]["status"] == "available"
    empty = api.call("GET", f"/diagrams/{source['id']}/frame-contents?ids=", owner)
    assert empty.json() == {"frames": []}


def test_frame_contents_need_sign_in_and_a_diagram_you_can_see(
    api: Api, owner: User, other: User, project: str
) -> None:
    draft = api.new_diagram(project, owner, "Draft", draft=True)
    assert api.call("GET", f"/diagrams/{draft['id']}/frame-contents?ids=x").status_code == 401
    assert api.call("GET", f"/diagrams/{draft['id']}/frame-contents?ids=x", other).status_code == 404
