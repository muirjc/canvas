"""Keeping Canvas's view of a submitted diagram's pull request current -- merged (approved), closed (rejected),
reviews, checks -- plus withdrawing, history and project badges. Port of
apps/api/tests/contract/github-sync.test.ts."""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from canvas_api.app import create_app
from canvas_api.github.client import GitHubClient
from canvas_api.github.sync import REFRESH_THROTTLE, sync_open_submissions
from canvas_api.timestamps import now_utc, to_db
from tests.api import Api
from tests.github_helpers import DSL_V2, GH, MISSING_PROJECT


def subset(actual: dict[str, Any], **expected: Any) -> None:
    """The expected fields, with those values (like vitest's toMatchObject)."""
    assert {k: actual[k] for k in expected} == expected


def age_sync(github: GH, diagram_id: str, delta: timedelta = REFRESH_THROTTLE + timedelta(seconds=5)) -> None:
    """Pretends the last sync was a while ago, so the throttle / the job's minimum age don't apply."""
    github.api.execute(
        "UPDATE diagram_submissions SET last_synced_at = :t WHERE diagram_id = :id",
        t=to_db(now_utc() - delta, github.api.dialect),
        id=diagram_id,
    )


def new_client(github: GH) -> GitHubClient:
    """A GitHub client with its own token cache and back-off state."""
    client = GitHubClient(github.fake.config(), github.fake.transport())
    return client


@pytest.fixture()
def client(github: GH) -> Any:
    c = new_client(github)
    yield c
    c.close()


@pytest.fixture()
def linked(github: GH) -> GH:
    """The suite's `beforeEach`: the Orders project linked to the repository."""
    github.link_project()
    return github


# --- refresh: merged, closed --------------------------------------------------------------------------


def test_merged_on_github_state_merged_approved_populated_head_matches(linked: GH) -> None:
    diagram_id, _branch, number = linked.submitted()
    linked.fake.merge_pull(linked.repo, number, by="rita")
    body = linked.current(diagram_id)
    subset(body["current"], state="merged", prNumber=number, mergedBy="rita", mergedHeadMatches=True)
    assert body["current"]["mergedAt"]
    subset(body["approved"], state="merged", submittedVersionSequence=1, mergedBy="rita", mergedHeadMatches=True)
    assert body["approved"]["mergedAt"]
    assert body["canWithdraw"] is False


def test_merged_after_an_extra_commit_was_pushed_on_github_merged_head_matches_is_false(linked: GH) -> None:
    fake, repo = linked.fake, linked.repo
    diagram_id, branch, number = linked.submitted()
    outside = fake.make_commit(
        repo, fake.head_of(repo, branch), {"architecture/order-flow/README.md": "edited by hand\n"}
    )
    fake.force_move_branch(repo, branch, outside)
    fake.merge_pull(repo, number)
    body = linked.current(diagram_id)
    subset(body["current"], state="merged", mergedHeadMatches=False)
    subset(body["approved"], mergedHeadMatches=False)


def test_closed_without_merging_state_closed_rejected_nothing_approved(linked: GH) -> None:
    diagram_id, _branch, number = linked.submitted()
    linked.fake.close_pull(linked.repo, number)
    body = linked.current(diagram_id)
    subset(body["current"], state="closed", mergedBy=None, mergedHeadMatches=None, withdrawnAt=None)
    assert body["current"]["closedAt"]
    assert body["approved"] is None
    assert body["canWithdraw"] is False
    assert len(linked.events("diagram_submission_closed")) == 1


def test_records_diagram_submission_merged_exactly_once_even_when_refreshed_twice(linked: GH) -> None:
    diagram_id, _branch, number = linked.submitted()
    linked.fake.merge_pull(linked.repo, number)
    linked.refresh(diagram_id)
    linked.refresh(diagram_id)
    merged = linked.events("diagram_submission_merged")
    assert len(merged) == 1
    assert "acme/architecture" in str(merged[0].detail)
    assert len(linked.events("diagram_submission_closed")) == 0


# --- refresh: reviews ---------------------------------------------------------------------------------


def _review_state(github: GH, setup: Any) -> dict[str, Any]:
    diagram_id, _branch, number = github.submitted()
    setup(number)
    current: dict[str, Any] = github.current(diagram_id)["current"]
    return current


def test_no_reviews_none(linked: GH) -> None:
    subset(_review_state(linked, lambda n: None), state="open", reviewState="none")


def test_approved_then_a_later_commented_from_the_same_reviewer_keeps_approved(linked: GH) -> None:
    def setup(n: int) -> None:
        linked.fake.add_review(linked.repo, n, "ann", "APPROVED")
        linked.fake.add_review(linked.repo, n, "ann", "COMMENTED")

    cur = _review_state(linked, setup)
    assert cur["reviewState"] == "approved"
    assert cur["statusDetail"]["reviews"] == [{"login": "ann", "state": "APPROVED"}]


def test_changes_requested_from_anyone_wins_over_another_reviewer_approving(linked: GH) -> None:
    def setup(n: int) -> None:
        linked.fake.add_review(linked.repo, n, "ann", "APPROVED")
        linked.fake.add_review(linked.repo, n, "bob", "CHANGES_REQUESTED")

    assert _review_state(linked, setup)["reviewState"] == "changes_requested"


def test_a_reviewer_who_changes_their_mind_their_latest_decision_counts(linked: GH) -> None:
    def setup(n: int) -> None:
        linked.fake.add_review(linked.repo, n, "bob", "CHANGES_REQUESTED")
        linked.fake.add_review(linked.repo, n, "bob", "APPROVED")

    assert _review_state(linked, setup)["reviewState"] == "approved"


def test_dismissed_removes_the_decision(linked: GH) -> None:
    def setup(n: int) -> None:
        linked.fake.add_review(linked.repo, n, "bob", "CHANGES_REQUESTED")
        linked.fake.add_review(linked.repo, n, "bob", "DISMISSED")

    cur = _review_state(linked, setup)
    assert cur["reviewState"] == "none"
    assert cur["statusDetail"]["reviews"] == []


def test_outstanding_review_requests_people_and_teams_make_it_pending_listed_in_status_detail(linked: GH) -> None:
    def setup(n: int) -> None:
        linked.fake.add_review(linked.repo, n, "ann", "APPROVED")
        linked.fake.request_reviewer(linked.repo, n, "carl")
        linked.fake.request_team(linked.repo, n, "architects")

    cur = _review_state(linked, setup)
    assert cur["reviewState"] == "pending"
    assert cur["statusDetail"]["requestedReviewers"] == ["carl", "team:architects"]
    assert cur["statusDetail"]["reviews"] == [{"login": "ann", "state": "APPROVED"}]


def test_requested_changes_still_win_over_an_outstanding_request(linked: GH) -> None:
    def setup(n: int) -> None:
        linked.fake.add_review(linked.repo, n, "bob", "CHANGES_REQUESTED")
        linked.fake.request_reviewer(linked.repo, n, "carl")

    assert _review_state(linked, setup)["reviewState"] == "changes_requested"


def test_reads_past_the_first_page_of_100_reviews(linked: GH) -> None:
    def setup(n: int) -> None:
        for i in range(100):
            linked.fake.add_review(linked.repo, n, f"noise{i}", "COMMENTED")
        linked.fake.add_review(linked.repo, n, "late", "CHANGES_REQUESTED")

    assert _review_state(linked, setup)["reviewState"] == "changes_requested"


# --- refresh: checks ----------------------------------------------------------------------------------


def _checks_for(github: GH, setup: Any, grant: bool = True) -> dict[str, Any]:
    if grant:
        github.fake.grant_checks(github.installation_id)
    diagram_id, branch, _number = github.submitted()
    setup(github.fake.head_of(github.repo, branch))
    current: dict[str, Any] = github.current(diagram_id)["current"]
    return current


def test_a_failing_check_run_failure_with_names_and_urls_in_status_detail(linked: GH) -> None:
    cur = _checks_for(
        linked,
        lambda sha: linked.fake.set_check_runs(
            linked.repo,
            sha,
            [
                {"name": "lint", "status": "completed", "conclusion": "success"},
                {"name": "build", "status": "completed", "conclusion": "failure"},
            ],
        ),
    )
    assert cur["checksState"] == "failure"
    assert cur["statusDetail"]["checks"] == [
        {"name": "lint", "state": "success", "url": "https://github.test/run/lint"},
        {"name": "build", "state": "failure", "url": "https://github.test/run/build"},
    ]


def test_a_check_still_running_pending(linked: GH) -> None:
    cur = _checks_for(
        linked,
        lambda sha: linked.fake.set_check_runs(
            linked.repo, sha, [{"name": "lint", "status": "in_progress", "conclusion": None}]
        ),
    )
    assert cur["checksState"] == "pending"


def test_all_passing_a_skipped_run_does_not_fail_it_a_commit_status_counts_too_success(linked: GH) -> None:
    def setup(sha: str) -> None:
        linked.fake.set_check_runs(
            linked.repo,
            sha,
            [
                {"name": "lint", "status": "completed", "conclusion": "success"},
                {"name": "optional", "status": "completed", "conclusion": "skipped"},
            ],
        )
        linked.fake.set_statuses(linked.repo, sha, [{"context": "legacy-ci", "state": "success"}])

    cur = _checks_for(linked, setup)
    assert cur["checksState"] == "success"
    assert [c["name"] for c in cur["statusDetail"]["checks"]] == ["lint", "optional", "legacy-ci"]


def test_a_legacy_commit_status_in_error_failure(linked: GH) -> None:
    cur = _checks_for(
        linked, lambda sha: linked.fake.set_statuses(linked.repo, sha, [{"context": "legacy-ci", "state": "error"}])
    )
    assert cur["checksState"] == "failure"


def test_no_checks_at_all_none(linked: GH) -> None:
    assert _checks_for(linked, lambda sha: None)["checksState"] == "none"


def test_checks_permission_not_granted_403_unavailable_but_reviews_and_the_rest_still_sync(linked: GH) -> None:
    diagram_id, _branch, number = linked.submitted()
    linked.fake.add_review(linked.repo, number, "ann", "APPROVED")
    cur = linked.current(diagram_id)["current"]
    subset(cur, state="open", checksState="unavailable", reviewState="approved", lastSyncError=None)
    assert cur["statusDetail"]["checks"] == []
    assert cur["lastSyncedAt"]


def test_a_check_run_for_an_older_commit_is_not_counted_the_head_commit_is_what_is_asked_about(linked: GH) -> None:
    fake, repo = linked.fake, linked.repo
    fake.grant_checks(linked.installation_id)
    diagram_id, branch, _number = linked.submitted()
    old_sha = fake.head_of(repo, branch)
    fake.set_check_runs(repo, old_sha, [{"name": "build", "status": "completed", "conclusion": "failure"}])
    linked.save(diagram_id, DSL_V2)
    assert linked.submit(diagram_id).status_code == 200
    assert fake.head_of(repo, branch) != old_sha
    age_sync(linked, diagram_id)
    assert linked.current(diagram_id)["current"]["checksState"] == "none"


# --- refresh: throttle, errors, access ----------------------------------------------------------------


def test_a_second_refresh_within_30s_makes_no_github_calls_after_the_window_it_asks_again(linked: GH) -> None:
    diagram_id, _branch, _number = linked.submitted()
    linked.refresh(diagram_id)
    linked.fake.clear_records()
    again = linked.refresh(diagram_id)
    assert again.status_code == 200
    assert linked.fake.requests == []

    age_sync(linked, diagram_id)
    linked.refresh(diagram_id)
    assert len(linked.fake.calls_to("GET", r"/pulls/1$")) == 1


def test_a_refresh_with_nothing_submitted_makes_no_calls_and_answers_the_status(linked: GH) -> None:
    diagram_id = linked.create_diagram()
    linked.fake.clear_records()
    res = linked.refresh(diagram_id)
    assert res.status_code == 200
    assert res.json()["current"] is None
    assert linked.fake.requests == []


def test_access_lost_last_sync_error_is_set_and_the_link_says_needs_attention(linked: GH) -> None:
    diagram_id, _branch, _number = linked.submitted()
    linked.fake.remove_repo_from_installation(linked.repo)
    res = linked.refresh(diagram_id)
    assert res.status_code == 200
    assert res.json()["current"]["lastSyncError"]
    assert res.json()["current"]["state"] == "open"
    links = linked.call("GET", "/admin/github/links", "admin").json()["links"]
    assert links[0]["lastCheckError"].startswith("Needs attention: ")

    # It recovers once access is back.
    linked.fake.add_repo_to_installation(linked.repo)
    age_sync(linked, diagram_id)
    assert linked.current(diagram_id)["current"]["lastSyncError"] is None


def test_a_github_outage_is_recorded_on_the_submission_not_thrown_and_the_link_is_not_flagged(linked: GH) -> None:
    diagram_id, _branch, _number = linked.submitted()
    linked.fake.fail_with = (500, {})
    res = linked.refresh(diagram_id)
    assert res.status_code == 200
    assert res.json()["current"]["lastSyncError"]
    linked.fake.fail_with = None
    links = linked.call("GET", "/admin/github/links", "admin").json()["links"]
    assert "Needs attention" not in (links[0]["lastCheckError"] or "")


def test_anyone_signed_in_can_refresh_but_only_an_editor_can_withdraw(linked: GH) -> None:
    """canvas-2h2w.1: everyone signed in can read, so anyone can refresh; withdrawing needs edit."""
    diagram_id, _branch, number = linked.submitted()
    shared = linked.call(
        "POST",
        f"/diagrams/{diagram_id}/shares",
        "owner",
        json={"granteeUserId": linked.users["viewer"].id, "accessLevel": "view"},
    )
    assert shared.status_code == 201
    assert linked.refresh(diagram_id, "viewer").status_code == 200
    view = linked.call("GET", f"/diagrams/{diagram_id}/submission", "viewer")
    assert view.json()["canWithdraw"] is False
    assert linked.withdraw(diagram_id, "viewer").status_code == 403
    assert linked.fake.pull(linked.repo, number).state == "open"
    assert linked.refresh(diagram_id, "stranger").status_code == 200
    assert linked.withdraw(diagram_id, "stranger").status_code == 403
    assert linked.call("POST", f"/diagrams/{diagram_id}/submission/refresh", None).status_code == 401


# --- sync_open_submissions (the scheduled job) --------------------------------------------------------

NO_COUNTS = {"open": 0, "merged": 0, "closed": 0, "error": 0, "skipped": 0, "rateLimited": 0}


def test_syncs_every_open_submission_returning_counts_and_skips_recently_synced_ones(
    linked: GH, client: GitHubClient
) -> None:
    a = linked.submitted("Alpha")
    b = linked.submitted("Beta")
    c = linked.submitted("Gamma")
    linked.fake.merge_pull(linked.repo, a[2])
    linked.fake.close_pull(linked.repo, b[2])
    linked.fake.add_review(linked.repo, c[2], "ann", "APPROVED")

    counts = sync_open_submissions(client, linked.engine)
    assert counts == {**NO_COUNTS, "open": 1, "merged": 1, "closed": 1}
    assert linked.submission_rows(a[0])[0].state == "merged"
    assert linked.submission_rows(b[0])[0].state == "closed"
    row_c = linked.submission_rows(c[0])[0]
    assert (row_c.state, row_c.review_state) == ("open", "approved")

    # Only the still-open one is a candidate, and it was just synced.
    linked.fake.clear_records()
    assert sync_open_submissions(client, linked.engine) == NO_COUNTS
    assert linked.fake.requests == []

    # A zero minimum age syncs it regardless.
    assert sync_open_submissions(client, linked.engine, timedelta(0))["open"] == 1


def test_one_failing_submission_does_not_stop_the_others(linked: GH, client: GitHubClient) -> None:
    other_project = linked.api.project(linked.users["owner"], "Other")
    linked.link_project("other", linked.other_repo, other_project)
    bad = linked.create_diagram("Bad", project_id=other_project)
    assert linked.submit(bad).status_code == 201
    good = linked.submitted("Good")
    linked.fake.add_review(linked.repo, good[2], "ann", "APPROVED")
    linked.fake.remove_repo_from_installation(linked.other_repo)

    counts = sync_open_submissions(client, linked.engine)
    subset(counts, open=1, error=1)
    assert linked.submission_rows(bad)[0].last_sync_error
    assert linked.submission_rows(good[0])[0].review_state == "approved"


def test_a_rate_limit_stops_the_batch_and_later_calls_skip_github(linked: GH) -> None:
    """canvas-3s5.4: the rest wait for the next run."""
    subs = [linked.submitted(name) for name in ("Alpha", "Beta", "Gamma")]
    limited = new_client(linked)
    try:
        linked.fake.fail_with = (429, {"retry-after": "600"})
        linked.fake.clear_records()

        counts = sync_open_submissions(limited, linked.engine, timedelta(0))
        assert counts == {**NO_COUNTS, "skipped": 2, "rateLimited": 1}
        # One attempt reached GitHub; the batch stopped there.
        assert len(linked.fake.requests) <= 1
        errors = [e for s in subs if (e := linked.submission_rows(s[0])[0].last_sync_error)]
        assert len(errors) == 1
        assert "rate limit" in errors[0].lower()

        # Still inside the back-off: nothing is sent at all, and the link isn't flagged as broken.
        linked.fake.fail_with = None
        linked.fake.clear_records()
        assert sync_open_submissions(limited, linked.engine, timedelta(0))["rateLimited"] == 1
        assert linked.fake.requests == []
        link = linked.rows("SELECT last_check_error FROM github_links WHERE repo_id = :id", id=linked.repo.id)[0]
        assert "Needs attention" not in (link.last_check_error or "")
    finally:
        limited.close()


def test_a_diagram_that_was_never_submitted_is_not_a_candidate(linked: GH, client: GitHubClient) -> None:
    linked.create_diagram("Never submitted")
    linked.fake.clear_records()
    assert sync_open_submissions(client, linked.engine) == NO_COUNTS
    assert linked.fake.requests == []


# --- withdraw -----------------------------------------------------------------------------------------


def test_withdraw_comments_who_withdrew_closes_the_pr_records_who_and_when_and_audits_it(linked: GH) -> None:
    diagram_id, _branch, number = linked.submitted()
    res = linked.withdraw(diagram_id)
    assert res.status_code == 200, res.text
    pull = linked.fake.pull(linked.repo, number)
    assert (pull.state, pull.merged) == ("closed", False)
    assert pull.comments == ["Withdrawn in Canvas by Olivia <Owner>."]
    body = res.json()
    subset(body["current"], state="closed", withdrawnBy="Olivia <Owner>")
    assert body["current"]["withdrawnAt"]
    assert body["canWithdraw"] is False
    assert body["approved"] is None
    audit = linked.events("diagram_submission_withdrawn")
    assert len(audit) == 1
    assert str(audit[0].actor_user_id) == linked.users["owner"].id
    assert len(linked.events("diagram_submission_closed")) == 0


def test_the_withdraw_comment_cannot_at_mention_people_or_span_lines_via_the_user_name(linked: GH) -> None:
    """The TypeScript test renames the owner in the users table; a session keeps the name it was made with, so
    here the withdrawing user is created with the hostile name."""
    diagram_id, _branch, number = linked.submitted()
    eve = linked.api.user("eve@example.com", "architect", "Eve @octocat\nsecond line")
    linked.users["eve"] = eve
    shared = linked.call(
        "POST",
        f"/diagrams/{diagram_id}/shares",
        "owner",
        json={"granteeUserId": eve.id, "accessLevel": "edit"},
    )
    assert shared.status_code == 201
    assert linked.withdraw(diagram_id, "eve").status_code == 200
    (comment,) = linked.fake.pull(linked.repo, number).comments
    assert comment.startswith("Withdrawn in Canvas by Eve")
    assert "@octocat" not in comment
    assert "\n" not in comment


def test_an_edit_shared_user_may_withdraw(linked: GH) -> None:
    diagram_id, _branch, _number = linked.submitted()
    linked.call(
        "POST",
        f"/diagrams/{diagram_id}/shares",
        "owner",
        json={"granteeUserId": linked.users["editor"].id, "accessLevel": "edit"},
    )
    res = linked.withdraw(diagram_id, "editor")
    assert res.status_code == 200, res.text
    assert res.json()["current"]["withdrawnBy"] == "Edie Editor"


def test_withdraw_with_nothing_open_409_not_open_and_nothing_is_sent_to_github(linked: GH) -> None:
    diagram_id = linked.create_diagram()
    linked.fake.clear_records()
    res = linked.withdraw(diagram_id)
    assert res.status_code == 409
    assert res.json()["code"] == "not_open"
    assert linked.fake.requests == []


def test_withdrawing_twice_the_second_is_409_not_open_and_adds_no_second_comment(linked: GH) -> None:
    diagram_id, _branch, number = linked.submitted()
    assert linked.withdraw(diagram_id).status_code == 200
    assert linked.withdraw(diagram_id).status_code == 409
    assert len(linked.fake.pull(linked.repo, number).comments) == 1


def test_withdraw_already_merged_on_github_409_not_open_nothing_closed_or_commented_and_the_merge_is_recorded(
    linked: GH,
) -> None:
    diagram_id, _branch, number = linked.submitted()
    linked.fake.merge_pull(linked.repo, number, by="rita")
    res = linked.withdraw(diagram_id)
    assert res.status_code == 409
    assert res.json()["code"] == "not_open"
    assert "merged" in res.json()["error"]
    assert linked.fake.pull(linked.repo, number).comments == []
    row = linked.submission_rows(diagram_id)[0]
    assert (row.state, row.merged_by_login, row.withdrawn_at) == ("merged", "rita", None)
    assert len(linked.events("diagram_submission_merged")) == 1
    assert len(linked.events("diagram_submission_withdrawn")) == 0


def test_withdraw_already_closed_on_github_409_not_open_and_it_is_recorded_as_closed_not_withdrawn(linked: GH) -> None:
    diagram_id, _branch, number = linked.submitted()
    linked.fake.close_pull(linked.repo, number)
    res = linked.withdraw(diagram_id)
    assert res.status_code == 409
    assert "closed" in res.json()["error"]
    row = linked.submission_rows(diagram_id)[0]
    assert (row.state, row.withdrawn_at) == ("closed", None)
    assert len(linked.events("diagram_submission_withdrawn")) == 0


def test_after_withdrawing_a_new_submit_opens_a_new_pull_request(linked: GH) -> None:
    diagram_id, _branch, _number = linked.submitted()
    linked.withdraw(diagram_id)
    linked.save(diagram_id, DSL_V2)
    res = linked.submit(diagram_id)
    assert res.status_code == 201, res.text
    subset(res.json()["submission"], state="open", prNumber=2, withdrawnAt=None)
    assert [(r.pr_number, r.state) for r in linked.submission_rows(diagram_id)] == [(1, "closed"), (2, "open")]


def test_withdraw_with_github_switched_off_the_route_answers_409_github_disabled(linked: GH, settings: Any) -> None:
    with TestClient(create_app(settings, linked.engine)) as off:
        diagram_id = linked.create_diagram()
        res = Api(off, linked.engine).call("POST", f"/diagrams/{diagram_id}/submission/withdraw", linked.users["owner"])
    assert res.status_code == 409
    assert res.json()["code"] == "github_disabled"


# --- history ------------------------------------------------------------------------------------------


def test_lists_pull_requests_newest_first_each_with_its_pushes_newest_first(linked: GH) -> None:
    diagram_id, _branch, _number = linked.submitted()
    linked.save(diagram_id, DSL_V2)
    assert linked.submit(diagram_id).status_code == 200  # push 2 to PR 1
    linked.fake.merge_pull(linked.repo, 1)
    linked.refresh(diagram_id)
    linked.save(diagram_id, f"{DSL_V2}  C --> D[Archive]:::step\n")
    third = linked.submit(diagram_id)
    assert third.status_code == 201, third.text  # PR 2

    # not shared, but readable by everyone (canvas-2h2w.1)
    assert linked.call("GET", f"/diagrams/{diagram_id}/submissions", "viewer").status_code == 200
    history = linked.call("GET", f"/diagrams/{diagram_id}/submissions", "owner").json()["submissions"]
    assert [(s["prNumber"], s["state"]) for s in history] == [(2, "open"), (1, "merged")]
    assert len(history[1]["pushes"]) == 2
    sequences = [p["versionSequence"] for p in history[1]["pushes"]]
    assert sequences == sorted(sequences, reverse=True)
    subset(history[1]["pushes"][0], pushedBy="Olivia <Owner>", warningCount=0)
    assert re.fullmatch(r"[0-9a-f]{40}", history[1]["pushes"][0]["commitSha"])
    assert history[1]["pushes"][0]["versionSequence"] > history[1]["pushes"][1]["versionSequence"]
    assert len(history[0]["pushes"]) == 1
    assert history[0]["pushes"][0]["versionSequence"] > history[1]["pushes"][0]["versionSequence"]


def test_a_diagram_never_submitted_has_an_empty_history_a_view_shared_user_can_read_it(linked: GH) -> None:
    diagram_id = linked.create_diagram()
    linked.call(
        "POST",
        f"/diagrams/{diagram_id}/shares",
        "owner",
        json={"granteeUserId": linked.users["viewer"].id, "accessLevel": "view"},
    )
    res = linked.call("GET", f"/diagrams/{diagram_id}/submissions", "viewer")
    assert res.status_code == 200
    assert res.json()["submissions"] == []


# --- project badges -----------------------------------------------------------------------------------


def _badges(github: GH, project: str | None = None, who: str | None = "owner") -> Any:
    return github.call("GET", f"/projects/{project or github.project_id}/submission-statuses", who)


def test_badges_are_the_latest_submission_per_diagram_an_open_one_wins_changes_flip_after_a_save(linked: GH) -> None:
    a = linked.submitted("Alpha")
    b = linked.submitted("Beta")
    never = linked.create_diagram("Never")
    linked.fake.merge_pull(linked.repo, b[2])
    linked.refresh(b[0])

    statuses = _badges(linked).json()["statuses"]
    assert sorted(statuses) == sorted([a[0], b[0]])
    assert never not in statuses
    subset(
        statuses[a[0]],
        state="open",
        prNumber=a[2],
        changesSinceSubmitting=False,
        withdrawn=False,
        submittedVersionSequence=1,
    )
    subset(statuses[b[0]], state="merged", changesSinceSubmitting=False)

    linked.save(a[0], DSL_V2)
    assert _badges(linked).json()["statuses"][a[0]]["changesSinceSubmitting"] is True

    # Merged PR, then a new open one for Beta: the open one is shown.
    linked.save(b[0], DSL_V2)
    assert linked.submit(b[0]).status_code == 201
    subset(_badges(linked).json()["statuses"][b[0]], state="open", prNumber=3)


def test_badges_without_an_open_one_the_most_recent_wins_and_a_withdrawn_pr_is_flagged(linked: GH) -> None:
    a = linked.submitted("Alpha")
    linked.fake.close_pull(linked.repo, a[2])
    linked.refresh(a[0])
    linked.save(a[0], DSL_V2)
    assert linked.submit(a[0]).status_code == 201
    assert linked.withdraw(a[0]).status_code == 200
    subset(_badges(linked).json()["statuses"][a[0]], state="closed", prNumber=2, withdrawn=True)


def test_badges_exclude_deleted_diagrams_and_other_projects_diagrams(linked: GH) -> None:
    kept = linked.submitted("Kept")
    deleted = linked.submitted("Deleted")
    other_project = linked.api.project(linked.users["owner"], "Other")
    linked.link_project("other", linked.other_repo, other_project)
    elsewhere = linked.create_diagram("Elsewhere", project_id=other_project)
    assert linked.submit(elsewhere).status_code == 201
    assert linked.call("DELETE", f"/diagrams/{deleted[0]}").status_code == 204

    assert list(_badges(linked).json()["statuses"]) == [kept[0]]
    assert list(_badges(linked, other_project).json()["statuses"]) == [elsewhere]


def test_badges_readable_by_anyone_signed_in_404_for_a_missing_project_401_without_a_cookie(linked: GH) -> None:
    linked.submitted()
    assert _badges(linked, who="stranger").status_code == 200
    assert _badges(linked, MISSING_PROJECT, "admin").status_code == 404
    assert _badges(linked, who=None).status_code == 401


# --- admin links list ---------------------------------------------------------------------------------


def _open_counts(github: GH) -> list[dict[str, Any]]:
    links: list[dict[str, Any]] = github.call("GET", "/admin/github/links", "admin").json()["links"]
    return links


def test_the_links_list_shows_how_many_pull_requests_are_still_open_for_each_link(
    linked: GH, client: GitHubClient
) -> None:
    assert _open_counts(linked)[0]["openSubmissionCount"] == 0
    a = linked.submitted("Alpha")
    linked.submitted("Beta")
    assert _open_counts(linked)[0]["openSubmissionCount"] == 2
    linked.fake.merge_pull(linked.repo, a[2])
    linked.refresh(a[0])
    assert _open_counts(linked)[0]["openSubmissionCount"] == 1

    # Removing the link leaves the pull requests open, and the job keeps syncing them.
    assert linked.call("DELETE", f"/projects/{linked.project_id}/github-link", "admin").status_code == 204
    assert _open_counts(linked) == []
    assert sync_open_submissions(client, linked.engine, timedelta(0))["open"] == 1


def test_two_links_count_only_their_own_pull_requests(linked: GH) -> None:
    other_project = linked.api.project(linked.users["owner"], "Other")
    linked.link_project("other", linked.other_repo, other_project)
    linked.submitted("Alpha")
    elsewhere = linked.create_diagram("Elsewhere", project_id=other_project)
    linked.submit(elsewhere)
    linked.withdraw(elsewhere)
    counts = {link["projectId"]: link["openSubmissionCount"] for link in _open_counts(linked)}
    assert counts == {linked.project_id: 1, other_project: 0}


# --- the scheduled job's command: python -m canvas_api.github.sync_run --------------------------------


def _job(linked: GH, monkeypatch: pytest.MonkeyPatch, settings: Any) -> Any:
    """sync_run.main() with its settings, database and GitHub transport pointed at the test world."""
    from canvas_api.github import sync_run

    github_settings = linked.app.state.settings
    monkeypatch.setattr(sync_run, "Settings", lambda: settings if settings is not None else github_settings)
    monkeypatch.setattr(sync_run, "create_db_engine", lambda _settings: linked.engine)
    monkeypatch.setattr(sync_run, "GitHubClient", lambda config: GitHubClient(config, linked.fake.transport()))
    return sync_run.main


def test_the_job_syncs_open_pull_requests_prints_counts_only_and_exits_0(
    linked: GH, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    diagram_id, _branch, number = linked.submitted()
    linked.fake.merge_pull(linked.repo, number)
    code = _job(linked, monkeypatch, None)()
    assert code == 0
    assert (
        "Synced pull requests: 0 still open, 1 merged (approved), 0 closed (rejected), 0 failed."
        in capsys.readouterr().out
    )
    assert linked.submission_rows(diagram_id)[0].state == "merged"


def test_the_job_exits_1_when_a_submission_could_not_be_synced(
    linked: GH, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    linked.submitted()
    linked.fake.remove_repo_from_installation(linked.repo)
    code = _job(linked, monkeypatch, None)()
    assert code == 1
    assert "1 failed" in capsys.readouterr().out


def test_the_job_reports_the_rate_limit_and_how_many_are_left_for_the_next_run(
    linked: GH, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name in ("Alpha", "Beta"):
        linked.submitted(name)
    linked.fake.fail_with = (429, {"retry-after": "600"})
    code = _job(linked, monkeypatch, None)()
    assert code == 0
    assert "GitHub rate limit reached, 1 left for the next run." in capsys.readouterr().out


def test_the_job_does_nothing_when_github_is_not_configured(
    linked: GH, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], settings: Any
) -> None:
    linked.submitted()
    linked.fake.clear_records()
    assert _job(linked, monkeypatch, settings)() == 0
    assert "GitHub is not configured" in capsys.readouterr().out
    assert linked.fake.requests == []
