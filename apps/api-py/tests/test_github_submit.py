"""Submitting a diagram to GitHub as a pull request, against the in-memory fake GitHub. One open PR per
diagram; submitting again pushes a new commit to the same PR; merged/closed PRs are noticed on the next
submit. Port of apps/api/tests/contract/github-submit.test.ts."""

from __future__ import annotations

import json
import re
from datetime import timedelta

from canvas_api.timestamps import now_utc, to_db
from tests.fake_github import FakeRepo
from tests.github_helpers import (
    DSL_V2,
    GH,
    ONE_STEP_DSL,
    STANDARD,
    id8,
)


def _share_all(github: GH, diagram_id: str) -> None:
    for who, level in [("viewer", "view"), ("commenter", "comment"), ("editor", "edit")]:
        res = github.call(
            "POST",
            f"/diagrams/{diagram_id}/shares",
            "owner",
            json={"granteeUserId": github.users[who].id, "accessLevel": level},
        )
        assert res.status_code == 201, res.text


def _set_submitting_since(github: GH, diagram_id: str, when: object) -> None:
    github.api.execute(
        "UPDATE diagram_submissions SET submitting_since = :t WHERE diagram_id = :id",
        t=to_db(when, github.api.dialect),  # type: ignore[arg-type]
        id=diagram_id,
    )


# --- who can submit and when --------------------------------------------------------------------------


def test_an_unlinked_project_answers_409_not_linked_and_touches_nothing_on_github(github: GH) -> None:
    diagram_id = github.create_diagram()
    res = github.submit(diagram_id)
    assert res.status_code == 409
    assert res.json()["code"] == "not_linked"
    assert github.fake.requests == []
    can_submit = github.status(diagram_id)["canSubmit"]
    assert can_submit["allowed"] is False
    assert can_submit["reason"] == "not_linked"


def test_view_only_and_comment_only_users_get_403_an_edit_shared_user_may_submit_no_cookie_is_401(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    _share_all(github, diagram_id)
    assert github.submit(diagram_id, "viewer").status_code == 403
    assert github.submit(diagram_id, "commenter").status_code == 403
    assert github.submit(diagram_id, None).status_code == 401
    assert len(github.repo.pulls) == 0

    viewer = github.status(diagram_id, "viewer")["canSubmit"]
    assert viewer["allowed"] is False
    assert viewer["reason"] == "no_edit_access"
    editor = github.status(diagram_id, "editor")["canSubmit"]
    assert editor["allowed"] is True
    assert editor["reason"] is None

    res = github.submit(diagram_id, "editor")
    assert res.status_code == 201, res.text
    # The co-author is the person who clicked Submit.
    message = github.fake.commits_on(github.repo, res.json()["submission"]["branch"])[0].message
    assert "Co-authored-by: Edie Editor <editor@example.com>" in message


def test_a_must_fix_issue_from_the_active_standard_answers_422_with_the_violations_and_creates_nothing(
    github: GH,
) -> None:
    github.link_project()
    github.publish_standard()
    diagram_id = github.create_diagram("Too small", ONE_STEP_DSL)

    check = github.status(diagram_id)["canSubmit"]
    assert check["allowed"] is False
    assert check["reason"] == "must_fix"
    assert check["mustFixCount"] > 0

    res = github.submit(diagram_id)
    assert res.status_code == 422, res.text
    assert res.json()["code"] == "must_fix"
    violations = res.json()["violations"]
    assert len(violations) > 0
    assert violations[0]["severity"] == "error"
    assert violations[0]["rule"] == "kind-min-count"
    assert "Step" in violations[0]["message"]
    assert list(github.repo.branches) == ["main"]
    assert len(github.repo.pulls) == 0
    assert github.submission_rows(diagram_id) == []


def test_warnings_do_not_block_and_are_listed_in_the_pull_request_description(github: GH) -> None:
    github.link_project()
    github.publish_standard({**STANDARD, "severityOverrides": {"kind-min-count": "warning"}})
    diagram_id = github.create_diagram("Warned", ONE_STEP_DSL)
    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    assert len(res.json()["warnings"]) > 0
    assert "Standard findings" in github.fake.pull(github.repo, 1).body
    can_submit = github.status(diagram_id)["canSubmit"]
    assert can_submit["allowed"] is True
    assert can_submit["warningCount"] == len(res.json()["warnings"])
    assert can_submit["mustFixCount"] == 0


# --- first submission ---------------------------------------------------------------------------------


def test_first_submission_creates_the_branch_one_commit_the_files_and_the_pull_request(github: GH) -> None:
    fake, repo = github.fake, github.repo
    github.link_project()
    github.publish_standard()
    diagram_id = github.create_diagram()
    dsl = github.saved(diagram_id)
    assert "canvas:" in dsl

    main_before = fake.head_of(repo, "main")
    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    outcome, submission = res.json()["outcome"], res.json()["submission"]
    branch = f"canvas/{id8(diagram_id)}-order-flow-r1"
    assert outcome == "created"
    assert submission["state"] == "open"
    assert submission["prNumber"] == 1
    assert submission["branch"] == branch
    assert submission["path"] == "architecture/order-flow"
    assert submission["baseBranch"] == "main"
    assert submission["repoFullName"] == "acme/architecture"
    assert submission["submittedBy"] == "Olivia <Owner>"
    assert isinstance(submission["submittedVersionSequence"], int)
    assert submission["prUrl"] == "https://github.test/acme/architecture/pull/1"

    # One commit on top of the base branch, crediting the Canvas user; the base branch itself is untouched.
    assert fake.head_of(repo, "main") == main_before
    commits = fake.commits_on(repo, branch)
    assert len(commits) == 2
    assert commits[1].sha == main_before
    assert 'Submit "Order Flow"' in commits[0].message
    assert "Co-authored-by: Olivia Owner <owner@example.com>" in commits[0].message

    pull = fake.pull(repo, 1)
    assert (pull.head, pull.base, pull.state) == (branch, "main", "open")
    assert "Order Flow" in pull.title
    assert "http://canvas.test/?diagramId=" in pull.body
    assert f"canvas:diagram={diagram_id}" in pull.body

    files = fake.files(repo, branch)
    assert files is not None
    assert sorted(files) == [
        ".canvas/standards/flowchart/v1.json",
        "README.md",
        "architecture/order-flow/README.md",
        "architecture/order-flow/canvas.json",
        "architecture/order-flow/order-flow.canvas.mmd",
        "architecture/order-flow/order-flow.mmd",
        "architecture/order-flow/order-flow.svg",
    ]
    assert files["architecture/order-flow/order-flow.canvas.mmd"] == dsl
    portable = files["architecture/order-flow/order-flow.mmd"]
    assert "canvas:" not in portable
    assert "flowchart TD" in portable
    assert "Receive order" in portable
    svg = files["architecture/order-flow/order-flow.svg"]
    assert re.match(r"^<svg[\s\S]*Receive order", svg)
    # canvas-n85n: white behind the drawing, for GitHub's dark mode.
    assert re.match(r'^<svg [^>]*><rect width="100%" height="100%" fill="#ffffff" />', svg)
    readme = files["architecture/order-flow/README.md"]
    assert "(./order-flow.svg)" in readme
    assert "```mermaid" in readme
    manifest = json.loads(files["architecture/order-flow/canvas.json"])
    expected = {
        "schema": 1,
        "diagramId": diagram_id,
        "name": "Order Flow",
        "diagramType": "flowchart",
        "dslFamily": "flowchart",
        "source": "order-flow.canvas.mmd",
        "portable": "order-flow.mmd",
        "svg": "order-flow.svg",
        "canvasUrl": f"http://canvas.test/?diagramId={diagram_id}",
    }
    assert {k: manifest[k] for k in expected} == expected
    standard_ref = manifest["standard"]
    assert standard_ref["path"] == ".canvas/standards/flowchart/v1.json"
    assert standard_ref["version"] == 1
    assert standard_ref["name"] == "Order process rules"
    assert re.fullmatch(r"[0-9a-f]{64}", manifest["sourceSha256"])
    standard = json.loads(files[".canvas/standards/flowchart/v1.json"])
    assert (standard["diagramTypeId"], standard["version"], standard["name"]) == (
        "flowchart",
        1,
        "Order process rules",
    )
    assert standard["rules"]["elementKinds"][0]["id"] == "step"

    # The installation token was narrowed to the one repository and the permissions a submission uses.
    token_request = fake.token_requests[-1]
    assert token_request.body["repository_ids"] == [repo.id]
    assert token_request.body["permissions"] == {"contents": "write", "pull_requests": "write", "metadata": "read"}

    # Recorded: the push, the audit event.
    rows = github.submission_rows(diagram_id)
    assert len(rows) == 1
    assert rows[0].state == "open"
    assert rows[0].pr_number == 1
    assert rows[0].last_pushed_commit_sha == commits[0].sha
    assert rows[0].head_sha == commits[0].sha
    assert rows[0].submitting_since is None
    pushes = github.rows("SELECT * FROM diagram_submission_pushes")
    assert len(pushes) == 1
    assert str(pushes[0].submission_id) == str(rows[0].id)
    assert pushes[0].commit_sha == commits[0].sha
    assert str(pushes[0].pushed_by_user_id) == github.users["owner"].id
    audit = github.events("diagram_submitted")
    assert len(audit) == 1
    assert str(audit[0].actor_user_id) == github.users["owner"].id
    assert "acme/architecture" in str(audit[0].detail)


def test_omits_the_standard_file_when_the_diagram_type_has_no_active_standard(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    files = github.fake.files(github.repo, res.json()["submission"]["branch"])
    assert files is not None
    assert not any(f.startswith(".canvas/") for f in files)
    assert json.loads(files["architecture/order-flow/canvas.json"])["standard"] is None


def test_escapes_markdown_in_the_diagram_name_so_it_cannot_mention_or_format(github: GH) -> None:
    """README and pull request."""
    github.link_project()
    diagram_id = github.create_diagram("@everyone **x**")
    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    branch, path = res.json()["submission"]["branch"], res.json()["submission"]["path"]
    assert path == "architecture/everyone-x"
    files = github.fake.files(github.repo, branch)
    assert files is not None
    readme = files[f"{path}/README.md"]
    body = github.fake.pull(github.repo, 1).body
    for text in (readme, body):
        assert "@everyone" not in text
        assert "**x**" not in text
    assert "\\*\\*x\\*\\*" in readme
    assert "\\*\\*x\\*\\*" in body
    # The title is plain text (GitHub does not render or notify from titles), but never carries a line break.
    assert "\n" not in github.fake.pull(github.repo, 1).title


def test_a_second_diagram_with_the_same_name_gets_an_id8_suffix_and_its_own_folder(github: GH) -> None:
    github.link_project()
    first = github.create_diagram("Order Flow")
    second = github.create_diagram("Order Flow")
    assert github.submit(first).json()["submission"]["path"] == "architecture/order-flow"
    res = github.submit(second)
    assert res.status_code == 201, res.text
    assert res.json()["submission"]["path"] == f"architecture/order-flow-{id8(second)}"
    assert re.fullmatch(f"canvas/{id8(second)}-order-flow-{id8(second)}-r1", res.json()["submission"]["branch"])
    # Both diagrams' files coexist; neither overwrote the other.
    files = github.fake.files(github.repo, res.json()["submission"]["branch"])
    assert files is not None
    assert "architecture/order-flow/canvas.json" not in files  # the first lives on its own branch, not this one
    assert f"architecture/order-flow-{id8(second)}/canvas.json" in files


def test_uses_a_different_branch_name_when_a_stale_branch_of_the_planned_name_already_exists(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    planned = f"canvas/{id8(diagram_id)}-order-flow-r1"
    github.repo.branches[planned] = github.fake.head_of(github.repo, "main")
    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    assert re.fullmatch(f"{re.escape(planned)}-[0-9a-f]{{4}}", res.json()["submission"]["branch"])
    assert github.fake.pull(github.repo, 1).head == res.json()["submission"]["branch"]


# --- submitting again ---------------------------------------------------------------------------------


def test_with_nothing_changed_is_up_to_date_no_new_commit_no_new_pull_request(github: GH) -> None:
    fake, repo = github.fake, github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    head = fake.head_of(repo, first["branch"])
    fake.clear_records()

    again = github.submit(diagram_id)
    assert again.status_code == 200, again.text
    assert again.json()["outcome"] == "upToDate"
    assert again.json()["submission"]["prNumber"] == 1
    assert again.json()["submission"]["state"] == "open"
    assert fake.head_of(repo, first["branch"]) == head
    assert fake.calls_to("POST", r"git/commits$") == []
    assert fake.calls_to("PATCH", ".") == []
    assert len(repo.pulls) == 1
    assert len(github.rows("SELECT id FROM diagram_submission_pushes")) == 1
    assert github.submission_rows(diagram_id)[0].submitting_since is None


def test_after_a_save_pushes_one_more_commit_to_the_same_pull_request(github: GH) -> None:
    fake, repo = github.fake, github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    first_head = fake.head_of(repo, first["branch"])
    github.save(diagram_id, DSL_V2)

    res = github.submit(diagram_id)
    assert res.status_code == 200, res.text
    assert res.json()["outcome"] == "updated"
    submission = res.json()["submission"]
    assert (submission["prNumber"], submission["branch"], submission["path"]) == (1, first["branch"], first["path"])
    assert submission["submittedVersionSequence"] > first["submittedVersionSequence"]

    commits = fake.commits_on(repo, first["branch"])
    assert len(commits) == 3
    assert commits[1].sha == first_head
    assert 'Update "Order Flow"' in commits[0].message
    assert "Co-authored-by: Olivia Owner <owner@example.com>" in commits[0].message
    files = fake.files(repo, first["branch"])
    assert files is not None
    assert files["architecture/order-flow/order-flow.canvas.mmd"] == github.saved(diagram_id)
    assert "Invoice" in files["architecture/order-flow/order-flow.mmd"]

    assert len(repo.pulls) == 1
    assert f"version {submission['submittedVersionSequence']}" in fake.pull(repo, 1).title
    rows = github.submission_rows(diagram_id)
    assert len(rows) == 1
    assert rows[0].last_pushed_commit_sha == commits[0].sha
    pushes = github.rows("SELECT commit_sha, version_sequence FROM diagram_submission_pushes ORDER BY version_sequence")
    assert [p.commit_sha for p in pushes] == [first_head, commits[0].sha]
    assert len(github.events("diagram_submitted")) == 2


def test_reports_changes_since_submitting_after_a_save_and_a_rename_and_clears_it_on_resubmit(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    assert github.status(diagram_id)["current"] is None
    assert github.status(diagram_id)["changesSinceSubmitting"] is False
    github.submit(diagram_id)

    view = github.status(diagram_id)
    assert view["enabled"] is True
    assert view["link"] == {"repoFullName": "acme/architecture", "folder": "architecture", "baseBranch": "main"}
    assert view["changesSinceSubmitting"] is False
    assert view["current"]["state"] == "open"
    assert view["current"]["prNumber"] == 1
    assert "fingerprint" not in view["current"]

    github.save(diagram_id, DSL_V2)
    assert github.status(diagram_id)["changesSinceSubmitting"] is True
    assert github.submit(diagram_id).json()["outcome"] == "updated"
    assert github.status(diagram_id)["changesSinceSubmitting"] is False

    renamed = github.call("PATCH", f"/diagrams/{diagram_id}/name", "owner", json={"name": "Renamed"})
    assert renamed.status_code == 200
    assert github.status(diagram_id)["changesSinceSubmitting"] is True
    # A rename is not propagated: the folder and branch stay where they were first submitted.
    res = github.submit(diagram_id)
    assert res.status_code == 200, res.text
    assert res.json()["submission"]["path"] == "architecture/order-flow"


# --- a pull request merged or closed on GitHub --------------------------------------------------------


def test_merged_then_a_changed_diagram_opens_a_new_pull_request_r2_at_the_same_path(github: GH) -> None:
    fake, repo = github.fake, github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    fake.merge_pull(repo, 1)
    github.save(diagram_id, DSL_V2)

    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    assert res.json()["outcome"] == "created"
    submission = res.json()["submission"]
    assert (submission["prNumber"], submission["state"], submission["path"], submission["branch"]) == (
        2,
        "open",
        first["path"],
        f"canvas/{id8(diagram_id)}-order-flow-r2",
    )
    rows = github.submission_rows(diagram_id)
    assert [(r.pr_number, r.state) for r in rows] == [(1, "merged"), (2, "open")]
    assert rows[0].merged_by_login == "reviewer"
    assert bool(rows[0].merged_head_matches) is True  # SQLite stores booleans as 0/1
    # The second branch started from the merged base, so it carries only the new change.
    assert fake.commits_on(repo, f"canvas/{id8(diagram_id)}-order-flow-r2")[1].sha == fake.head_of(repo, "main")
    assert fake.pull(repo, 2).base == "main"


def test_merged_and_unchanged_the_base_already_has_the_files_so_nothing_new_opens(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.fake.merge_pull(github.repo, 1)

    res = github.submit(diagram_id)
    assert res.status_code == 200, res.text
    assert res.json()["outcome"] == "upToDate"
    assert res.json()["submission"] is None
    assert len(github.repo.pulls) == 1
    current = github.status(diagram_id)["current"]
    assert (current["state"], current["prNumber"], current["mergedBy"]) == ("merged", 1, "reviewer")
    assert [r for r in github.submission_rows(diagram_id) if r.state == "open"] == []


def test_merged_without_applying_to_the_base_branch_opens_r2_even_if_unchanged(github: GH) -> None:
    """E.g. squash-merged elsewhere."""
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.fake.merge_pull(github.repo, 1, apply_to_base=False)

    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    submission = res.json()["submission"]
    assert submission["prNumber"] == 2
    assert submission["branch"] == f"canvas/{id8(diagram_id)}-order-flow-r2"
    assert submission["path"] == "architecture/order-flow"


def test_closed_unmerged_then_submit_opens_a_new_pull_request_and_records_the_old_one_as_closed(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.fake.close_pull(github.repo, 1)

    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    assert res.json()["submission"]["prNumber"] == 2
    rows = github.submission_rows(diagram_id)
    assert [(r.pr_number, r.state) for r in rows] == [(1, "closed"), (2, "open")]
    assert rows[0].merged_head_matches is None


def test_merged_with_edits_made_on_github_is_flagged_merged_head_matches_false(github: GH) -> None:
    fake, repo = github.fake, github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    outside = fake.make_commit(
        repo, fake.head_of(repo, first["branch"]), {"architecture/order-flow/README.md": "edited by hand\n"}
    )
    fake.force_move_branch(repo, first["branch"], outside)
    fake.merge_pull(repo, 1)
    github.save(diagram_id, DSL_V2)
    github.submit(diagram_id)
    row = github.submission_rows(diagram_id)[0]
    assert row.state == "merged"
    assert row.merged_head_matches is not None
    assert bool(row.merged_head_matches) is False


# --- races and conflicts ------------------------------------------------------------------------------


def test_two_simultaneous_first_submits_exactly_one_pull_request_the_other_gets_409_in_progress(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.fake.latency_ms = 30
    results = github.parallel("POST", f"/diagrams/{diagram_id}/submissions", "owner", 2)
    github.fake.latency_ms = 0
    codes = sorted(r.status_code for r in results)
    assert codes == [201, 409], "\n".join(r.text for r in results)
    assert next(r for r in results if r.status_code == 409).json()["code"] == "in_progress"
    assert len(github.repo.pulls) == 1
    assert len([b for b in github.repo.branches if b.startswith("canvas/")]) == 1
    rows = github.submission_rows(diagram_id)
    assert len(rows) == 1
    assert rows[0].submitting_since is None


def test_two_simultaneous_updates_exactly_one_commit_is_pushed_the_other_gets_409_in_progress(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    github.save(diagram_id, DSL_V2)
    github.fake.latency_ms = 30
    results = github.parallel("POST", f"/diagrams/{diagram_id}/submissions", "owner", 2)
    github.fake.latency_ms = 0
    assert sorted(r.status_code for r in results) == [200, 409], "\n".join(r.text for r in results)
    assert next(r for r in results if r.status_code == 409).json()["code"] == "in_progress"
    assert len(github.fake.commits_on(github.repo, first["branch"])) == 3
    assert len(github.repo.pulls) == 1
    assert github.submission_rows(diagram_id)[0].submitting_since is None


def test_a_lock_left_by_a_request_that_died_stops_blocking_after_two_minutes(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.save(diagram_id, DSL_V2)
    _set_submitting_since(github, diagram_id, now_utc())
    assert github.submit(diagram_id).json()["code"] == "in_progress"
    _set_submitting_since(github, diagram_id, now_utc() - timedelta(minutes=3))
    res = github.submit(diagram_id)
    assert res.status_code == 200, res.text
    assert res.json()["outcome"] == "updated"


def test_a_stale_lock_does_not_hide_that_the_pull_request_was_merged(github: GH) -> None:
    """The merge is recorded and a new PR opens."""
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.fake.merge_pull(github.repo, 1, apply_to_base=False)
    _set_submitting_since(github, diagram_id, now_utc() - timedelta(minutes=3))
    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    assert res.json()["submission"]["prNumber"] == 2
    assert [(r.pr_number, r.state) for r in github.submission_rows(diagram_id)] == [(1, "merged"), (2, "open")]


def test_the_branch_moving_during_the_push_is_a_409_conflict_releases_the_lock_and_a_retry_succeeds(
    github: GH,
) -> None:
    fake, repo = github.fake, github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    github.save(diagram_id, DSL_V2)
    sibling = fake.make_commit(repo, fake.head_of(repo, "main"), {"unrelated.txt": "x"})

    def move_once(r: FakeRepo, branch: str) -> None:
        fake.before_ref_update = None  # once
        fake.force_move_branch(r, branch, sibling)

    fake.before_ref_update = move_once
    res = github.submit(diagram_id)
    assert res.status_code == 409, res.text
    assert res.json()["code"] == "conflict"
    assert github.submission_rows(diagram_id)[0].submitting_since is None

    # Canvas never force-pushes: the moved branch is left as GitHub has it.
    assert fake.head_of(repo, first["branch"]) == sibling
    retry = github.submit(diagram_id)
    assert retry.status_code == 200, retry.text
    assert retry.json()["outcome"] == "updated"
    files = fake.files(repo, first["branch"])
    assert files is not None
    assert "Invoice" in files["architecture/order-flow/order-flow.mmd"]
    assert files["unrelated.txt"] == "x"


def test_a_branch_deleted_on_github_is_a_409_conflict_with_the_lock_released(github: GH) -> None:
    """Restoring it lets the next submit work."""
    fake, repo = github.fake, github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    github.save(diagram_id, DSL_V2)
    head = fake.head_of(repo, first["branch"])
    fake.delete_branch(repo, first["branch"])

    res = github.submit(diagram_id)
    assert res.status_code == 409, res.text
    assert res.json()["code"] == "conflict"
    assert github.submission_rows(diagram_id)[0].submitting_since is None

    fake.force_move_branch(repo, first["branch"], head)
    retry = github.submit(diagram_id)
    assert retry.status_code == 200, retry.text
    assert retry.json()["outcome"] == "updated"


def test_a_force_pushed_branch_is_built_on_never_overwritten(github: GH) -> None:
    """Canvas does not force-push."""
    fake, repo = github.fake, github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id).json()["submission"]
    github.save(diagram_id, DSL_V2)
    rewritten = fake.make_commit(repo, fake.head_of(repo, "main"), {"note.txt": "someone force-pushed"})
    fake.force_move_branch(repo, first["branch"], rewritten)
    res = github.submit(diagram_id)
    assert res.status_code == 200, res.text
    assert fake.commits_on(repo, first["branch"])[1].sha == rewritten
    patches = fake.calls_to("PATCH", r"git/refs")
    assert patches
    assert all(r.body["force"] is False for r in patches)


def test_moving_the_link_to_another_repository_while_a_pull_request_is_open_is_409_link_changed(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.link_project("architecture", github.other_repo)
    res = github.submit(diagram_id)
    assert res.status_code == 409, res.text
    assert res.json()["code"] == "link_changed"
    assert len(github.other_repo.pulls) == 0
    assert list(github.other_repo.branches) == ["main"]
    row = github.submission_rows(diagram_id)[0]
    assert row.state == "open"
    assert row.submitting_since is None


def test_moving_the_link_to_another_folder_while_a_pull_request_is_open_is_also_409_link_changed(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.link_project("docs/diagrams")
    assert github.submit(diagram_id).json()["code"] == "link_changed"


def test_a_deleted_base_branch_is_409_not_linked_and_leaves_no_half_made_submission_behind(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.fake.delete_branch(github.repo, "main")
    res = github.submit(diagram_id)
    assert res.status_code == 409, res.text
    assert res.json()["code"] == "not_linked"
    assert github.submission_rows(diagram_id) == []


# --- a pull request Canvas opened but did not record (canvas-3s5.5) -----------------------------------


def _forget_submissions(github: GH, diagram_id: str) -> None:
    """The request died after GitHub created the pull request: Canvas has no row for it."""
    for row in github.submission_rows(diagram_id):
        github.api.execute("DELETE FROM diagram_submission_pushes WHERE submission_id = :id", id=str(row.id))
    github.api.execute("DELETE FROM diagram_submissions WHERE diagram_id = :id", id=diagram_id)


def test_adopts_it_the_next_submit_pushes_to_that_pull_request_instead_of_opening_a_second_one(github: GH) -> None:
    repo = github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    first = github.submit(diagram_id)
    assert first.status_code == 201, first.text
    pr_number, branch = first.json()["submission"]["prNumber"], first.json()["submission"]["branch"]
    head_before = repo.branches[branch]
    _forget_submissions(github, diagram_id)

    github.save(diagram_id, DSL_V2)
    again = github.submit(diagram_id)
    assert again.status_code == 200, again.text
    assert again.json()["outcome"] == "updated"
    submission = again.json()["submission"]
    assert (submission["prNumber"], submission["branch"], submission["state"]) == (pr_number, branch, "open")
    assert len(github.fake.open_pulls(repo)) == 1
    assert repo.commits[repo.branches[branch]].parents == [head_before]
    rows = github.submission_rows(diagram_id)
    assert len(rows) == 1
    assert (rows[0].pr_number, rows[0].branch, rows[0].state) == (pr_number, branch, "open")
    assert rows[0].submitting_since is None


def test_with_nothing_changed_it_is_adopted_and_reported_up_to_date(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    pr_number = github.submit(diagram_id).json()["submission"]["prNumber"]
    _forget_submissions(github, diagram_id)

    again = github.submit(diagram_id)
    assert again.status_code == 200, again.text
    assert again.json()["outcome"] == "upToDate"
    assert again.json()["submission"]["prNumber"] == pr_number
    assert len(github.fake.open_pulls(github.repo)) == 1


def test_does_not_adopt_a_matching_pull_request_opened_by_a_person_or_one_from_a_fork(github: GH) -> None:
    repo = github.repo
    github.link_project()
    diagram_id = github.create_diagram()
    pr_number = github.submit(diagram_id).json()["submission"]["prNumber"]
    _forget_submissions(github, diagram_id)
    repo.pulls[pr_number].author = "mallory"

    again = github.submit(diagram_id)
    assert again.status_code == 201, again.text
    assert again.json()["submission"]["prNumber"] != pr_number

    _forget_submissions(github, diagram_id)
    for pull in github.fake.open_pulls(repo):
        pull.author = None
        pull.head_repo = "mallory/architecture"
    third = github.submit(diagram_id)
    assert third.status_code == 201, third.text
    assert len(github.fake.open_pulls(repo)) == 3


def test_does_not_adopt_another_diagrams_pull_request(github: GH) -> None:
    github.link_project()
    other = github.create_diagram("Billing Flow")
    other_pr = github.submit(other).json()["submission"]["prNumber"]
    diagram_id = github.create_diagram()

    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    assert res.json()["submission"]["prNumber"] != other_pr
    assert github.submission_rows(other)[0].pr_number == other_pr


# --- GitHub failures ----------------------------------------------------------------------------------


def test_github_being_down_is_a_502_leaves_no_provisional_submission_and_the_next_submit_works(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.fake.fail_with = (500, {})
    res = github.submit(diagram_id)
    assert res.status_code == 502, res.text
    github.fake.fail_with = None
    assert github.submission_rows(diagram_id) == []
    assert github.submit(diagram_id).status_code == 201


def test_a_rate_limit_is_a_503_github_rate_limited_and_later_calls_wait_without_reaching_github(github: GH) -> None:
    """canvas-3s5.4. Each test builds its own app (and GitHub client), so the back-off doesn't leak."""
    github.link_project()
    diagram_id = github.create_diagram()
    github.fake.fail_with = (403, {"x-ratelimit-remaining": "0"})
    res = github.submit(diagram_id)
    assert res.status_code == 503, res.text
    assert res.json()["code"] == "github_rate_limited"
    assert re.search(r"try again after \d\d:\d\d UTC", res.json()["error"])
    github.fake.fail_with = None
    github.fake.clear_records()
    assert github.submit(diagram_id).status_code == 503
    assert github.fake.requests == []


def test_the_app_losing_its_installation_is_a_502_github_access_not_a_crash(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.fake.remove_repo_from_installation(github.repo)
    res = github.submit(diagram_id)
    assert res.status_code == 502, res.text
    assert res.json()["code"] == "github_access"
    assert github.submission_rows(diagram_id) == []


def test_never_puts_a_token_in_an_error_response(github: GH) -> None:
    github.link_project()
    diagram_id = github.create_diagram()
    github.submit(diagram_id)
    github.fake.remove_installation(github.repo.installation_id)
    res = github.submit(diagram_id)
    assert not re.search(r"ghs_|Bearer |-----BEGIN", res.text)


# --- documents that embed the diagram (canvas-finl) ---------------------------------------------------
# Markdown documents that embed the diagram (<!-- MERMAID: path -->) are updated in the same pull request;
# markers for other diagrams, or for files that don't exist, are left alone.

MMD = "architecture/order-flow/order-flow.mmd"
SVG = "architecture/order-flow/order-flow.svg"
HLD = "\n".join(
    [
        "# High Level Design",
        "",
        f"<!-- MERMAID: {MMD} -->",
        "",
        "## Picture",
        f"<!-- MERMAID: {SVG} -->",
        "",
        "<!-- MERMAID: architecture/other/other.mmd -->",
        "<!-- MERMAID: architecture/order_flow/order_flow.mmd -->",
        "",
    ]
)


def _seed_docs(github: GH, files: dict[str, str]) -> None:
    sha = github.fake.make_commit(github.repo, github.fake.head_of(github.repo, "main"), files, "docs")
    github.fake.force_move_branch(github.repo, "main", sha)


def test_fills_the_markers_that_point_at_this_diagram_in_the_same_commit_and_lists_the_document(github: GH) -> None:
    fake, repo = github.fake, github.repo
    _seed_docs(github, {"docs/hld.md": HLD, "docs/unrelated.md": "# Nothing here\n"})
    main_before = fake.head_of(repo, "main")
    github.link_project()
    diagram_id = github.create_diagram()
    res = github.submit(diagram_id)
    assert res.status_code == 201, res.text
    branch = res.json()["submission"]["branch"]

    files = fake.files(repo, branch)
    assert files is not None
    portable = re.sub(r"\s+$", "", files[MMD])
    hld = files["docs/hld.md"]
    assert f"<!-- MERMAID: {MMD} -->\n```mermaid\n{portable}\n```\n<!-- /MERMAID -->\n" in hld
    assert (
        f"<!-- MERMAID: {SVG} -->\n![order-flow](../architecture/order-flow/order-flow.svg)\n<!-- /MERMAID -->\n" in hld
    )
    # Other diagrams' markers and a path that doesn't exist are untouched.
    assert (
        "<!-- MERMAID: architecture/other/other.mmd -->\n<!-- MERMAID: architecture/order_flow/order_flow.mmd -->\n"
        in hld
    )
    assert len(re.findall(r"/MERMAID", hld)) == 2
    assert files["docs/unrelated.md"] == "# Nothing here\n"

    # One commit for diagram and document; main itself is unchanged.
    assert len(fake.commits_on(repo, branch)) == len(fake.commits_on(repo, "main")) + 1
    assert fake.head_of(repo, "main") == main_before
    main_files = fake.files(repo, "main")
    assert main_files is not None
    assert main_files["docs/hld.md"] == HLD

    body = fake.pull(repo, 1).body
    assert "Documents that embed this diagram (1)" in body
    assert "[docs/hld.md](docs/hld.md)" in body


def test_pushing_an_update_rewrites_the_embedded_copy_an_unchanged_resubmit_is_still_up_to_date(github: GH) -> None:
    _seed_docs(github, {"docs/hld.md": HLD})
    github.link_project()
    diagram_id = github.create_diagram()
    branch = github.submit(diagram_id).json()["submission"]["branch"]

    github.save(diagram_id, DSL_V2)
    update = github.submit(diagram_id)
    assert update.status_code == 200, update.text
    assert update.json()["outcome"] == "updated"
    files = github.fake.files(github.repo, branch)
    assert files is not None
    hld = files["docs/hld.md"]
    assert "Invoice" in hld
    assert len(re.findall(r"```mermaid", hld)) == 1
    assert len(re.findall(r"/MERMAID", hld)) == 2

    again = github.submit(diagram_id)
    assert again.json()["outcome"] == "upToDate"


def test_a_repository_with_no_markers_gets_no_document_changes_and_no_documents_section(github: GH) -> None:
    _seed_docs(github, {"docs/readme.md": "# Docs\n"})
    github.link_project()
    diagram_id = github.create_diagram()
    branch = github.submit(diagram_id).json()["submission"]["branch"]
    files = github.fake.files(github.repo, branch)
    assert files is not None
    assert files["docs/readme.md"] == "# Docs\n"
    assert "Documents that embed" not in github.fake.pull(github.repo, 1).body
