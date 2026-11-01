"""The files a submission commits, the pull request text and the commit message
(apps/api/src/github/submission-files.ts). Pure functions, no I/O.

Nothing here depends on the time or on who submits, so submitting the same saved version twice builds the
same files (and GitHub reports an unchanged tree). The output must match the TypeScript service byte for
byte too: a diagram submitted from one service and resubmitted unchanged from the other is "up to date".

    <path>/README.md          what a reviewer reads first: the SVG, then details
    <path>/<slug>.svg         the rendered diagram
    <path>/<slug>.mmd         portable Mermaid (Canvas front-matter removed)
    <path>/<slug>.canvas.mmd  Canvas's own source, byte for byte
    <path>/canvas.json        manifest the CI validator reads
    .canvas/standards/<type>/v<version>.json   the standard it was checked against
    .canvas/validator.mjs     the validator the repository's CI runs (canvas-3s5.3)
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from canvas_api.github.jstext import JS_WHITESPACE, js_len, js_slice, js_stringify, js_trim, js_utf8
from canvas_api.github.paths import assert_safe_repo_path


@dataclass(frozen=True)
class SubmissionStandard:
    id: str
    version: int
    name: str | None
    description: str | None
    rules: Any


@dataclass(frozen=True)
class SubmissionInput:
    diagram_id: str
    name: str
    description: str | None
    diagram_type_id: str
    diagram_type_name: str
    dsl_family: str
    dsl_content: str
    portable_mermaid: str
    svg: str
    version_sequence: int
    standard: SubmissionStandard | None
    #: The diagram's folder in the repository, e.g. "architecture/diagrams/order-flow".
    path: str
    slug: str
    canvas_url: str
    #: canvas-3s5.3: the CI validator bundle, committed as .canvas/validator.mjs (None when not built).
    validator: str | None = None


PR_BODY_LIMIT = 60_000
MAX_LISTED_WARNINGS = 50
_SEVERITY_LABEL = {"warning": "Warning", "info": "Info", "error": "Must fix"}
_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]()<>#+!|~])")
_WS = re.compile(f"[{JS_WHITESPACE}]+")


def sha256(text: str) -> str:
    return hashlib.sha256(js_utf8(text)).hexdigest()


def submission_fingerprint(dsl_content: str, name: str, description: str | None) -> str:
    """What "changes since submitting" compares: the saved source, name and description."""
    return sha256(js_stringify([dsl_content, name, description or ""]))


def escape_markdown(text: str) -> str:
    """Text from Canvas users placed in Markdown: no formatting, links, HTML or @mentions."""
    text = re.sub(r"[\r\n]+", " ", text)
    text = _MARKDOWN_SPECIAL.sub(r"\\\1", text)
    return text.replace("@", "@\u200b")


def one_line(text: str, max_length: int = 120) -> str:
    """A single line for a commit message or PR title (no line breaks, bounded)."""
    line = js_trim(_WS.sub(" ", re.sub(r"[\r\n\t]+", " ", text)))
    return f"{js_slice(line, 0, max_length - 1)}…" if js_len(line) > max_length else line


def _fence_for(content: str) -> str:
    """A code fence longer than any backtick run inside `content`, so the content can't close it."""
    longest = max([2, *(len(m) for m in re.findall(r"`+", content))])
    return "`" * (longest + 1)


def encode_uri_component(text: str) -> str:
    """JavaScript's encodeURIComponent."""
    return quote(text, safe="!'()*-._~")


def encode_uri(text: str) -> str:
    """JavaScript's encodeURI."""
    return quote(text, safe="!#$&'()*+,-./:;=?@_~")


def standard_path(diagram_type_id: str, version: int) -> str:
    return assert_safe_repo_path(f".canvas/standards/{diagram_type_id}/v{version}.json")


def build_manifest(i: SubmissionInput) -> dict[str, Any]:
    return {
        "schema": 1,
        "generatedBy": "Canvas",
        "diagramId": i.diagram_id,
        "name": i.name,
        "diagramType": i.diagram_type_id,
        "dslFamily": i.dsl_family,
        "versionSequence": i.version_sequence,
        "source": f"{i.slug}.canvas.mmd",
        "sourceSha256": sha256(i.dsl_content),
        "portable": f"{i.slug}.mmd",
        "svg": f"{i.slug}.svg",
        "standard": (
            {
                "path": standard_path(i.diagram_type_id, i.standard.version),
                "id": i.standard.id,
                "version": i.standard.version,
                "name": i.standard.name,
            }
            if i.standard
            else None
        ),
        "canvasUrl": i.canvas_url,
    }


def _standard_label(i: SubmissionInput, none: str) -> str:
    if not i.standard:
        return none
    return f"{escape_markdown(i.standard.name or 'Standard')} (version {i.standard.version})"


def _build_readme(i: SubmissionInput) -> str:
    name = escape_markdown(i.name)
    fence = _fence_for(i.portable_mermaid)
    lines = [
        f"# {name}",
        "",
        f"![{name}](./{i.slug}.svg)",
        "",
        # canvas-n85n: Mermaid has no syntax for positions, so GitHub's own render of the source below is
        # laid out automatically; the picture above is the authoritative one.
        "_Layout as drawn in Canvas._",
        "",
        "| | |",
        "|---|---|",
        f"| Diagram type | {escape_markdown(i.diagram_type_name)} |",
        f"| Canvas version | {i.version_sequence} |",
        f"| Standard | {_standard_label(i, 'None')} |",
        f"| Open in Canvas | [{name}]({i.canvas_url}) |",
        "",
    ]
    description = js_trim(i.description) if i.description else ""
    if description:
        lines += [escape_markdown(description), ""]
    lines += [
        "<details><summary>Mermaid source</summary>",
        "",
        "GitHub arranges this view automatically, so positions differ from Canvas."
        " Colours are kept where Mermaid supports them.",
        "",
        f"{fence}mermaid",
        _trim_end(i.portable_mermaid),
        fence,
        "",
        "</details>",
        "",
        "_Generated by Canvas. Edit this diagram in Canvas, not here: changes made in this repository are not"
        " copied back._",
        "",
    ]
    return "\n".join(lines)


def _trim_end(text: str) -> str:
    """`text.trimEnd()`."""
    return re.sub(f"[{JS_WHITESPACE}]+$", "", text)


def build_submission_files(i: SubmissionInput) -> list[dict[str, str]]:
    def at(file: str) -> str:
        return assert_safe_repo_path(f"{i.path}/{file}")

    files = [
        {"path": at("README.md"), "content": _build_readme(i)},
        {"path": at(f"{i.slug}.svg"), "content": i.svg},
        {"path": at(f"{i.slug}.mmd"), "content": i.portable_mermaid},
        {"path": at(f"{i.slug}.canvas.mmd"), "content": i.dsl_content},
        {"path": at("canvas.json"), "content": js_stringify(build_manifest(i), indent=2) + "\n"},
    ]
    if i.standard:
        s = i.standard
        standard = {
            "id": s.id,
            "diagramTypeId": i.diagram_type_id,
            "version": s.version,
            "name": s.name,
            "description": s.description,
            "rules": s.rules,
        }
        files.append(
            {"path": standard_path(i.diagram_type_id, s.version), "content": js_stringify(standard, indent=2) + "\n"}
        )
    if i.validator:
        files.append({"path": assert_safe_repo_path(".canvas/validator.mjs"), "content": i.validator})
    return files


def build_pr_title(name: str, version_sequence: int) -> str:
    return f"Canvas: {one_line(name, 100)} (version {version_sequence})"


def build_pr_body(
    i: SubmissionInput, warnings: list[dict[str, Any]], submitted_by: str, documents: list[str] | None = None
) -> str:
    """`documents` (canvas-finl): documents in the repository that embed this diagram."""
    documents = documents or []
    name = escape_markdown(i.name)
    lines = [
        f"**{name}** submitted from Canvas for approval by {escape_markdown(submitted_by)}.",
        "",
        f"- Diagram type: {escape_markdown(i.diagram_type_name)}",
        f"- Canvas version: {i.version_sequence}",
        f"- Standard: {_standard_label(i, 'none')}",
        f"- Open in Canvas: [{name}]({i.canvas_url})",
        "",
        f"See [README.md]({encode_uri(f'{i.path}/README.md')}) in this pull request for the rendered diagram.",
        "",
        "Merging this pull request approves this version in Canvas; closing it without merging rejects it.",
        "Further changes are made in Canvas and pushed to this pull request; edits made here are not copied back.",
        "",
    ]
    if warnings:
        lines += [f"### Standard findings ({len(warnings)})", ""]
        for w in warnings[:MAX_LISTED_WARNINGS]:
            severity = str(w.get("severity"))
            lines.append(f"- {_SEVERITY_LABEL.get(severity, severity)}: {escape_markdown(str(w.get('message', '')))}")
        if len(warnings) > MAX_LISTED_WARNINGS:
            lines.append(f"- …and {len(warnings) - MAX_LISTED_WARNINGS} more (see the Issues tab in Canvas)")
        lines.append("")
    if documents:
        lines += [
            f"### Documents that embed this diagram ({len(documents)})",
            "",
            "Updated in this pull request where they were out of date.",
            "",
        ]
        lines += [f"- [{escape_markdown(doc)}]({encode_uri(doc)})" for doc in documents[:MAX_LISTED_WARNINGS]]
        if len(documents) > MAX_LISTED_WARNINGS:
            lines.append(f"- …and {len(documents) - MAX_LISTED_WARNINGS} more")
        lines.append("")
    # The marker identifies the diagram from the pull request alone, so truncation must never cut it.
    marker = f"<!-- canvas:diagram={i.diagram_id} -->"
    body = "\n".join(lines)
    room = PR_BODY_LIMIT - js_len(marker) - 20
    if js_len(body) > room:
        return f"{js_slice(body, 0, room)}\n\n…(truncated)\n\n{marker}"
    return f"{body}\n{marker}"


def build_commit_message(
    name: str, version_sequence: int, canvas_url: str, author_name: str, author_email: str, update: bool
) -> str:
    """The commit message, crediting the Canvas user with a Co-authored-by trailer."""
    co_author = one_line(re.sub(r"[<>]", "", author_name), 100) or author_email
    email = re.sub(f"[<>{JS_WHITESPACE}]", "", author_email)
    return "\n".join(
        [
            f'{"Update" if update else "Submit"} "{one_line(name, 80)}" (version {version_sequence}) from Canvas',
            "",
            f"Canvas: {canvas_url}",
            "",
            f"Co-authored-by: {co_author} <{email}>",
            "",
        ]
    )
