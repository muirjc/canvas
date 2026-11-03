"""canvas-1bty.15.6: diagram embeds in Markdown (diagram_core/embeds.py, port of markdown-embeds.ts).

Native cases mirror the TypeScript contract test; a seeded fuzz compares the native port with the TypeScript one
(the bridge's `embeds` op) on random documents: every marker form, current/stale/missing/unsupported sections,
odd paths, fences, CRLF, unicode and `only`. The fuzz needs Node and the bridge bundle (skips without).
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from typing import Any

import pytest

from canvas_api.diagram_core.embeds import EMBED_END_MARKER, find_embed_markers, normalise_embed_path, update_embeds
from tests.diagram_bridge import DiagramBridge

MMD = "architecture/prod/diagrams/product-context/product-context.mmd"
SVG = "architecture/prod/diagrams/product-context/product-context.svg"
DOC = "architecture/hld/sample_hld.md"
MERMAID = "flowchart LR\n  A[Customer] --> B[Shop]\n"
BOTH: dict[str, Any] = {MMD: {"kind": "mermaid", "text": MERMAID}, SVG: {"kind": "svg"}}


def test_fills_a_bare_marker_and_leaves_the_rest_alone() -> None:
    doc = f"# High Level Design\n\n### Product Context Diagram\n\n<!-- MERMAID: {MMD} -->\n\n### More stuff\n"
    out = update_embeds(doc, DOC, BOTH)
    assert out["changed"] is True
    assert out["results"] == [{"target": MMD, "path": MMD, "line": 5, "status": "filled"}]
    assert out["markdown"] == (
        f"# High Level Design\n\n### Product Context Diagram\n\n<!-- MERMAID: {MMD} -->\n```mermaid\n"
        f"flowchart LR\n  A[Customer] --> B[Shop]\n```\n{EMBED_END_MARKER}\n\n### More stuff\n"
    )


def test_is_idempotent_and_replaces_only_the_section() -> None:
    filled = update_embeds(f"<!-- MERMAID: {MMD} -->\n", DOC, BOTH)["markdown"]
    again = update_embeds(filled, DOC, BOTH)
    assert again == {"markdown": filled, "changed": False, "results": [again["results"][0]]}
    assert again["results"][0]["status"] == "current"
    changed = update_embeds(
        f"intro\n{filled}outro\n", DOC, {MMD: {"kind": "mermaid", "text": "flowchart TD\n  X --> Y\n"}}
    )
    assert changed["results"][0]["status"] == "updated"
    assert changed["markdown"] == (
        f"intro\n<!-- MERMAID: {MMD} -->\n```mermaid\nflowchart TD\n  X --> Y\n```\n{EMBED_END_MARKER}\noutro\n"
    )
    gone = update_embeds(filled, DOC, {})
    assert gone["markdown"] == filled
    assert gone["results"][0]["status"] == "missing"


def test_svg_image_links_are_relative_to_the_document() -> None:
    doc = f"<!-- MERMAID: {SVG} -->\n"
    assert (
        "![product-context](../prod/diagrams/product-context/product-context.svg)"
        in (update_embeds(doc, DOC, BOTH)["markdown"])
    )
    assert (
        "](./product-context.svg)"
        in update_embeds(doc, "architecture/prod/diagrams/product-context/n.md", BOTH)["markdown"]
    )
    assert f"](./{SVG})" in update_embeds(doc, "README.md", BOTH)["markdown"]
    odd = "a/[x] y%#é😀.svg".replace(" ", "_")
    assert update_embeds(f"<!-- MERMAID: {odd} -->", "README.md", {odd: {"kind": "svg"}})["markdown"].endswith(
        "![x_y%#é😀](./a/%5Bx%5D_y%25%23%C3%A9%F0%9F%98%80.svg)\n<!-- /MERMAID -->"
    )


def test_unsupported_code_blocks_only_crlf_and_prefixes() -> None:
    doc = "<!-- MERMAID: a/b.png -->\n<!-- MERMAID: a/b.canvas.mmd -->\n<!-- MERMAID: ../other/b.mmd -->\n"
    assert [r["status"] for r in update_embeds(doc, DOC, BOTH)["results"]] == ["unsupported"] * 3
    fenced = f"```markdown\n<!-- MERMAID: {MMD} -->\n```\n\n~~~\n<!-- MERMAID: {MMD} -->\n~~~\n"
    assert update_embeds(fenced, DOC, BOTH) == {"markdown": fenced, "changed": False, "results": []}
    two = f"<!-- MERMAID: {MMD} -->\n\n<!-- MERMAID: other/x.mmd -->\n"
    out = update_embeds(two, DOC, BOTH, {MMD})
    assert [r["path"] for r in out["results"]] == [MMD]
    assert out["markdown"].count("/MERMAID") == 1
    crlf = update_embeds(f"# HLD\r\n<!-- MERMAID: {MMD} -->\r\nafter\r\n", DOC, BOTH)["markdown"]
    assert f"{EMBED_END_MARKER}\r\nafter\r\n" in crlf
    assert "\n" not in crlf.replace("\r\n", "")
    cases = update_embeds(f"<!-- mermaid: ./{MMD} -->\n<!--MERMAID:/{MMD}-->\n", DOC, BOTH)
    assert [(r["path"], r["status"]) for r in cases["results"]] == [(MMD, "filled"), (MMD, "filled")]


def test_fence_outgrows_backtick_runs_and_markers_nest() -> None:
    src = {MMD: {"kind": "mermaid", "text": 'flowchart LR\n  A["````"] --> B\n'}}
    out = update_embeds(f"<!-- MERMAID: {MMD} -->\n", DOC, src)
    assert "`````mermaid\n" in out["markdown"]
    assert update_embeds(out["markdown"], DOC, src)["changed"] is False
    markers = find_embed_markers(f"<!-- MERMAID: {MMD} -->\n<!-- MERMAID: {SVG} -->\n![x](y)\n{EMBED_END_MARKER}\n")
    assert [(m["index"], m["endIndex"]) for m in markers] == [(0, None), (1, 3)]


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        ("a/b.mmd", {"path": "a/b.mmd", "kind": "mermaid"}),
        ("./a/b.svg", {"path": "a/b.svg", "kind": "svg"}),
        ("/a/b.mmd", {"path": "a/b.mmd", "kind": "mermaid"}),
        ("a/../b.mmd", None),
        ("a//b.mmd", None),
        ("a\\b.mmd", None),
        ("a/b.canvas.mmd", None),
        ("a/b.md", None),
    ],
)
def test_normalise_embed_path(target: str, expected: dict[str, str] | None) -> None:
    assert normalise_embed_path(target) == expected


def test_javascript_regex_semantics() -> None:
    # JS /i folds ASCII only (no dotless i), JS \s has U+FEFF but not U+001C, trim() takes U+3000.
    assert update_embeds(f"<!-- MERMA\u0131D: {MMD} -->", DOC, BOTH)["results"] == []
    assert update_embeds(f"<!--\ufeffMERMAID:\u00a0{MMD}\u3000-->", DOC, BOTH)["results"][0]["status"] == "filled"
    assert update_embeds(f"<!--\x1cMERMAID: {MMD} -->", DOC, BOTH)["results"] == []
    assert update_embeds(f"\u3000<!-- MERMAID: {MMD} -->\u2028", DOC, BOTH)["results"][0]["status"] == "filled"


# --- fuzz against the TypeScript implementation ---------------------------------------------------------------

STATUSES = {"current", "updated", "filled", "missing", "unsupported"}
NAMES = ["ctx", "payments-context", "a.b", "é😀", "x[1]", "p%20q", "(a)'*!~", "naïve", "a#b", "日本"]
DIRS = ["", "architecture", "architecture/hld", "architecture/prod/diagrams", "docs", "日本/x", "a.b/c"]
SPACES = ["", " ", "  ", "\t", "\u00a0", "\ufeff", "\u3000", "\u2028", "\x1c", "\u200b", "\v"]
KEYWORDS = ["MERMAID", "mermaid", "MerMaid", "MERMA\u0131D", "MERMAID ", "MERMAIDX"]
TEXTS = [
    "flowchart LR\n  A --> B\n",
    "flowchart TD\r\n  A[x] --> B\r\n\r\n",
    'flowchart LR\n  A["````"] --> B',
    "sequenceDiagram\n  A->>B: hi `x` ``y``\n \t\u00a0\u3000",
    "graph TD\n  A[é😀 日本] --> B\u2028C\n\n",
    "x\ry\n<!-- /MERMAID -->\n```\n",
    "",
    "   \n\n",
    "flowchart LR\n  A --> B\ufeff\x1c",
]


def _path(rnd: random.Random) -> str:
    folder = rnd.choice(DIRS)
    return f"{folder}/{rnd.choice(NAMES)}" if folder else rnd.choice(NAMES)


def _target(rnd: random.Random, known: list[str]) -> str:
    base = rnd.choice(known) if known and rnd.random() < 0.7 else _path(rnd) + rnd.choice([".mmd", ".svg"])
    roll = rnd.random()
    if roll < 0.5:
        return base
    return rnd.choice(
        [
            f"./{base}",
            f"/{base}",
            f"//{base}",
            f"./.{base}",
            f"././{base}",
            f"../{base}",
            f"a/../{base}",
            f"a/./{base}",
            f"a//{base}",
            base.replace("/", "\\"),
            base[:-4] + ".canvas.mmd",
            base[:-4] + ".png",
            base + "-->",
            base[:-4] + ".MMD",
            "",
            f"{base} x",
        ]
    )


def _marker(rnd: random.Random, known: list[str]) -> str:
    sp = lambda: rnd.choice(SPACES)  # noqa: E731
    line = f"<!--{sp()}{rnd.choice(KEYWORDS) if rnd.random() < 0.3 else 'MERMAID'}:{sp()}{_target(rnd, known)}{sp()}-->"
    return sp() + line + sp() if rnd.random() < 0.3 else line


def _end(rnd: random.Random) -> str:
    return rnd.choice(
        [EMBED_END_MARKER] * 5 + ["<!--/MERMAID-->", "<!-- /mermaid -->", " <!-- /MERMAID -->\t", "<!-- / MERMAID -->"]
    )


def _line(rnd: random.Random, known: list[str]) -> list[str]:
    roll = rnd.random()
    if roll < 0.3:
        return [_marker(rnd, known)]
    if roll < 0.4:
        return [_end(rnd)]
    if roll < 0.5:
        fence = rnd.choice(["```", "~~~", "````", "``", " ```", "```mermaid", "~~~~ x"])
        body = [rnd.choice([_marker(rnd, known), _end(rnd), "text", "```", "~~~"]) for _ in range(rnd.randint(0, 3))]
        close = rnd.choice([fence.strip()[:3], fence.strip(), "`````", "~~~", "``` x", ""])
        return [fence, *body, close]
    if roll < 0.6:
        return ["```mermaid", rnd.choice(TEXTS).rstrip(), "```", "![x](./y.svg)"][: rnd.randint(1, 4)]
    return [rnd.choice(["", "text", "# Heading", "é😀 日本", "a\rb", "<!-- other -->", "`", "  ", "\u2028"])]


def _sources(rnd: random.Random, known: list[str]) -> dict[str, Any]:
    sources: dict[str, Any] = {}
    for path in known:
        roll = rnd.random()
        if roll < 0.15:
            continue
        kind = ("svg" if path.endswith(".svg") else "mermaid") if roll < 0.85 else rnd.choice(["svg", "mermaid", "x"])
        sources[path] = {"kind": kind, "text": rnd.choice(TEXTS)} if kind == "mermaid" else {"kind": kind}
        if roll > 0.97:
            sources[path] = None
    return sources


def _document(rnd: random.Random, known: list[str]) -> str:
    lines = [line for _ in range(rnd.randint(0, 14)) for line in _line(rnd, known)]
    text = "".join(line + rnd.choice(["\n", "\n", "\r\n"] if rnd.random() < 0.2 else ["\n"]) for line in lines)
    if rnd.random() < 0.3:
        text = text.replace("\n", "\r\n").replace("\r\r\n", "\r\n")
    return text[:-1] if text and rnd.random() < 0.3 else text


def _cases(seed: int, count: int) -> Iterator[tuple[str, str, dict[str, Any], set[str] | None, bool]]:
    rnd = random.Random(seed)
    for _ in range(count):
        known = [_path(rnd) + rnd.choice([".mmd", ".svg"]) for _ in range(rnd.randint(1, 4))]
        doc = _document(rnd, known)
        doc_path = _path(rnd) + ".md"
        refill = rnd.random() < 0.5
        only: set[str] | None = None
        if rnd.random() < 0.3:
            only = {p for p in known if rnd.random() < 0.5} | (
                {"../x.mmd", "nope.svg"} if rnd.random() < 0.3 else set()
            )
        yield doc, doc_path, _sources(rnd, known), only, refill
        if refill:
            # The same document after a fill, against changed sources: current, updated and missing sections.
            filled = update_embeds(doc, doc_path, _sources(rnd, known))["markdown"]
            yield filled, doc_path, _sources(rnd, known) if rnd.random() < 0.5 else {}, only, False


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


@pytest.mark.parametrize("seed", [1, 7, 42, 2026])
def test_native_embeds_match_the_bridge(bridge: DiagramBridge, seed: int) -> None:
    failures: list[str] = []
    seen: set[str] = set()
    compared = 0
    for doc, doc_path, sources, only, _ in _cases(seed, 300):
        mine = update_embeds(doc, doc_path, sources, only)
        theirs = bridge.embeds(doc, doc_path, sources, None if only is None else sorted(only))
        compared += 1
        seen.update(r["status"] for r in mine["results"])
        if mine != theirs:
            failures.append(
                json.dumps({"doc": doc, "docPath": doc_path, "sources": sources, "only": only and sorted(only)})
            )
    assert not failures, f"{len(failures)}/{compared} differ (seed {seed}); first:\n{failures[0]}"
    assert seen == STATUSES, f"statuses not reached: {STATUSES - seen}"
