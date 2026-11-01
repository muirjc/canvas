"""Comments on a diagram (phase 3, canvas-1bty.7): the cases of apps/api/tests/contract/comments.test.ts.
Every response is also checked against the API contract (tests/api.py).

Left out:
- "purging a diagram removes its comments and read markers": purging is not a route; it is a TypeScript script.
- the setup (creating the diagram and sharing it through the API) is seeded directly: those routes haven't moved.
- "a soft-deleted diagram is 404": the diagram is soft-deleted in the database (DELETE /diagrams/:id hasn't moved).
Unread counts and thread order depend on timestamps, so comments they depend on are seeded at explicit instants.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest

from tests.api import MISSING_ID, T0, Api, User, minutes_after


@dataclass
class World:
    api: Api
    diagram: str
    owner: User
    admin: User
    viewer: User
    commenter: User
    editor: User
    stranger: User

    @property
    def base(self) -> str:
        return f"/diagrams/{self.diagram}/comments"

    def threads(self, who: User | None = None) -> list[dict[str, object]]:
        threads: list[dict[str, object]] = self.api.call("GET", self.base, who or self.owner).json()["threads"]
        return threads

    def post(self, who: User, body: str, **extra: object) -> str:
        response = self.api.call("POST", self.base, who, json={"body": body, **extra})
        assert response.status_code == 201, response.text
        comment_id: str = response.json()["id"]
        return comment_id

    def status(self, method: str, suffix: str, who: User, json: object = None) -> int:
        return self.api.call(method, f"{self.base}{suffix}", who, json=json).status_code

    def unread(self, who: User) -> int:
        unread: int = self.api.call("GET", f"{self.base}/unread", who).json()["unread"]
        return unread


@pytest.fixture()
def w(api: Api) -> World:
    api.diagram_type("flowchart")
    users = {
        "owner": api.user("owner@example.com", name="Olivia Owner"),
        "admin": api.user("admin@example.com", role="admin", name="Adam Admin"),
        "viewer": api.user("viewer@example.com", name="Vera Viewer"),
        "commenter": api.user("commenter@example.com", name="Cody Commenter"),
        "editor": api.user("editor@example.com", name="Edie Editor"),
        "stranger": api.user("stranger@example.com", name="Sam Stranger"),
    }
    project = api.project(users["owner"], "Comment project")
    diagram = api.diagram(project, users["owner"], "Commented")
    for who, level in (("viewer", "view"), ("commenter", "comment"), ("editor", "edit")):
        api.grant("diagram", diagram, users[who], level, users["owner"])
    return World(api, diagram, **users)


# --- threads, replies and the list shape ------------------------------------------------------------


def test_posts_a_thread_and_replies_and_lists_them_oldest_first_nested_with_author_names(w: World) -> None:
    first = w.api.comment(w.diagram, w.owner, "First thread", at=minutes_after(T0, 0))
    reply1 = w.api.comment(w.diagram, w.commenter, "A reply", root=first, at=minutes_after(T0, 1))
    second = w.api.comment(w.diagram, w.editor, "Second thread", at=minutes_after(T0, 2))
    reply2 = w.api.comment(w.diagram, w.owner, "Another reply", root=first, at=minutes_after(T0, 3))

    listed = w.threads()
    assert [t["id"] for t in listed] == [first, second]
    assert (
        listed[0]
        | {
            "body": "First thread",
            "author": {"id": w.owner.id, "name": "Olivia Owner"},
            "threadRootId": None,
            "anchor": None,
            "resolved": None,
            "deleted": False,
            "editedAt": None,
        }
        == listed[0]
    )
    replies = listed[0]["replies"]
    assert isinstance(replies, list)
    assert [r["id"] for r in replies] == [reply1, reply2]
    assert replies[0]["body"] == "A reply"
    assert replies[0]["author"]["name"] == "Cody Commenter"
    assert replies[0]["threadRootId"] == first
    assert listed[1]["replies"] == []
    assert listed[0]["createdAt"] == "2026-01-01T12:00:00.000Z"
    assert listed[1]["createdAt"] == "2026-01-01T12:02:00.000Z"


def test_posting_creates_a_thread_and_a_reply_through_the_api(w: World) -> None:
    root = w.post(w.owner, "Root")
    reply = w.post(w.commenter, "Reply", threadRootId=root)
    [thread] = w.threads()
    assert thread["id"] == root
    assert [r["id"] for r in thread["replies"]] == [reply]  # type: ignore[attr-defined]


def test_posting_returns_the_id_and_the_threads(w: World) -> None:
    response = w.api.call("POST", w.base, w.owner, json={"body": "Hello"})
    assert response.status_code == 201
    body = response.json()
    assert [t["body"] for t in body["threads"]] == ["Hello"]
    assert body["threads"][0]["id"] == body["id"]


def test_pins_a_thread_to_a_node_or_an_edge_and_never_pins_replies(w: World) -> None:
    on_node = w.post(w.owner, "About a node", anchor={"type": "node", "id": "n1"})
    on_edge = w.post(w.owner, "About an edge", anchor={"type": "edge", "id": "e1"})
    reply = w.post(w.commenter, "Reply with a stray anchor", threadRootId=on_node, anchor={"type": "edge", "id": "e9"})
    anchors = {t["id"]: t["anchor"] for t in w.threads()}
    assert anchors[on_node] == {"type": "node", "id": "n1"}
    assert anchors[on_edge] == {"type": "edge", "id": "e1"}
    stored = w.api.scalar("SELECT anchor_type FROM diagram_comments WHERE id = :id", id=reply)
    stored_id = w.api.scalar("SELECT anchor_id FROM diagram_comments WHERE id = :id", id=reply)
    assert (stored, stored_id) == (None, None)


def test_pins_a_thread_to_a_container(w: World) -> None:
    on_container = w.post(w.owner, "About a group", anchor={"type": "container", "id": "c1"})
    assert {t["id"]: t["anchor"] for t in w.threads()}[on_container] == {"type": "container", "id": "c1"}


@pytest.mark.parametrize("anchor_type", ["bogus", "diagram"])
def test_rejects_an_anchor_type_outside_node_edge_container(w: World, anchor_type: str) -> None:
    response = w.api.call("POST", w.base, w.owner, json={"body": "x", "anchor": {"type": anchor_type, "id": "n1"}})
    assert response.status_code == 400
    assert w.threads() == []


def test_trims_the_body(w: World) -> None:
    w.post(w.owner, "  padded  ")
    assert w.threads()[0]["body"] == "padded"


def test_replying_to_a_reply_or_to_another_diagrams_thread_is_404(w: World) -> None:
    root = w.post(w.owner, "Root")
    reply = w.post(w.owner, "Reply", threadRootId=root)
    assert w.status("POST", "", w.owner, {"body": "nested", "threadRootId": reply}) == 404

    other = w.api.diagram(w.api.project(w.owner, "Other"), w.owner, "Other")
    elsewhere = w.api.comment(other, w.owner, "elsewhere")
    assert w.status("POST", "", w.owner, {"body": "cross", "threadRootId": elsewhere}) == 404
    assert w.status("POST", "", w.owner, {"body": "ghost", "threadRootId": MISSING_ID}) == 404


@pytest.mark.parametrize("body", ["", "   \n  ", "x" * 4001])
def test_empty_whitespace_only_and_over_long_bodies_are_400(w: World, body: str) -> None:
    assert w.status("POST", "", w.owner, {"body": body}) == 400


def test_a_body_of_exactly_4000_characters_is_fine_and_a_missing_body_is_400(w: World) -> None:
    assert w.status("POST", "", w.owner, {"body": "x" * 4000}) == 201
    assert w.status("POST", "", w.owner, {}) == 400


def test_the_over_long_message_names_the_limit(w: World) -> None:
    response = w.api.call("POST", w.base, w.owner, json={"body": "x" * 4001})
    assert response.json() == {"error": "Comments can be at most 4000 characters."}


def test_the_empty_message_asks_for_text(w: World) -> None:
    response = w.api.call("POST", w.base, w.owner, json={"body": "  "})
    assert response.json() == {"error": "A comment needs some text."}


# --- who may do what ----------------------------------------------------------------------------------


def test_a_view_only_user_can_read_but_not_post_reply_edit_or_resolve(w: World) -> None:
    root = w.post(w.owner, "Root")
    assert w.status("GET", "", w.viewer) == 200
    assert w.status("GET", "/unread", w.viewer) == 200
    assert w.status("POST", "", w.viewer, {"body": "nope"}) == 403
    assert w.status("POST", "", w.viewer, {"body": "nope", "threadRootId": root}) == 403
    assert w.status("POST", f"/{root}/resolve", w.viewer) == 403
    assert w.status("POST", f"/{root}/reopen", w.viewer) == 403
    assert w.status("PATCH", f"/{root}", w.viewer, {"body": "edit"}) == 403


def test_the_refusal_says_what_was_needed_and_what_the_user_has(w: World) -> None:
    response = w.api.call("POST", w.base, w.viewer, json={"body": "nope"})
    assert response.status_code == 403
    assert response.json() == {
        "error": 'This action requires "comment" access, but you only have "view" access to this diagram.'
    }


@pytest.mark.parametrize("who", ["commenter", "editor"])
def test_comment_and_edit_level_users_can_post_reply_and_resolve(w: World, who: str) -> None:
    user: User = getattr(w, who)
    root = w.post(user, f"Root by {who}")
    w.post(user, "Reply", threadRootId=root)
    assert w.status("POST", f"/{root}/resolve", user) == 200


def test_the_owner_and_an_admin_can_post(w: World) -> None:
    w.post(w.owner, "Owner")
    w.post(w.admin, "Admin")
    assert len(w.threads()) == 2


def test_a_user_with_no_grant_can_read_comments_but_not_post_edit_delete_or_resolve(w: World) -> None:
    root = w.post(w.owner, "Root")
    assert w.status("GET", "", w.stranger) == 200
    assert w.status("GET", "/unread", w.stranger) == 200
    assert w.status("POST", "/read", w.stranger) == 204
    assert w.status("POST", "", w.stranger, {"body": "x"}) == 403
    assert w.status("PATCH", f"/{root}", w.stranger, {"body": "x"}) == 403
    assert w.status("DELETE", f"/{root}", w.stranger) == 403
    assert w.status("POST", f"/{root}/resolve", w.stranger) == 403


def test_signed_out_requests_are_401(w: World) -> None:
    root = w.post(w.owner, "Root")
    for method, suffix, body in (
        ("GET", "", None),
        ("POST", "", {"body": "x"}),
        ("DELETE", f"/{root}", None),
    ):
        response = w.api.call(method, f"{w.base}{suffix}", json=body)
        assert response.status_code == 401
        assert response.json() == {"error": "Authentication required"}


# --- editing ----------------------------------------------------------------------------------------


def test_the_author_can_edit_and_edited_at_is_set_but_nobody_else_can_not_even_the_owner(w: World) -> None:
    comment_id = w.post(w.commenter, "Original")
    edited = w.api.call("PATCH", f"{w.base}/{comment_id}", w.commenter, json={"body": " Changed "})
    assert edited.status_code == 200
    thread = edited.json()["threads"][0]
    assert thread["body"] == "Changed"
    assert thread["editedAt"] is not None

    for who in (w.owner, w.editor):
        refused = w.api.call("PATCH", f"{w.base}/{comment_id}", who, json={"body": "Hijack"})
        assert refused.status_code == 403
        assert refused.json() == {"error": "Only the author can edit a comment."}
    assert w.threads()[0]["body"] == "Changed"


def test_an_edit_validates_the_body_and_a_deleted_or_unknown_comment_is_404(w: World) -> None:
    comment_id = w.post(w.commenter, "Original")
    assert w.status("PATCH", f"/{comment_id}", w.commenter, {"body": "  "}) == 400
    unknown = w.api.call("PATCH", f"{w.base}/{MISSING_ID}", w.commenter, json={"body": "x"})
    assert unknown.status_code == 404
    assert unknown.json() == {"error": "No such comment on this diagram."}
    w.api.call("DELETE", f"{w.base}/{comment_id}", w.commenter)
    assert w.status("PATCH", f"/{comment_id}", w.commenter, {"body": "x"}) == 404


# --- deleting -----------------------------------------------------------------------------------------


def test_the_author_the_diagram_owner_and_an_admin_can_delete_a_comment_level_non_author_cannot(w: World) -> None:
    mine = w.post(w.commenter, "By commenter")
    others = w.post(w.editor, "By editor")
    w.post(w.owner, "Keeps the thread list non-empty")

    refused = w.api.call("DELETE", f"{w.base}/{others}", w.commenter)
    assert refused.status_code == 403
    assert refused.json() == {"error": "Only the author, the diagram's owner or an admin can delete a comment."}
    assert w.status("DELETE", f"/{others}", w.viewer) == 403
    assert w.status("DELETE", f"/{mine}", w.commenter) == 200
    assert w.status("DELETE", f"/{others}", w.owner) == 200

    third = w.post(w.commenter, "Another")
    assert w.status("DELETE", f"/{third}", w.admin) == 200


def test_a_deleted_reply_shows_deleted_with_an_empty_body_and_the_thread_still_reads(w: World) -> None:
    root = w.post(w.owner, "Root")
    reply = w.post(w.commenter, "Secret words", threadRootId=root)
    w.api.call("DELETE", f"{w.base}/{reply}", w.commenter)
    [thread] = w.threads()
    [deleted] = thread["replies"]  # type: ignore[misc]
    assert deleted["id"] == reply
    assert (deleted["deleted"], deleted["body"]) == (True, "")
    assert w.api.scalar("SELECT body FROM diagram_comments WHERE id = :id", id=reply) == ""


def test_a_deleted_root_with_live_replies_still_shows_and_a_thread_with_everything_deleted_disappears(w: World) -> None:
    root = w.post(w.owner, "Root")
    reply = w.post(w.commenter, "Reply", threadRootId=root)
    w.api.call("DELETE", f"{w.base}/{root}", w.owner)
    [thread] = w.threads()
    assert (thread["deleted"], thread["body"]) == (True, "")
    assert thread["replies"][0]["body"] == "Reply"  # type: ignore[index]

    w.api.call("DELETE", f"{w.base}/{reply}", w.commenter)
    assert w.threads() == []


def test_deleting_twice_or_an_unknown_comment_is_404(w: World) -> None:
    comment_id = w.post(w.owner, "x")
    assert w.status("DELETE", f"/{comment_id}", w.owner) == 200
    assert w.status("DELETE", f"/{comment_id}", w.owner) == 404
    assert w.status("DELETE", f"/{MISSING_ID}", w.owner) == 404


# --- resolve and reopen -----------------------------------------------------------------------------


def test_resolves_a_thread_root_only_with_who_resolved_it_and_reopens_it(w: World) -> None:
    root = w.post(w.owner, "Root")
    reply = w.post(w.commenter, "Reply", threadRootId=root)

    resolved = w.api.call("POST", f"{w.base}/{root}/resolve", w.editor)
    assert resolved.status_code == 200
    thread = resolved.json()["threads"][0]
    assert thread["resolved"]["by"] == "Edie Editor"
    assert datetime.fromisoformat(thread["resolved"]["at"].replace("Z", "+00:00")) > datetime(2020, 1, 1, tzinfo=UTC)

    reopened = w.api.call("POST", f"{w.base}/{root}/reopen", w.commenter)
    assert reopened.status_code == 200
    assert reopened.json()["threads"][0]["resolved"] is None

    for suffix in ("resolve", "reopen"):
        refused = w.api.call("POST", f"{w.base}/{reply}/{suffix}", w.owner)
        assert refused.status_code == 400
        assert refused.json() == {"error": "Resolve the thread, not a reply."}
    assert w.status("POST", f"/{MISSING_ID}/resolve", w.owner) == 404


def test_a_thread_whose_root_was_deleted_can_still_be_resolved(w: World) -> None:
    root = w.post(w.owner, "Root")
    w.post(w.commenter, "Reply", threadRootId=root)
    w.api.call("DELETE", f"{w.base}/{root}", w.owner)
    assert w.status("POST", f"/{root}/resolve", w.owner) == 200


# --- unread -------------------------------------------------------------------------------------------


def test_unread_counts_others_comments_since_the_last_read_never_your_own_or_deleted_ones(w: World) -> None:
    assert w.unread(w.owner) == 0
    w.api.comment(w.diagram, w.commenter, "One", at=minutes_after(T0, 0))
    two = w.api.comment(w.diagram, w.editor, "Two", at=minutes_after(T0, 1))
    w.api.comment(w.diagram, w.owner, "My own", at=minutes_after(T0, 2))
    assert w.unread(w.owner) == 2
    assert w.api.call("GET", w.base, w.owner).json()["unread"] == 2
    assert w.unread(w.commenter) == 2  # the editor's and the owner's, not their own
    w.api.call("DELETE", f"{w.base}/{two}", w.editor)
    assert w.unread(w.commenter) == 1  # only the owner's comment is left to read


def test_reading_resets_it_and_new_comments_count_again(w: World) -> None:
    w.api.comment(w.diagram, w.commenter, "One", at=minutes_after(T0, 0))
    assert w.unread(w.owner) == 1
    assert w.status("POST", "/read", w.owner) == 204
    assert w.unread(w.owner) == 0

    w.api.comment(w.diagram, w.commenter, "Two", at=datetime.now(UTC) + timedelta(hours=1))
    assert w.unread(w.owner) == 1


def test_posting_marks_everything_read(w: World) -> None:
    w.api.comment(w.diagram, w.commenter, "One", at=minutes_after(T0, 0))
    assert w.unread(w.owner) == 1
    w.post(w.owner, "Replying marks it all read")
    assert w.unread(w.owner) == 0


def test_unread_is_tracked_per_user(w: World) -> None:
    w.api.comment(w.diagram, w.commenter, "One", at=minutes_after(T0, 0))
    w.api.call("POST", f"{w.base}/read", w.owner)
    assert w.unread(w.owner) == 0
    assert w.unread(w.viewer) == 1


# --- deleted diagrams and authors -------------------------------------------------------------------


def test_a_soft_deleted_diagram_is_404_on_every_comment_route(w: World) -> None:
    root = w.post(w.owner, "Root")
    w.api.execute("UPDATE diagrams SET deleted_at = CURRENT_TIMESTAMP WHERE id = :id", id=w.diagram)
    assert w.status("GET", "", w.owner) == 404
    assert w.status("GET", "/unread", w.owner) == 404
    assert w.status("POST", "/read", w.owner) == 404
    assert w.status("POST", "", w.owner, {"body": "x"}) == 404
    assert w.status("PATCH", f"/{root}", w.owner, {"body": "x"}) == 404
    assert w.status("DELETE", f"/{root}", w.owner) == 404
    assert w.status("POST", f"/{root}/resolve", w.owner) == 404
    assert w.status("POST", f"/{root}/reopen", w.owner) == 404


def test_a_missing_diagram_is_404(w: World) -> None:
    response = w.api.call("GET", f"/diagrams/{MISSING_ID}/comments", w.owner)
    assert response.status_code == 404
    assert response.json() == {"error": "Diagram not found"}


def test_a_deleted_anonymised_author_shows_as_deleted_user(w: World) -> None:
    w.post(w.commenter, "Written before leaving")
    assert w.api.call("DELETE", f"/admin/users/{w.commenter.id}", w.admin).status_code == 200
    [thread] = w.threads()
    assert thread["author"]["name"] == "Deleted user"  # type: ignore[index]
    assert thread["body"] == "Written before leaving"
