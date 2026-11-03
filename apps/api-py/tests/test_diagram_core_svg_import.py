"""canvas-1bty.15.6: the native SVG clean-up (uploaded files, manifest artwork, bundled packs), the library loader
and icon references.

These are security filters, so besides the TypeScript contract cases (svg-import.test.ts, svg-sanitizer.test.ts,
library-loading.test.ts) a seeded fuzz feeds hostile and random markup to the native Python code and to the
TypeScript code through the bridge; every answer must be identical. Needs Node and the bridge bundle (skips
without, like the other bridge tests).
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import json
import random
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from canvas_api.diagram_core import DiagramBridge, DiagramCore
from canvas_api.diagram_core.libraries import load_library
from canvas_api.diagram_core.svg_import import (
    SvgImportError,
    prepare_uploaded_svg,
    sanitize_icon_markup_strict,
    sanitize_svg_fragment,
)

CORPUS = Path(__file__).resolve().parents[3] / "packages" / "diagram-core" / "corpus" / "cases"
native = DiagramCore(None, mode="native")

# --- the TypeScript contract cases ----------------------------------------------------------------------------


def test_fits_the_viewbox_or_width_and_height() -> None:
    out = prepare_uploaded_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', "icon"
    )
    assert out == (
        '<svg x="0" y="0" width="48" height="48" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet"'
        ' overflow="hidden"><path d="M0 0h24v24H0z"/></svg>'
    )
    out = prepare_uploaded_svg('<svg width="200px" height="100"><rect width="200" height="100"/></svg>', "i")
    assert 'viewBox="0 0 200 100"' in out
    # JavaScript's Number(): hex and exponents are numbers, and are written back as JavaScript writes them.
    assert 'viewBox="0 16 100 2.5"' in prepare_uploaded_svg('<svg viewBox="-0,0x10 1e2 2.50"></svg>', "i")


@pytest.mark.parametrize(
    ("svg", "message"),
    [
        ("hello", "This isn't an SVG file."),
        ('<svg><path d="M0 0"/></svg>', "no usable size"),
        (f'<svg viewBox="0 0 10 10"><path d="{"M0 0 " * 50_000}"/></svg>', "too large (over 200 KB)"),
        ('<!DOCTYPE svg [<!ENTITY x "boom">]><svg viewBox="0 0 1 1">&x;</svg>', "XML entities"),
        ('<svg viewBox="0 0 0 10"><path d="M0 0"/></svg>', "no usable size"),
        ('<svg viewBox="0 0 10 10"><path d="M0 0"/>', "no closing </svg>"),
        ('<svg viewBox="0 0 10 10"><style>.a{fill:red}</style></svg>', "<style> block"),
    ],
)
def test_refuses(svg: str, message: str) -> None:
    with pytest.raises(SvgImportError, match=None) as caught:
        prepare_uploaded_svg(svg, "icon")
    assert message in str(caught.value)


def test_removes_unsafe_elements_and_attributes_and_prefixes_ids() -> None:
    out = prepare_uploaded_svg(
        '<svg viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div>x</div></foreignObject>'
        '<image href="https://evil.test/x.png"/><a href="https://evil.test"><rect width="1" height="1"/></a>'
        '<animate attributeName="href" to="javascript:alert(1)"/><iframe src="x"></iframe>'
        '<rect onclick="alert(1)" fill="url(https://evil.test/p.svg#g)" style="fill:url(http://evil.test/x);stroke:red"'
        ' xml:base="https://evil.test/" width="10" height="10"/><use xlink:href="javascript:alert(1)"/></svg>',
        "icon",
    )
    for bad in ("script", "alert", "foreignObject", "<image", "evil.test", "<a ", "animate", "iframe", "xml:base"):
        assert bad not in out
    assert '<rect style="stroke:red" width="10" height="10"/>' in out
    assert sanitize_icon_markup_strict(
        '<g><script>x</script><path id="p" d="M0 0" onclick="x()"/><use href="#p"/></g>', "lib-icon"
    ) == ('<g><path id="lib-icon-p" d="M0 0"/><use href="#lib-icon-p"/></g>')
    # The prefix is made id-safe per UTF-16 unit, as in JavaScript: an emoji is two units, so two dashes.
    assert sanitize_icon_markup_strict('<g id="x"/>', "a b🚀") == '<g id="a-b---x"/>'


def test_sanitize_svg_fragment() -> None:
    assert sanitize_svg_fragment("<g><rect/><script>alert(1)</script></g>") == "<g><rect/></g>"
    assert sanitize_svg_fragment('<rect onload="alert(1)" onclick=\'evil()\' width="10" />') == '<rect width="10" />'
    assert sanitize_svg_fragment('<a href="javascript:alert(1)"><rect/></a>') == '<a href="#"><rect/></a>'
    assert sanitize_svg_fragment("icons/azure/blob-storage.svg") == "icons/azure/blob-storage.svg"


def test_load_library() -> None:
    icon = {"id": "evil", "displayName": "Evil", "keywords": [], "category": "T", "assetRef": '<rect onload="x()"/>'}
    loaded = load_library({"id": "lib", "version": "1", "icons": [icon]})
    assert loaded == {
        "ok": True,
        "library": {
            "id": "lib",
            "version": "1",
            "icons": [{**icon, "assetRef": "<rect/>", "libraryId": "lib", "libraryVersion": "1"}],
        },
    }
    assert load_library({"id": "lib", "icons": []}) == {
        "ok": False,
        "error": "Library manifest requires both id and version",
    }
    assert load_library({"id": "lib", "version": 2, "icons": [icon, icon]}) == {
        "ok": False,
        "error": 'Duplicate icon id "evil" in library lib@2',
    }


def test_icon_refs() -> None:
    dsl = (
        "---\ncanvas:\n  icons:\n    a:\n      libraryId: azure-icons\n      libraryVersion: '2024.1'\n"
        "      iconId: storage-accounts\n---\narchitecture-beta\n    service a(disk)[A]\n    service b(server)[B]\n"
    )
    refs = native.icon_refs(
        [{"family": "architecture", "dsl": dsl}, {"family": "flowchart", "dsl": "nope"}, {"family": "x", "dsl": ""}]
    )
    assert refs == [
        [
            {"libraryId": "azure-icons", "libraryVersion": "2024.1", "iconId": "storage-accounts"},
            {"libraryId": "mermaid-architecture", "libraryVersion": "1.0.0", "iconId": "server"},
        ],
        None,
        None,
    ]


# --- fuzz against the bridge ----------------------------------------------------------------------------------

TAGS = [
    "g",
    "path",
    "rect",
    "circle",
    "use",
    "defs",
    "linearGradient",
    "LinearGradient",
    "stop",
    "clipPath",
    "mask",
    "text",
    "tspan",
    "title",
    "symbol",
    "SVG",
    "svg",
    "script",
    "SCRIPT",
    "foreignObject",
    "a",
    "image",
    "iframe",
    "animate",
    "set",
    "style",
    "div",
    "\u017fcript",
    "\u017ftyle",
    "linearGradient\u212a",
    "x:y",
    "s.c-r",
    "unknown",
]
ATTR_NAMES = [
    "id",
    "ID",
    "d",
    "fill",
    "stroke",
    "style",
    "STYLE",
    "href",
    "HREF",
    "xlink:href",
    "XLink:Href",
    "onclick",
    "ONLOAD",
    "onx",
    "xml:base",
    "clip-path",
    "mask",
    "transform",
    "class",
    "src",
    "to",
    "values",
    "x",
    "on",
    "data-x",
    "İd",
    "\uff4fnload",
]
VALUES = [
    "",
    "1",
    "#g",
    "#",
    "g",
    "url(#g)",
    "URL( #g )",
    "url('#g')",
    'url("#g")',
    "url(&quot;#c&quot;)",
    "url(#a) url(#b)",
    "url(http://evil.test/x#g)",
    "url( evil )",
    "javascript:alert(1)",
    "JaVaScRiPt:x",
    "java\nscript:x",
    "data:image/png;base64,AA",
    "DATA:x",
    "fill:red",
    "fill:url(#g);stroke:blue",
    "fill:url(http://e/x);stroke:red",
    "expression(alert(1))",
    "java\u017fcript:x",
    "\u017ftyle",
    "data\u212a:x",
    "behavior\u017f:x",
    "EXPRESSION (x)",
    "@import 'x'",
    "behavior: url(x.htc)",
    "behavior:x",
    ";;",
    " ; a ; ",
    "a<b",
    'a"b',
    "a'b",
    "&amp;",
    "&quot;",
    "émoji 🚀",
    "\u00a0",
    "\ufeff",
    "x\u2028y",
    "M0 0h24v24H0z",
    "0 0 24 24",
]
SPACES = [" ", "  ", "\n", "\t", "\u00a0", "\ufeff", "\u2028", "\u3000", "\u001c", "\r\n"]


def _attr(rnd: random.Random) -> str:
    name = rnd.choice(ATTR_NAMES)
    roll = rnd.random()
    value = rnd.choice(VALUES)
    if roll < 0.1:
        return name  # no value
    eq = rnd.choice(["=", " = ", "=\u00a0", "\n=\n"])
    if roll < 0.55:
        return f'{name}{eq}"{value.replace(chr(34), "")}"'
    if roll < 0.85:
        return f"{name}{eq}'{value.replace(chr(39), '')}'"
    return f"{name}{eq}{''.join(c for c in value if not c.isspace() and c not in '>') or 'v'}"


def _markup(rnd: random.Random, depth: int = 0) -> str:
    parts: list[str] = []
    for _ in range(rnd.randint(0, 5 if depth < 3 else 1)):
        roll = rnd.random()
        if roll < 0.45:
            tag = rnd.choice(TAGS)
            attrs = "".join(rnd.choice(SPACES) + _attr(rnd) for _ in range(rnd.randint(0, 4)))
            end = rnd.choice(["", " ", "\n", "\u00a0"])
            if rnd.random() < 0.35:
                parts.append(f"<{tag}{attrs}{end}/>")
            else:
                inner = _markup(rnd, depth + 1)
                close = tag if rnd.random() < 0.9 else rnd.choice(TAGS)
                parts.append(f"<{tag}{attrs}{end}>{inner}" + (f"</{close}>" if rnd.random() < 0.92 else ""))
        elif roll < 0.6:
            parts.append(rnd.choice(["text", "a < b", "1 > 0", "&amp;", "🚀", "x\u2028y", " ", "<", "</", "< g>"]))
        elif roll < 0.68:
            parts.append(rnd.choice(["<!-- c -->", "<!-- <script>x</script> -->", "<!--", "-->", "<!---->"]))
        elif roll < 0.74:
            parts.append(rnd.choice(["<![CDATA[<script>x</script>]]>", "<![CDATA[", "]]>"]))
        elif roll < 0.8:
            parts.append(
                rnd.choice(
                    [
                        "<script>alert(1)</script>",
                        "<SCRIPT src=x></SCRIPT>",
                        "<script/>",
                        "<\u017fcript>x</\u017fcript>",
                        "<\u017ftyle>x</\u017ftyle>",
                    ]
                )
            )
        elif roll < 0.86:
            parts.append(
                rnd.choice(['<foreignObject><body onload="x()">hi</body></foreignObject>', "<style>*{}</style>"])
            )
        else:
            parts.append(
                rnd.choice(['<g onload="a(\'b\\"c\')"/>', "<rect onclick='x' on=\"y\"/>", '<a href="javascript:x">'])
            )
    return "".join(parts)


def random_svg_file(rnd: random.Random) -> str:
    prolog = rnd.choice(
        [
            "",
            '<?xml version="1.0"?>\n',
            "<!-- tool -->\n",
            '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n',
            "<!DOCTYPE svg [<!ELEMENT x ANY>]>",
            "<!DOCTYPE svg [<!ENTITY x 'y'>]>",
            "  \u00a0",
            "\ufeff",
        ]
    )
    size = rnd.choice(
        [
            'viewBox="0 0 24 24"',
            'viewBox="0,0,24,24"',
            "viewBox='-1 -1 2.5 2'",
            'viewBox="0 0 0 10"',
            'viewBox="0 0 24"',
            'viewBox="0x0 1e1 24 .5"',
            'viewBox=" 0 0 24 24 "',
            'viewBox=",0 0 24 24"',
            'viewBox="0 0 Infinity 2"',
            'viewBox="0 0 1_0 2"',
            'VIEWBOX="0 0 9 9"',
            'width="20px" height="10"',
            'width="20 px" height="10"',
            'width="2.5" height="1."',
            "",
            'width="10"',
        ]
    )
    attrs = " ".join(x for x in [size, rnd.choice(["", 'xmlns="http://www.w3.org/2000/svg"', 'id="root"'])] if x)
    open_tag = rnd.choice([f"<svg {attrs}>", f"<SVG {attrs}>", f"<svg\n{attrs}>", f"<svg {attrs}/>", f"<svgx {attrs}>"])
    close = rnd.choice(["</svg>", "</svg >", "</SVG>\n  ", "", "</svg>trailing"])
    return prolog + open_tag + _markup(rnd) + close


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


def _differences(mine: list[Any], theirs: list[Any], inputs: list[Any]) -> list[str]:
    return [
        f"input={json.dumps(i)}\nmine={m}\ntheirs={t}" for i, m, t in zip(inputs, mine, theirs, strict=True) if m != t
    ]


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_native_svg_clean_up_matches_the_bridge(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    prefixes = ["icon", "lib-a b", "x🚀y", "", "é-1_2"]
    files = [{"svg": random_svg_file(rnd), "idPrefix": rnd.choice(prefixes)} for _ in range(400)]
    fragments = [{"svg": _markup(rnd), "idPrefix": rnd.choice(prefixes)} for _ in range(400)]
    prepared = native.svg_prepare(files)
    strict = native.svg_sanitize_strict(fragments)
    failures = _differences(prepared, bridge.svg_prepare(files), files)
    failures += _differences(strict, bridge.svg_sanitize_strict(fragments), fragments)
    assert not failures, f"{len(failures)} differ; first:\n" + "\n\n".join(failures[:2])
    # Both outcomes stay reachable, so the fuzz can't quietly stop testing one.
    assert sum(r["ok"] for r in prepared) >= 60
    assert sum(not r["ok"] for r in prepared) >= 60
    assert sum(r["ok"] for r in strict) >= 200


@pytest.mark.parametrize("seed", [5, 6])
def test_native_load_library_matches_the_bridge(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    failures = []
    for index in range(150):
        icons = [
            {
                "id": rnd.choice(["a", "b", "c", "d", "e", 1, 1.0, "1"]),
                "displayName": "Icon",
                "keywords": ["k"],
                "category": "C",
                "assetRef": rnd.choice(
                    [_markup(rnd), "icons/x.svg", " \u00a0" + _markup(rnd), "\u001c" + _markup(rnd), "shape:rectangle"]
                ),
                **({"extra": True} if rnd.random() < 0.2 else {}),
            }
            for _ in range(rnd.randint(0, 4))
        ]
        manifest: dict[str, Any] = {
            "id": rnd.choice(["lib", "", 0, 7]),
            "version": rnd.choice(["1", "", 2]),
            "icons": icons,
        }
        if rnd.random() < 0.4:
            manifest["license"] = rnd.choice(["MIT", None, ""])
        mine, theirs = native.load_library(manifest), bridge.load_library(manifest)
        if mine != theirs:
            failures.append(f"seed={seed} index={index}\n{json.dumps(manifest)}\nmine={mine}\ntheirs={theirs}")
    assert not failures, "\n\n".join(failures[:2])


def test_native_icon_refs_match_the_bridge_on_the_corpus(bridge: DiagramBridge) -> None:
    diagrams = []
    for case in sorted(CORPUS.iterdir()):
        family_file = case / "expected" / "family.txt"
        family = family_file.read_text("utf-8").strip() if family_file.exists() else "flowchart"
        diagrams.append({"family": family, "dsl": (case / "input.mmd").read_text("utf-8")})
    diagrams.append({"family": "unknown", "dsl": "flowchart TD\n  a --> b\n"})
    assert native.icon_refs(diagrams) == bridge.icon_refs(diagrams)
    assert any(refs for refs in native.icon_refs(diagrams))
