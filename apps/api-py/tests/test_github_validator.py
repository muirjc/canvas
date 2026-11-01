"""The CI validator Canvas commits with every submission (.canvas/validator.mjs), the example workflow
endpoint, and a real end-to-end proof: the bundle a submission commits validates what the same submission
committed. Port of apps/api/tests/contract/github-validator.test.ts."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from canvas_api.github.validator_bundle import DEFAULT_DIR, validator_bundle
from tests.github_helpers import DSL, GH, VALIDATOR_PATH

VALIDATOR_PKG = Path(__file__).resolve().parents[3] / "packages" / "validator-cli"


def branch_files(github: GH, branch: str) -> dict[str, str]:
    files = github.fake.files(github.repo, branch)
    assert files is not None
    return files


@pytest.fixture()
def linked(github: GH) -> GH:
    github.link_project()
    return github


# --- .canvas/validator.mjs in the pull request --------------------------------------------------------


def test_is_committed_with_the_content_of_the_configured_validator(linked: GH) -> None:
    linked.use_validator("// validator v1\n")
    res = linked.submit(linked.create_diagram())
    assert res.status_code == 201, res.text
    assert branch_files(linked, res.json()["submission"]["branch"])[VALIDATOR_PATH] == "// validator v1\n"


def test_is_left_out_when_no_validator_is_available(linked: GH) -> None:
    linked.use_validator(None)
    res = linked.submit(linked.create_diagram())
    assert res.status_code == 201, res.text
    assert VALIDATOR_PATH not in branch_files(linked, res.json()["submission"]["branch"])


def test_without_a_configured_directory_the_built_validator_in_the_repository_is_used() -> None:
    """Python only. The TypeScript service ignores the repository's build under NODE_ENV=test (so what a
    developer has built can't change results); Python has no such switch, and the test fixtures always point
    CANVAS_VALIDATOR_DIR somewhere. Here: unset means packages/validator-cli/dist."""
    assert DEFAULT_DIR == VALIDATOR_PKG / "dist"
    built = DEFAULT_DIR / "validator.mjs"
    assert validator_bundle(None) == (built.read_text(encoding="utf-8") if built.exists() else None)


def test_resubmitting_unchanged_is_up_to_date_no_new_commit_even_though_the_validator_is_included(linked: GH) -> None:
    linked.use_validator("// validator v1\n")
    diagram_id = linked.create_diagram()
    first = linked.submit(diagram_id).json()["submission"]
    head = linked.fake.head_of(linked.repo, first["branch"])
    linked.fake.clear_records()

    again = linked.submit(diagram_id)
    assert again.status_code == 200, again.text
    assert again.json()["outcome"] == "upToDate"
    assert linked.fake.head_of(linked.repo, first["branch"]) == head
    assert linked.fake.calls_to("POST", r"git/commits$") == []


def test_a_changed_validator_is_committed_by_the_next_submission_and_only_that_file_changes(linked: GH) -> None:
    linked.use_validator("// validator v1\n")
    diagram_id = linked.create_diagram()
    first = linked.submit(diagram_id).json()["submission"]
    before = dict(branch_files(linked, first["branch"]))
    head = linked.fake.head_of(linked.repo, first["branch"])

    linked.use_validator("// validator v2\n")
    again = linked.submit(diagram_id)
    assert again.status_code == 200, again.text
    assert again.json()["outcome"] == "updated"
    assert linked.fake.head_of(linked.repo, first["branch"]) != head

    after = branch_files(linked, first["branch"])
    changed = [path for path in after if before.get(path) != after.get(path)]
    assert changed == [VALIDATOR_PATH]
    assert after[VALIDATOR_PATH] == "// validator v2\n"


# --- GET /admin/github/workflow-example and status ----------------------------------------------------


def test_an_admin_gets_the_workflow_as_a_text_yaml_attachment(linked: GH) -> None:
    linked.use_validator("// v\n", "name: Canvas diagrams\n")
    res = linked.call("GET", "/admin/github/workflow-example", "admin")
    assert res.status_code == 200, res.text
    assert "text/yaml" in res.headers["content-type"]
    assert res.headers["content-disposition"] == 'attachment; filename="canvas-diagrams.yml"'
    assert res.text == "name: Canvas diagrams\n"


def test_a_non_admin_gets_403_and_an_anonymous_request_401(linked: GH) -> None:
    linked.use_validator("// v\n", "name: x\n")
    assert linked.call("GET", "/admin/github/workflow-example", "owner").status_code == 403
    assert linked.call("GET", "/admin/github/workflow-example", None).status_code == 401


def test_the_workflow_is_404_when_it_is_not_available(linked: GH) -> None:
    linked.use_validator("// v\n", None)
    assert linked.call("GET", "/admin/github/workflow-example", "admin").status_code == 404


def test_status_reports_validator_available(linked: GH) -> None:
    def available() -> bool:
        return bool(linked.call("GET", "/admin/github/status", "admin").json()["validatorAvailable"])

    assert available() is False
    linked.use_validator("// v\n")
    assert available() is True
    linked.use_validator(None)
    assert available() is False


# --- the committed validator checks what the same submission committed --------------------------------


@pytest.fixture(scope="module")
def built_validator() -> Path:
    node = shutil.which("node")
    if node is None:
        pytest.skip("needs node")
    subprocess.run([node, "scripts/build.mjs"], cwd=VALIDATOR_PKG, check=True, capture_output=True)  # noqa: S603
    return VALIDATOR_PKG / "dist"


def _checkout(github: GH, branch: str, into: Path) -> Path:
    for path, content in branch_files(github, branch).items():
        full = into / path
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
    return into


def _run_validator(cwd: Path) -> tuple[int, str]:
    node = shutil.which("node")
    assert node
    done = subprocess.run(  # noqa: S603 - the committed bundle, node from PATH
        [node, VALIDATOR_PATH, "--format", "github"],
        cwd=cwd,
        env={"PATH": str(Path(node).parent)},
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    return done.returncode, done.stdout


def test_passes_on_the_untouched_checkout_and_fails_with_an_annotation_once_the_source_is_tampered_with(
    linked: GH, built_validator: Path, tmp_path: Path
) -> None:
    linked.app.state.settings.canvas_validator_dir = str(built_validator)
    from canvas_api.github.validator_bundle import reset_cache

    reset_cache()
    linked.publish_standard()
    res = linked.submit(linked.create_diagram())
    assert res.status_code == 201, res.text
    branch = res.json()["submission"]["branch"]
    source_path = "architecture/order-flow/order-flow.canvas.mmd"
    assert VALIDATOR_PATH in branch_files(linked, branch)

    code, stdout = _run_validator(_checkout(linked, branch, tmp_path / "clean"))
    assert "1 diagram checked: 0 errors, 0 warnings." in stdout
    assert code == 0

    # Break the standard: a node of a kind the standard doesn't define (and a hash mismatch warning).
    broken = _checkout(linked, branch, tmp_path / "broken")
    (broken / source_path).write_text(DSL.replace("B[Ship order]:::step", "B[Ship order]:::mystery"), encoding="utf-8")
    code, stdout = _run_validator(broken)
    assert code == 1
    assert re.search(rf"^::error file={re.escape(source_path)},line=\d+,title=Must fix", stdout, re.MULTILINE)
    assert f"::warning file={source_path}" in stdout

    # Break the syntax.
    syntax = _checkout(linked, branch, tmp_path / "syntax")
    (syntax / source_path).write_text("flowchart TD\n  A[Receive order]:::step --> B[Ship\n", encoding="utf-8")
    code, stdout = _run_validator(syntax)
    assert code == 1
    assert re.search(rf"^::error file={re.escape(source_path)}(,line=\d+)?,title=Syntax error", stdout, re.MULTILINE)
