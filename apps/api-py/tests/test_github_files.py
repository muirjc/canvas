"""Byte parity between the Python GitHub submission code (canvas_api/github/files.py, paths.py, jstext.py) and
the TypeScript originals (apps/api/src/github/submission-files.ts, folder-path.ts).

A diagram submitted from one service and resubmitted unchanged from the other must build the same files, or
the resubmit would push a pointless commit instead of answering "up to date". The inputs are in
tests/github_parity_cases.py (emoji and other astral characters at truncation limits, Markdown specials, CR/LF,
Unicode spaces, accents, a 60k+ pull request body, floats like 2.0 in a standard's rules); the expected outputs
in tests/github_parity_expected.py were computed once by running those cases through the TypeScript functions.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from typing import Any

import pytest

from canvas_api.github.files import (
    SubmissionInput,
    SubmissionStandard,
    build_commit_message,
    build_pr_body,
    build_pr_title,
    build_submission_files,
    escape_markdown,
    one_line,
    submission_fingerprint,
)
from canvas_api.github.jstext import js_len, js_stringify, js_utf8
from canvas_api.github.paths import InvalidRepoPathError, assert_safe_repo_path, normalize_folder, slugify
from tests.github_parity_cases import all_cases
from tests.github_parity_expected import EXPECTED

CASES = all_cases()


def spec(value: Any) -> Any:
    """How the expected file records an output: a short string as is, a long one as its UTF-8 hash and length
    in UTF-16 code units (what JavaScript's .length counts)."""
    if isinstance(value, str):
        if js_len(value) <= 300:
            return {"v": value}
        return {"sha256": hashlib.sha256(js_utf8(value)).hexdigest(), "len": js_len(value)}
    return value


def submission_input(raw: dict[str, Any]) -> SubmissionInput:
    standard = raw["standard"]
    return SubmissionInput(
        diagram_id=raw["diagramId"],
        name=raw["name"],
        description=raw["description"],
        diagram_type_id=raw["diagramTypeId"],
        diagram_type_name=raw["diagramTypeName"],
        dsl_family=raw["dslFamily"],
        dsl_content=raw["dslContent"],
        portable_mermaid=raw["portableMermaid"],
        svg=raw["svg"],
        version_sequence=raw["versionSequence"],
        standard=SubmissionStandard(
            standard["id"], standard["version"], standard["name"], standard["description"], standard["rules"]
        )
        if standard
        else None,
        path=raw["path"],
        slug=raw["slug"],
        canvas_url=raw["canvasUrl"],
        validator=raw["validator"],
    )


RUNNERS: dict[str, Callable[..., Any]] = {
    "slugify": lambda name: spec(slugify(name)),
    "normalize_folder": lambda folder: spec(normalize_folder(folder)),
    "assert_safe_repo_path": lambda path: spec(assert_safe_repo_path(path)),
    "escape_markdown": lambda text: spec(escape_markdown(text)),
    "one_line": lambda text, size: spec(one_line(text, size)),
    "fingerprint": lambda dsl, name, description: spec(submission_fingerprint(dsl, name, description)),
    "stringify": lambda value, indent: spec(js_stringify(value, indent)),
    "files": lambda raw: [
        {"path": f["path"], "content": spec(f["content"])} for f in build_submission_files(submission_input(raw))
    ],
    "pr_title": lambda name, version: spec(build_pr_title(name, version)),
    "commit": lambda name, version, url, author, email, update: spec(
        build_commit_message(name, version, url, author, email, update)
    ),
    "pr_body": lambda raw, warnings, by, documents: spec(build_pr_body(submission_input(raw), warnings, by, documents)),
}


def run(case: dict[str, Any]) -> Any:
    try:
        return RUNNERS[case["fn"]](*case["args"])
    except InvalidRepoPathError as error:
        return {"error": str(error)}


def test_every_case_has_an_expected_output_and_no_stale_ones_remain() -> None:
    assert set(EXPECTED) == {c["id"] for c in CASES}


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_matches_the_typescript_output(case: dict[str, Any]) -> None:
    assert run(case) == EXPECTED[case["id"]]
