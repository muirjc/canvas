"""Inputs for the byte-parity tests between the TypeScript and Python GitHub submission code
(tests/test_github_files.py). Each case is {"id", "fn", "args"}; the expected outputs, computed once by running
the TypeScript originals (apps/api/src/github/submission-files.ts, folder-path.ts), are in
tests/github_parity_expected.py. To add a case: add it here, regenerate the expected file with the TypeScript
runner (see the docstring of tests/github_parity_expected.py), and review the diff.

Why this matters: a diagram submitted from one service and resubmitted unchanged from the other is "up to
date" only if both build the same files, byte for byte.
"""

from __future__ import annotations

from typing import Any

Case = dict[str, Any]

EMOJI = "\U0001f600"  # two UTF-16 code units in JavaScript, one code point in Python
NBSP = "\u00a0"


def _case(case_id: str, fn: str, *args: Any) -> Case:
    return {"id": case_id, "fn": fn, "args": list(args)}


def _slugify() -> list[Case]:
    names = {
        "plain": "Order Flow",
        "markdown": "@everyone **x**",
        "accents": "Caf\u00e9 R\u00e9sum\u00e9",
        "more-accents": "na\u00efve fa\u00e7ade \u00c5\u00c4\u00d6 \u00f1",
        "decomposed": "Cafe\u0301 Re\u0301sume\u0301",
        "cjk": "\u65e5\u672c\u8a9e\u306e\u56f3",
        "blank": "   ",
        "dashes": "---",
        "long-100": "a" * 100,
        "long-words": "\u00dcn\u00efc\u00f6d\u00e9 " * 20,
        "emoji": f"emoji {EMOJI} flow",
        "emoji-only": EMOJI * 30,
        "ligature": "\ufb01ne \ufb02ow",
        "fullwidth": "\uff21\uff11\uff12\uff13 \uff54est",
        "roman": "\u2177 phase \u2160",
        "dotted-i": "\u0130stanbul",
        "sharp-s": "Stra\u00dfe",
        "trailing-dash-at-60": "x" * 59 + "-yyy",
        "dash-run-at-60": "x" * 55 + "-----zz",
        "symbols": "A_B.C/D\\E:F",
        "nbsp": f"a{NBSP}b",
        "superscript": "x\u00b2 + y\u00b3",
        "circled": "\u2460\u2461 steps",
        "angstrom": "\u212b ngstr\u00f6m",
        "turkish-dotless": "\u0131 \u0131\u0131",
        "greek": "\u0394\u03b5\u03bb\u03c4\u03b1 \u03a9mega",
        "mixed-case": "CamelCaseNAME v2.0",
        "empty": "",
    }
    return [_case(f"slugify/{key}", "slugify", name) for key, name in names.items()]


def _folders() -> list[Case]:
    folders = {
        "slashes": "/architecture//diagrams/",
        "backslashes": "architecture\\diagrams\\x",
        "spaces": "  docs/x  ",
        "nbsp": f"{NBSP}docs{NBSP}",
        "em-space": "\u2003docs",
        "bom": "\ufeffdocs",
        "mongolian-vowel-separator": "\u180edocs",
        "trailing-newline": "docs/x\n",
        "newline-inside": "a\n/b",
        "next-line": "docs/\u0085",
        "line-separator": "docs/x\u2028",
        "len-200": "x" * 200,
        "len-201": "x" * 201,
        "emoji-100": EMOJI * 100,
        "emoji-101": EMOJI * 101,
        "depth-10": "/".join(["a"] * 10),
        "depth-11": "/".join(["a"] * 11),
        "reserved-upper": "docs/.GIT",
        "reserved-github": ".Github/workflows",
        "reserved-canvas": ".CANVAS",
        "gitignore": "docs/.gitignore",
        "dot-segment": "a/./b",
        "dotdot": "a/../b",
        "unicode-letters": "r\u00e9sum\u00e9",
        "colon": "a:b",
        "leading-dot": ".hidden",
        "dash-start": "-x",
        "dot-inside": "a.b/c_d-e",
        "only-slashes": "//",
        "only-backslashes": "\\\\",
        "tab": "docs\t",
        "empty": "",
        "emoji-in-folder": f"a{EMOJI}b",
    }
    cases = [_case(f"normalize_folder/{key}", "normalize_folder", folder) for key, folder in folders.items()]
    paths = {
        "standard": ".canvas/standards/flowchart/v1.json",
        "validator": ".canvas/validator.mjs",
        "canvas-dotdot": ".canvas/../x",
        "canvas-reserved": ".canvas/.git/x",
        "plain": "a/b/order-flow.svg",
        "reserved": "a/.git/x",
        "len-320": "a/" + "x" * 318,
        "len-321": "a/" + "x" * 319,
        "emoji-160": EMOJI * 160,
        "emoji-161": EMOJI * 161,
        "canvas-long": ".canvas/" + "a" * 400,
        "empty-segment": "a//b",
        "trailing-slash": "a/b/",
        "canvas-bare": ".canvas",
        "canvas-trailing": ".canvas/",
        "depth-after-canvas": ".canvas/" + "/".join(["a"] * 10),
        "depth-after-canvas-11": ".canvas/" + "/".join(["a"] * 11),
    }
    cases += [_case(f"assert_safe_repo_path/{key}", "assert_safe_repo_path", path) for key, path in paths.items()]
    return cases


def _text() -> list[Case]:
    markdown = {
        "mention-bold": "@everyone **x**",
        "newlines": "a\r\nb\n\nc",
        "specials": "`code` _u_ [l](u) <b> # + ! | ~ \\ {x}",
        "email": "x@y.com @@",
        "tabs": "\t tabs \t",
        "emoji-mention": f"emoji {EMOJI} @here",
        "backslash": "back\\slash \\\\",
        "line-separator": "a\u2028b\u2029c",
        "nbsp": f"a{NBSP}b",
        "zero-width": "a\u200bb @",
        "dash-hyphen": "- a . b = c : d / e",
        "html-entity": "&amp; &lt;",
        "table": "| a | b |",
        "empty": "",
    }
    cases = [_case(f"escape_markdown/{key}", "escape_markdown", text) for key, text in markdown.items()]
    one_lines: dict[str, tuple[str, int]] = {
        "tabs-newlines": ("a\tb\r\nc  d", 120),
        "long-130": ("x" * 130, 120),
        "long-120": ("x" * 120, 120),
        "long-121": ("x" * 121, 120),
        "emoji-70-of-100": (EMOJI * 70, 100),
        "emoji-50-of-100": (EMOJI * 50, 100),
        "emoji-50-x-of-100": (EMOJI * 50 + "x", 100),
        "emoji-odd-offset": ("x" + EMOJI * 60, 100),
        "emoji-80": (EMOJI * 60, 80),
        "unicode-spaces": (f"a{NBSP}\u2003b\u3000c", 120),
        "mongolian": ("a\u180eb", 120),
        "bom": ("\ufeffbom", 120),
        "next-line": ("x\u0085y", 120),
        "padding": ("  lead trail  ", 10),
        "only-spaces": ("   \t  ", 120),
        "accents": ("\u00e9" * 90, 80),
        "line-separator": ("a\u2028b", 120),
        "vertical-tab": ("a\u000bb\u000cc", 120),
    }
    cases += [_case(f"one_line/{key}", "one_line", text, size) for key, (text, size) in one_lines.items()]
    fingerprints: dict[str, tuple[str, str, str | None]] = {
        "plain": ("flowchart TD\n  A-->B\n", "Order Flow", "A description"),
        "no-description": ("flowchart TD\n  A-->B\n", "Order Flow", None),
        "empty-description": ("x", "n", ""),
        "unicode": (f"flowchart TD\n  A[\u00e9 {EMOJI}]-->B\n", f"Caf\u00e9 {EMOJI}", "\u65e5\u672c"),
        "control": ("a\u0001b\u007fc\td\u2028e\u2029f", 'q"uote\\ back', "line\nbreak"),
        "lone-surrogate": ("x", "bad \ud83d name", None),
        "lone-low-surrogate": ("x\ude00", "n", "d"),
    }
    cases += [_case(f"fingerprint/{key}", "fingerprint", *args) for key, args in fingerprints.items()]
    # JSON numbers: the same structure Postgres JSONB (floats) and SQLite hand back.
    numbers = {
        "integer-valued-float": {"minCount": 2.0, "maxCount": 10.0},
        "fractions": {"a": 1.5, "b": 0.1, "c": -2.25, "d": 100.125},
        "negative-zero": {"z": -0.0},
        "tiny": {"a": 0.00001, "b": 1e-7, "c": 0.000001, "d": 1.5e-9},
        "huge": {"a": 1e21, "b": 1.5e300, "c": 123456789012345680000.0, "d": 1e20},
        "nested": {"x": [1.0, [2.0, {"y": 3.0}]], "z": None, "t": True, "f": False},
        "long-fraction": {"a": 0.30000000000000004, "b": 1 / 3, "c": 5e-324},
        "big-integers": {"a": 9007199254740993, "b": 12345678901234567890, "c": 9007199254740992},
        "integer-keys": {"b": 1, "10": 2, "2": 3, "a": 4, "01": 5, "1": 6},
        "empty-containers": {"a": [], "b": {}, "c": [[], {}]},
        "string-escapes": {"q": 'a"b\\c', "n": "l1\nl2\tx\r", "c": "\u0001\u001f\u007f\u2028", "e": "\U0001f600"},
    }
    cases += [_case(f"stringify/{key}", "stringify", value, 2) for key, value in numbers.items()]
    cases += [_case("stringify/compact", "stringify", numbers["nested"], None)]
    return cases


FRONT = "---\ncanvas:\n  positions:\n    A:\n      x: 40\n      y: 40\n---\n"
PORTABLE = "flowchart TD\n  A[Receive order] --> B[Ship order]\n"


def _input(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "diagramId": "0b03c3a4-6b36-49cd-b14b-ccdab63e1470",
        "name": "Order Flow",
        "description": None,
        "diagramTypeId": "flowchart",
        "diagramTypeName": "Generic Flowchart",
        "dslFamily": "flowchart",
        "dslContent": FRONT + PORTABLE,
        "portableMermaid": PORTABLE,
        "svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#ffffff" /></svg>\n',
        "versionSequence": 3,
        "standard": None,
        "path": "architecture/order-flow",
        "slug": "order-flow",
        "canvasUrl": "http://canvas.test/?diagramId=0b03c3a4-6b36-49cd-b14b-ccdab63e1470",
        "validator": None,
    }
    base.update(overrides)
    return base


def _standard(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "7f1e2d3c-0000-4000-8000-000000000001",
        "version": 2,
        "name": "Order process rules",
        "description": "Steps for order flows.",
        "rules": {
            "requireKnownKinds": True,
            "elementKinds": [
                {"id": "step", "label": "Step", "shapes": ["rectangle"], "approvedFills": [], "minCount": 2.0},
                {"id": "decision", "label": "D\u00e9cision", "shapes": ["diamond"], "maxCount": 10.0, "weight": 0.5},
            ],
            "severityOverrides": {"kind-min-count": "error"},
            "ratio": 2.0,
            "threshold": 0.00001,
        },
    }
    base.update(overrides)
    return base


def _files() -> list[Case]:
    hostile_name = f"\u00dcn\u00ef {EMOJI} `x` **b** @here [l](http://x) <script>alert(1)</script> | _u_ ~s~"
    long_description = ("Paragraph with *emphasis* and [a link](x).\n\n" + "word " * 40 + EMOJI) * 3
    inputs: dict[str, dict[str, Any]] = {
        "typical": _input(standard=_standard()),
        "no-standard": _input(),
        "standard-nulls": _input(standard=_standard(name=None, description=None, rules=None)),
        "standard-empty-rules": _input(standard=_standard(rules={})),
        "validator": _input(validator="// validator v1\nexport {};\n"),
        "empty-validator": _input(validator=""),
        "description-markdown": _input(description="  A *bold* claim [x](y)\n@mention\n  ", standard=_standard()),
        "description-whitespace": _input(description=f"  {NBSP}\u2003\n ", standard=_standard()),
        "description-long": _input(description=long_description),
        "hostile-name": _input(name=hostile_name, diagramTypeName="Type `with` *marks* @all"),
        "emoji-name": _input(name=EMOJI * 40, slug="diagram", path="docs/diagram"),
        "fence-triple": _input(portableMermaid="flowchart TD\n  A[```x```] --> B\n"),
        "fence-quad": _input(portableMermaid="x\n````\nfence\n```\n"),
        "fence-single": _input(portableMermaid="A[`code`] --> B[` `]"),
        "trailing-space": _input(portableMermaid="flowchart TD\n  A --> B\n\n  \n"),
        "trailing-unicode-space": _input(portableMermaid=f"flowchart TD\n  A --> B{NBSP}\u2003\ufeff\n"),
        "empty-mermaid": _input(portableMermaid=""),
        "canvas-url-special": _input(canvasUrl="http://canvas.test/?diagramId=x&a=b#frag (1)"),
        "deep-path": _input(path="a/b/c/d/e/f/g/h/i/order-flow"),
        "version-large": _input(versionSequence=1234567),
        "crlf-source": _input(dslContent="---\r\ncanvas: {}\r\n---\r\nflowchart TD\r\n  A --> B\r\n"),
    }
    cases = [_case(f"files/{key}", "files", value) for key, value in inputs.items()]
    cases.append(_case("files/unsafe-slug", "files", _input(slug="../evil")))
    cases.append(_case("files/unsafe-path", "files", _input(path="docs/.git/x")))
    cases.append(_case("files/unsafe-type", "files", _input(diagramTypeId="a/../b", standard=_standard())))
    return cases


def _titles_and_commits() -> list[Case]:
    names = {
        "plain": "Order Flow",
        "len-100": "a" * 100,
        "len-101": "a" * 101,
        "emoji-60": EMOJI * 60,
        "emoji-50": EMOJI * 50,
        "emoji-odd": "x" + EMOJI * 50,
        "whitespace": f"a\t\nb{NBSP}{NBSP}c\u2003d",
        "markdown": "@everyone **x** `y`",
        "blank": "   ",
    }
    cases = [_case(f"pr_title/{key}", "pr_title", name, 7) for key, name in names.items()]
    commit_names = {**names, "len-80": "b" * 80, "len-81": "b" * 81, "emoji-41": EMOJI * 41, "emoji-40": EMOJI * 40}
    cases += [
        _case(
            f"commit/{key}/{flag}",
            "commit",
            name,
            4,
            "http://canvas.test/?diagramId=abc",
            "Olivia Owner",
            "o@x.test",
            flag,
        )
        for key, name in commit_names.items()
        for flag in (False, True)
    ]
    authors = {
        "brackets": ("Olivia <Owner>", "owner@example.com"),
        "only-brackets": ("<>", "owner@example.com"),
        "blank": ("   ", "owner@example.com"),
        "empty": ("", "owner@example.com"),
        "email-spaces": ("Olivia", " o w@n\ter<>@example.com\n"),
        "email-unicode-space": ("Olivia", f"o{NBSP}w\u2003n@x.test\ufeff"),
        "long-name": ("x" * 200, "a@b.test"),
        "emoji-name": (EMOJI * 60, "a@b.test"),
        "emoji-name-odd": ("y" + EMOJI * 60, "a@b.test"),
        "newline-name": ("Eve\nSecond <Line>", "a@b.test"),
        "mention-name": ("@octocat", "a@b.test"),
        "tab-name": ("a\tb", "a@b.test"),
    }
    cases += [
        _case(f"commit_author/{key}", "commit", "Order Flow", 4, "http://canvas.test/", name, email, False)
        for key, (name, email) in authors.items()
    ]
    return cases


def _warning(severity: str, message: str) -> dict[str, str]:
    return {"severity": severity, "message": message}


def _bodies() -> list[Case]:
    few = [
        _warning("error", "Step `x` needs a **label**"),
        _warning("warning", "multi\nline @octocat message"),
        _warning("info", "plain"),
        _warning("hint", "unknown severity"),
    ]
    sixty = [_warning("warning", f"Finding {i} [x](y)") for i in range(60)]
    documents = [
        "docs/hld.md",
        "docs/My Design (v2).md",
        "docs/r\u00e9sum\u00e9 [draft].md",
        "docs/100% #1 ?.md",
        f"docs/{EMOJI}.md",
        "docs/a&b=c;d,e+f$g@h.md",
        "docs/`tick`*star*_under_.md",
    ]
    many_docs = [f"docs/doc-{i:03d}.md" for i in range(55)]
    cases = [
        _case("body/plain", "pr_body", _input(), [], "Olivia <Owner>", []),
        _case("body/standard", "pr_body", _input(standard=_standard()), [], "olivia", []),
        _case("body/standard-null-name", "pr_body", _input(standard=_standard(name=None)), [], "olivia", []),
        _case("body/few-warnings", "pr_body", _input(standard=_standard()), few, "olivia", []),
        _case("body/sixty-warnings", "pr_body", _input(), sixty, "olivia", []),
        _case("body/documents", "pr_body", _input(), [], "olivia", documents),
        _case("body/many-documents", "pr_body", _input(), [], "olivia", many_docs),
        _case("body/warnings-and-documents", "pr_body", _input(), few, "olivia", documents),
        _case(
            "body/hostile",
            "pr_body",
            _input(
                name=f"@all **b** {EMOJI}",
                diagramTypeName="`t`",
                path="docs/my folder/\u00e9",
                canvasUrl="http://x/?a=b c",
            ),
            [],
            "Eve @octocat\nsecond",
            [],
        ),
        _case("body/path-encoding", "pr_body", _input(path="docs/a b/\u00e9#?%"), [], "olivia", []),
    ]
    # Over 60,000 characters: truncated at the same code unit, before the marker. Messages of emoji (two UTF-16
    # units each) and an odd/even first message put the cut inside, and outside, a surrogate pair.
    for parity, extra in (("even", ""), ("odd", "x")):
        huge = [_warning("warning", extra + EMOJI * 900 if i == 0 else EMOJI * 900) for i in range(50)]
        cases.append(_case(f"body/truncated-emoji-{parity}", "pr_body", _input(), huge, "olivia", []))
    for pad in range(4):
        long_name = "n" * (30_000 + pad)
        cases.append(
            _case(f"body/truncated-name-{pad}", "pr_body", _input(name=long_name + EMOJI * 40_000), [], "olivia", [])
        )
    cases.append(_case("body/exactly-near-limit", "pr_body", _input(name="a" * 59_700), [], "olivia", []))
    cases.append(_case("body/long-ascii", "pr_body", _input(name="a" * 70_000), [], "olivia", []))
    return cases


def all_cases() -> list[Case]:
    cases = _slugify() + _folders() + _text() + _files() + _titles_and_commits() + _bodies()
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    return cases
