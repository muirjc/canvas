"""Diagram versions, save conflicts and presence (phase 4, canvas-1bty.8), the cases of apps/api/tests/contract/
versions and edit-conflict. Every response is also checked against the API contract (tests/api.py). Saves
parse through the diagram-core bridge (`needs_bridge`).

Left out:
- edit-conflict.test.ts's "of two saves from the same version at the same moment, exactly one wins" uses
  Promise.all against one server. Here requests go through a synchronous test client over a shared (SQLite
  in-memory) connection, so there is no real concurrency to test; the same compare-and-set is covered by the
  sequential "refuses a save from a version someone else has replaced" case.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import pytest
from sqlalchemy import text

from canvas_api.timestamps import to_db
from tests.api import MISSING_ID, Api, User


@dataclass
class Setup:
    api: Api
    alice: User
    project: str


@pytest.fixture()
def s(api: Api, needs_bridge: str) -> Setup:
    api.diagram_type("flowchart", name="Generic Flowchart")
    alice = api.user("architect@example.com", name="Archie Architect")
    return Setup(api, alice, api.project(alice, "Test Project"))


def history(s: Setup, saves: int) -> str:
    """A diagram saved `saves` further times, so it has saves + 1 versions (A[V1] ... A[V<n>])."""
    diagram = s.api.new_diagram(s.project, s.alice, "History", dsl="flowchart TD\n  A[V1]\n")
    for i in range(2, saves + 2):
        assert s.api.save_diagram(s.alice, diagram, f"flowchart TD\n  A[V{i}]\n").status_code == 200
    return str(diagram["id"])


def versions(s: Setup, diagram: str, query: str = "") -> list[dict[str, Any]]:
    response = s.api.call("GET", f"/diagrams/{diagram}/versions{query}", s.alice)
    assert response.status_code == 200, response.text
    found: list[dict[str, Any]] = response.json()["versions"]
    return found


def numbers(found: list[dict[str, Any]]) -> list[int]:
    return [v["sequenceNumber"] for v in found]


def restore(s: Setup, diagram: str, version: str, base: str | None = None, who: User | None = None) -> Any:
    return s.api.call(
        "POST",
        f"/diagrams/{diagram}/versions/{version}/restore",
        who or s.alice,
        json={"baseVersionId": base or s.api.current_version(diagram)},
    )


# --- versions.test.ts ---------------------------------------------------------------------------------


def test_versions_list_newest_first_and_restoring_an_old_one_appends_a_new_version(s: Setup) -> None:
    diagram = history(s, 2)
    listed = versions(s, diagram)
    assert numbers(listed) == [3, 2, 1]

    restored = restore(s, diagram, listed[2]["id"])
    assert restored.status_code == 200
    assert "V1" in restored.json()["diagram"]["dslContent"]
    # Restoring appended a 4th version; it didn't delete or rewrite versions 1-3.
    assert numbers(versions(s, diagram)) == [4, 3, 2, 1]


def test_restoring_a_version_that_does_not_belong_to_the_diagram_is_a_404(s: Setup) -> None:
    diagram = s.api.new_diagram(s.project, s.alice, "D1")["id"]
    assert restore(s, diagram, MISSING_ID).status_code == 404


def test_restoring_a_version_of_another_diagram_is_a_404(s: Setup) -> None:
    mine = history(s, 1)
    other = history(s, 1)
    foreign = versions(s, other)[0]["id"]
    assert restore(s, mine, foreign).status_code == 404
    assert numbers(versions(s, mine)) == [2, 1]


def test_restore_needs_a_base_version(s: Setup) -> None:
    diagram = history(s, 1)
    version = versions(s, diagram)[1]["id"]
    assert s.api.call("POST", f"/diagrams/{diagram}/versions/{version}/restore", s.alice, json={}).status_code == 400


def test_returns_at_most_five_versions_by_default_newest_first(s: Setup) -> None:
    found = versions(s, history(s, 9))
    assert len(found) == 5
    assert found[0]["sequenceNumber"] == 10


def test_says_when_older_versions_exist_beyond_those_returned(s: Setup) -> None:
    diagram = history(s, 9)
    assert s.api.call("GET", f"/diagrams/{diagram}/versions", s.alice).json()["hasMore"] is True


def test_exactly_five_versions_does_not_imply_hidden_ones(s: Setup) -> None:
    diagram = history(s, 4)
    body = s.api.call("GET", f"/diagrams/{diagram}/versions", s.alice).json()
    assert len(body["versions"]) == 5
    assert body["hasMore"] is False


def test_search_finds_an_older_version_the_default_response_omits(s: Setup) -> None:
    diagram = history(s, 9)
    assert 2 not in numbers(versions(s, diagram))
    assert 2 in numbers(versions(s, diagram, "?q=2"))


def test_a_version_found_by_search_is_restorable_like_a_recent_one(s: Setup) -> None:
    diagram = history(s, 9)
    target = next(v for v in versions(s, diagram, "?q=2") if v["sequenceNumber"] == 2)
    assert restore(s, diagram, target["id"]).status_code == 200


def test_a_search_that_matches_nothing_is_an_empty_list_not_an_error(s: Setup) -> None:
    assert versions(s, history(s, 3), "?q=zzzznomatch") == []


def test_honours_an_explicit_limit(s: Setup) -> None:
    assert len(versions(s, history(s, 9), "?limit=2")) == 2


def test_the_limit_is_at_least_one(s: Setup) -> None:
    assert len(versions(s, history(s, 2), "?limit=0")) == 1


def test_listing_versions_requires_authentication(s: Setup) -> None:
    assert s.api.call("GET", f"/diagrams/{history(s, 1)}/versions").status_code == 401


@pytest.mark.parametrize("q", ["2", "v2", "V2", "#2", "v 2"])
def test_finds_a_version_by_number_written_as_2_v2_V2_or_hash_2(s: Setup, q: str) -> None:
    diagram = history(s, 9)
    assert numbers(versions(s, diagram, "?" + _query(q))) == [2]


def test_each_version_carries_its_authors_name_which_is_searchable(s: Setup) -> None:
    diagram = history(s, 2)
    found = versions(s, diagram)
    assert found[0]["authorName"] == "Archie Architect"
    assert len(versions(s, diagram, "?" + _query("ARCH"))) == 3
    assert len(versions(s, diagram, "?" + _query("architect@example"))) == 3
    assert versions(s, diagram, "?" + _query("someone-else")) == []


def test_filters_by_a_from_to_range_and_rejects_a_malformed_instant(s: Setup) -> None:
    diagram = history(s, 2)
    now = datetime.now().astimezone()

    def iso(delta: timedelta) -> str:
        return (now + delta).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    in_range = f"?from={iso(timedelta(hours=-1))}&to={iso(timedelta(hours=1))}"
    assert len(versions(s, diagram, in_range)) == 3
    assert versions(s, diagram, f"?from={iso(timedelta(days=1))}") == []
    assert s.api.call("GET", f"/diagrams/{diagram}/versions?from=not-a-date", s.alice).status_code == 400
    assert s.api.call("GET", f"/diagrams/{diagram}/versions?to=2026-13-45", s.alice).status_code == 400


def test_the_to_bound_is_exclusive_and_the_from_bound_inclusive(s: Setup) -> None:
    diagram = history(s, 2)
    stamps = [
        (v["sequenceNumber"], to_db(datetime(2026, 3, 1, 12, v["sequenceNumber"], tzinfo=UTC), s.api.dialect))
        for v in versions(s, diagram)
    ]
    for number, at in stamps:
        s.api.execute(
            "UPDATE diagram_versions SET created_at = :at WHERE diagram_id = :id AND sequence_number = :n",
            at=at,
            id=diagram,
            n=number,
        )
    assert numbers(versions(s, diagram, "?from=2026-03-01T12:02:00Z&to=2026-03-01T12:03:00Z")) == [2]
    assert numbers(versions(s, diagram, "?from=2026-03-01T12:02:00Z")) == [3, 2]
    assert numbers(versions(s, diagram, "?to=2026-03-01T12:02:00Z")) == [1]


def test_a_restored_version_is_labelled_with_the_version_it_came_from(s: Setup) -> None:
    diagram = history(s, 2)
    v1 = versions(s, diagram, "?q=1")[0]
    assert restore(s, diagram, v1["id"]).status_code == 200
    latest = versions(s, diagram)
    assert latest[0]["sequenceNumber"] == 4
    assert latest[0]["restoredFromSequence"] == 1
    assert latest[1]["restoredFromSequence"] is None


def test_returns_one_version_with_its_content_for_preview_scoped_to_its_diagram(s: Setup) -> None:
    diagram = history(s, 2)
    v2 = versions(s, diagram, "?q=2")[0]
    response = s.api.call("GET", f"/diagrams/{diagram}/versions/{v2['id']}", s.alice)
    assert response.status_code == 200
    version = response.json()["version"]
    assert version["id"] == v2["id"]
    assert version["sequenceNumber"] == 2
    assert version["restoredFromSequence"] is None
    assert "A[V2]" in version["dslContent"]

    other = history(s, 0)
    assert s.api.call("GET", f"/diagrams/{other}/versions/{v2['id']}", s.alice).status_code == 404
    assert s.api.call("GET", f"/diagrams/{diagram}/versions/{v2['id']}").status_code == 401


# --- edit-conflict.test.ts ----------------------------------------------------------------------------


@dataclass
class Team:
    s: Setup
    bob: User
    viewer: User
    diagram: str

    def save(self, who: User, dsl: str, base: object = ...) -> Any:
        body: dict[str, Any] = {"dslContent": dsl}
        if base is ...:
            body["baseVersionId"] = self.s.api.current_version(self.diagram)
        elif base is not None:
            body["baseVersionId"] = base
        return self.s.api.call("PATCH", f"/diagrams/{self.diagram}", who, json=body)

    def beat(self, who: User, session_id: str) -> Any:
        return self.s.api.call("PUT", f"/diagrams/{self.diagram}/presence", who, json={"sessionId": session_id})

    def leave(self, who: User, session_id: str) -> Any:
        return self.s.api.call("POST", f"/diagrams/{self.diagram}/presence/leave", who, json={"sessionId": session_id})

    def contents(self) -> list[str]:
        with self.s.api.engine.connect() as conn:
            rows = conn.execute(
                text("SELECT dsl_content FROM diagram_versions WHERE diagram_id = :id"), {"id": self.diagram}
            ).all()
        return [r.dsl_content for r in rows]


@pytest.fixture()
def team(s: Setup) -> Team:
    bob = s.api.user("bob@example.com", name="Bob Builder")
    viewer = s.api.user("viewer@example.com", name="Vic Viewer")
    diagram = s.api.new_diagram(s.project, s.alice, "Shared", dsl="flowchart TD\n  A[Start]\n")["id"]
    s.api.grant("diagram", diagram, bob, "edit", s.alice)
    s.api.grant("diagram", diagram, viewer, "view", s.alice)
    return Team(s, bob, viewer, diagram)


def test_a_diagram_says_which_version_it_is_on_and_a_save_from_that_version_moves_it_on(team: Team) -> None:
    api = team.s.api
    loaded = api.call("GET", f"/diagrams/{team.diagram}", team.s.alice).json()["diagram"]
    assert isinstance(loaded["currentVersionId"], str)
    response = team.save(team.s.alice, "flowchart TD\n  A[Two]\n", loaded["currentVersionId"])
    assert response.status_code == 200
    assert response.json()["diagram"]["currentVersionId"] != loaded["currentVersionId"]


def test_a_save_requires_the_base_version(team: Team) -> None:
    assert team.save(team.s.alice, "flowchart TD\n  A[Two]\n", None).status_code == 400


def test_a_save_from_a_version_someone_else_replaced_is_refused_says_who_and_when_and_writes_nothing(
    team: Team,
) -> None:
    alice = team.s.alice
    base = team.s.api.current_version(team.diagram)
    bob_save = team.save(team.bob, "flowchart TD\n  B[Bob]\n", base)
    assert bob_save.status_code == 200

    refused = team.save(alice, "flowchart TD\n  A[Alice]\n", base)
    assert refused.status_code == 409
    body = refused.json()
    assert body["code"] == "version_conflict"
    assert "Bob Builder" in body["error"]
    assert body["details"]["currentVersionId"] == bob_save.json()["diagram"]["currentVersionId"]
    assert body["details"]["savedBy"]["name"] == "Bob Builder"
    assert body["details"]["savedBy"]["id"] == team.bob.id
    assert isinstance(body["details"]["savedAt"], str)
    datetime.fromisoformat(body["details"]["savedAt"].replace("Z", "+00:00"))

    # Bob's content stands, and Alice's refused save left no version behind.
    assert "B[Bob]" in team.s.api.call("GET", f"/diagrams/{team.diagram}", alice).json()["diagram"]["dslContent"]
    contents = team.contents()
    assert not any("A[Alice]" in c for c in contents)
    assert len(contents) == 2


def test_saving_anyway_from_the_newer_version_overwrites_deliberately_keeping_theirs_in_history(team: Team) -> None:
    base = team.s.api.current_version(team.diagram)
    team.save(team.bob, "flowchart TD\n  B[Bob]\n", base)
    conflict = team.save(team.s.alice, "flowchart TD\n  A[Alice]\n", base).json()
    retry = team.save(team.s.alice, "flowchart TD\n  A[Alice]\n", conflict["details"]["currentVersionId"])
    assert retry.status_code == 200
    assert "B[Bob]" in "|".join(team.contents())


def test_restoring_on_top_of_a_newer_save_is_refused_the_same_way(team: Team) -> None:
    base = team.s.api.current_version(team.diagram)
    team.save(team.bob, "flowchart TD\n  B[Bob]\n", base)
    response = team.s.api.call(
        "POST",
        f"/diagrams/{team.diagram}/versions/{base}/restore",
        team.s.alice,
        json={"baseVersionId": base},
    )
    assert response.status_code == 409
    assert response.json()["details"]["savedBy"]["name"] == "Bob Builder"
    assert len(team.contents()) == 2


def test_a_save_that_does_not_parse_writes_no_version(team: Team) -> None:
    refused = team.save(team.s.alice, "flowchart TD\n  ???not-valid???\n")
    assert refused.status_code == 422
    assert len(team.contents()) == 1


# --- edit-conflict.test.ts: presence ------------------------------------------------------------------


def test_presence_tells_each_editor_who_else_has_the_diagram_open_and_forgets_a_tab_that_leaves(team: Team) -> None:
    alice, bob = team.s.alice, team.bob
    assert team.beat(alice, "alice-tab").json()["others"] == []
    bob_view = team.beat(bob, "bob-tab").json()
    assert bob_view["heartbeatSeconds"] == 30
    assert len(bob_view["others"]) == 1
    assert bob_view["others"][0]["name"] == "Archie Architect"
    assert bob_view["others"][0]["isYou"] is False
    assert bob_view["others"][0]["userId"] == alice.id
    assert [o["name"] for o in team.beat(alice, "alice-tab").json()["others"]] == ["Bob Builder"]

    assert team.leave(bob, "bob-tab").status_code == 204
    assert team.beat(alice, "alice-tab").json()["others"] == []


def test_presence_says_when_it_is_you_in_another_tab(team: Team) -> None:
    team.beat(team.s.alice, "tab-1.1")
    others = team.beat(team.s.alice, "tab-2.1").json()["others"]
    assert len(others) == 1
    assert others[0]["isYou"] is True
    assert others[0]["name"] == "You"


def test_a_remount_of_the_same_tab_is_not_another_editor_and_its_late_goodbye_keeps_the_live_one(team: Team) -> None:
    alice, bob = team.s.alice, team.bob
    team.beat(alice, "tab-1.1")
    assert team.beat(alice, "tab-1.2").json()["others"] == []
    team.beat(bob, "bob.1")
    # The first mount's goodbye arrives after the second mount's heartbeat.
    team.leave(alice, "tab-1.1")
    assert [o["name"] for o in team.beat(bob, "bob.1").json()["others"]] == ["Archie Architect"]


def test_presence_lists_other_people_before_your_own_other_tabs(team: Team) -> None:
    alice, bob = team.s.alice, team.bob
    team.beat(alice, "tab-1.1")
    team.beat(bob, "bob.1")
    team.beat(alice, "tab-2.1")
    assert [o["name"] for o in team.beat(alice, "tab-3.1").json()["others"]] == ["Bob Builder", "You"]


def test_an_editor_not_heard_from_for_90_seconds_is_dropped(team: Team) -> None:
    team.beat(team.bob, "bob-tab")
    long_ago = to_db(datetime.now().astimezone() - timedelta(seconds=91), team.s.api.dialect)
    team.s.api.execute("UPDATE diagram_edit_sessions SET last_seen_at = :at, started_at = :at", at=long_ago)
    assert team.beat(team.s.alice, "alice-tab").json()["others"] == []


def test_presence_is_for_editors_a_viewer_cannot_announce_themselves(team: Team) -> None:
    assert team.beat(team.viewer, "viewer-tab").status_code == 403
    assert team.leave(team.viewer, "viewer-tab").status_code == 403


def test_presence_requires_a_session_id(team: Team) -> None:
    response = team.s.api.call("PUT", f"/diagrams/{team.diagram}/presence", team.s.alice, json={})
    assert response.status_code == 400


# --- helpers ------------------------------------------------------------------------------------------


def _query(q: str) -> str:
    return urlencode({"q": q})
