"""How reviews and checks collapse into the one state the editor shows (canvas-3s5.2). Port of
apps/api/tests/unit/github-status-summaries.test.ts."""

from __future__ import annotations

from canvas_api.github.client import Check, Review
from canvas_api.github.sync import summarize_checks, summarize_reviews


def review(login: str, state: str) -> Review:
    return Review(login, state, None)


def check(name: str, state: str) -> Check:
    return {"name": name, "state": state, "url": None}


def test_no_reviews_and_no_requests_none() -> None:
    assert summarize_reviews([], []) == ("none", [])


def test_only_comments_or_pending_reviews_are_not_a_decision() -> None:
    assert summarize_reviews([review("a", "COMMENTED"), review("b", "PENDING")], [])[0] == "none"


def test_an_approval_stands_after_a_later_comment_from_the_same_reviewer() -> None:
    assert summarize_reviews([review("a", "APPROVED"), review("a", "COMMENTED")], []) == (
        "approved",
        [{"login": "a", "state": "APPROVED"}],
    )


def test_a_reviewers_latest_decision_replaces_their_earlier_one_in_either_direction() -> None:
    assert summarize_reviews([review("a", "APPROVED"), review("a", "CHANGES_REQUESTED")], [])[0] == "changes_requested"
    assert summarize_reviews([review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")], [])[0] == "approved"


def test_one_reviewer_requesting_changes_beats_another_approving() -> None:
    assert summarize_reviews([review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")], [])[0] == "changes_requested"


def test_a_dismissed_review_is_dropped_from_the_decisions() -> None:
    assert summarize_reviews([review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED")], []) == ("none", [])
    reviews = [review("a", "APPROVED"), review("b", "CHANGES_REQUESTED"), review("b", "DISMISSED")]
    assert summarize_reviews(reviews, [])[0] == "approved"


def test_an_outstanding_request_is_pending_even_with_an_approval_but_changes_requested_still_wins() -> None:
    assert summarize_reviews([review("a", "APPROVED")], ["carl"])[0] == "pending"
    assert summarize_reviews([], ["carl"])[0] == "pending"
    assert summarize_reviews([review("a", "CHANGES_REQUESTED")], ["carl"])[0] == "changes_requested"


def test_checks_none_when_there_are_no_checks() -> None:
    assert summarize_checks([]) == "none"


def test_checks_failure_beats_pending_beats_success() -> None:
    assert summarize_checks([check("a", "success"), check("b", "pending"), check("c", "failure")]) == "failure"
    assert summarize_checks([check("a", "success"), check("b", "pending")]) == "pending"
    assert summarize_checks([check("a", "success"), check("b", "success")]) == "success"


def test_checks_skipped_and_neutral_are_not_failures_or_pending() -> None:
    assert summarize_checks([check("a", "skipped"), check("b", "neutral")]) == "success"
