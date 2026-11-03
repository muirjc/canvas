"""canvas-1bty.15.5: the native template compilers (a filled-in docs/*-template.md to DSL).

- Each doc's own worked example compiles to the DSL the doc shows (no bridge needed).
- Seeded fuzz: random fillings of every doc, for every diagram type with a template, compiled by the native
  Python compilers and by the TypeScript ones through the bridge; the answers must be identical, errors and their
  order included. Needs Node and the bridge bundle (skips without, like the other bridge tests).

The fuzz builds documents from each doc's own sections and columns, with cell values drawn from the doc's
examples, the options it lists, and awkward text (quotes, brackets, unicode, JavaScript whitespace, names that
are Object.prototype members), so it follows the docs as they change.
"""

# ruff: noqa: S311 - a seeded generator, not cryptography
from __future__ import annotations

import random
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from canvas_api.diagram_core import DiagramBridge, DiagramCore
from canvas_api.diagram_core.templates import TEMPLATE_COMPILERS, compile_template
from canvas_api.diagram_core.templates.helpers import camel_slug, find_section
from canvas_api.diagram_core.templates.markdown_table import extract_first_table, split_into_sections

DOCS = Path(__file__).resolve().parents[3] / "docs"
DOC_FOR_TYPE = {
    "c4-context": "c4-context-template.md",
    "c4-container": "c4-levels-template.md",
    "c4-component": "c4-levels-template.md",
    "c4-deployment": "c4-levels-template.md",
    "sequence": "sequence-template.md",
    "erd": "erd-template.md",
    "uml": "uml-class-template.md",
    "network": "architecture-template.md",
    "deployment": "architecture-template.md",
    "cloud-infrastructure": "architecture-template.md",
}
"""The diagram type the doc's own worked example is written for comes first among a doc's types."""
EXAMPLE_TYPE = {
    "c4-context-template.md": "c4-context",
    "c4-levels-template.md": "c4-container",
    "sequence-template.md": "sequence",
    "erd-template.md": "erd",
    "uml-class-template.md": "uml",
    "architecture-template.md": "network",
}


# The C4 Context doc's example is prose and shortened columns, not a fillable form, so the tests use this one
# (the same system, with the form's own columns, a boundary and styling), keyed by section heading prefix.
C4_CONTEXT_EXAMPLE = {
    "1.": [
        ["Diagram title", ""],
        ["Central system name", "OrderService"],
        ["Central system description (one line)", "Handles order creation and fulfillment"],
    ],
    "2.": [["Partners", "Enterprise", "Payment Gateway, Warehouse"]],
    "3.": [
        ["Customer", "Person", "Internal", "Places and tracks orders", ""],
        ["Payment Gateway", "System", "External", "Processes credit card payments", ""],
        ["Warehouse", "SystemDb", "External", "Stock levels", ""],
    ],
    "4.": [
        ["Customer", "OrderService", "Places orders using", "HTTPS"],
        ["OrderService", "Payment Gateway", "Sends payment requests to", "HTTPS/JSON"],
        ["OrderService", "Warehouse", "Reserves stock in", ""],
    ],
    "5.": [["Customer", "#08427b", "", "#073b6f"]],
}


@dataclass
class FormSection:
    heading: str
    headers: list[str]
    placeholder: list[list[str]]


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().removeprefix("|").removesuffix("|").split("|")]


def _is_separator(line: str) -> bool:
    return re.fullmatch(r"\|(\s*:?-+:?\s*\|)+\s*", line) is not None


def _tables(text: str) -> list[list[list[str]]]:
    """Every pipe table in `text`, as rows of cells, header row first (separator dropped)."""
    tables: list[list[list[str]]] = []
    current: list[list[str]] | None = None
    for line in text.split("\n"):
        if not line.startswith("|"):
            current = None
            continue
        if _is_separator(line):
            continue
        if current is None:
            current = []
            tables.append(current)
        current.append(_cells(line))
    return tables


def _form(doc: str) -> tuple[str, list[FormSection]]:
    """The doc's title and its form sections (before the mapping reference), each with its table's columns."""
    form = doc[: doc.index("## Mapping reference")]
    title = form.split("\n", 1)[0]
    sections = []
    for chunk in re.split(r"(?m)^(?=## )", form)[1:]:
        heading = chunk.split("\n", 1)[0].removeprefix("## ")
        tables = _tables(chunk)
        if tables:
            sections.append(FormSection(heading, tables[0][0], tables[0][1:]))
    return title, sections


def _example(doc: str) -> tuple[list[list[list[str]]], str]:
    """The example's tables and its expected DSL (the doc's last fenced block)."""
    example = doc[doc.index("## Example") :]
    blocks = re.findall(r"```\n(.*?)```", doc, re.DOTALL)
    return _tables(example), blocks[-1]


def _document(title: str, sections: list[tuple[str, list[str], list[list[str]]]], newline: str = "\n") -> str:
    parts = [title, ""]
    for heading, headers, rows in sections:
        parts += [f"## {heading}", "", "| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
        parts += ["| " + " | ".join(row) + " |" for row in rows]
        parts.append("")
    return newline.join(parts)


def _lines(dsl: str) -> list[str]:
    return [line.strip() for line in dsl.split("\n") if line.strip()]


DOC_NAMES = sorted(set(DOC_FOR_TYPE.values()))


def test_every_typescript_template_type_is_registered() -> None:
    assert set(TEMPLATE_COMPILERS) == set(DOC_FOR_TYPE)
    assert compile_template("flowchart", "# x") == {"unsupported": True}
    # Object.prototype member names are not diagram types (TypeScript checks own keys only too).
    assert compile_template("constructor", "# x") == {"unsupported": True}


@pytest.mark.parametrize("doc_name", [n for n in DOC_NAMES if n != "c4-context-template.md"])
def test_the_docs_worked_example_compiles_to_the_dsl_it_shows(doc_name: str) -> None:
    doc = (DOCS / doc_name).read_text("utf-8")
    title, form = _form(doc)
    tables, expected = _example(doc)
    filled = []
    for section in form:
        rows = next((t[1:] for t in tables if t[0] == section.headers), section.placeholder)
        filled.append((section.heading, section.headers, rows))
    result = compile_template(EXAMPLE_TYPE[doc_name], _document(title, filled))
    assert "dsl" in result, result
    assert _lines(result["dsl"]) == _lines(expected)


def test_the_c4_context_example() -> None:
    doc = (DOCS / "c4-context-template.md").read_text("utf-8")
    title, _, filled = _example_sections(doc)
    result = compile_template("c4-context", _document(title, filled))
    assert result == {
        "dsl": "\n".join(
            [
                "C4Context",
                "    title System Context diagram: OrderService",
                "",
                '    System(orderService, "OrderService", "Handles order creation and fulfillment")',
                '    Person(customer, "Customer", "Places and tracks orders")',
                '    Enterprise_Boundary(partners, "Partners") {',
                '        System_Ext(paymentGateway, "Payment Gateway", "Processes credit card payments")',
                '        SystemDb_Ext(warehouse, "Warehouse", "Stock levels")',
                "    }",
                "",
                '    Rel(customer, orderService, "Places orders using", "HTTPS")',
                '    Rel(orderService, paymentGateway, "Sends payment requests to", "HTTPS/JSON")',
                '    Rel(orderService, warehouse, "Reserves stock in")',
                "",
                '    UpdateElementStyle(customer, $bgColor="#08427b", $borderColor="#073b6f")',
            ]
        )
    }


def test_shared_helpers() -> None:
    assert camel_slug("Payment Gateway") == "paymentGateway"
    assert camel_slug("API Gateway") == "apiGateway"
    assert camel_slug("--") == "entity"
    sections = split_into_sections("intro\n# T\n## 3. Services\nx\n### sub\ny\n## 4. Next\r\nz")
    assert [(s.heading, s.level) for s in sections] == [("T", 1), ("3. Services", 2), ("sub", 3), ("4. Next", 2)]
    assert sections[1].body == "x\n### sub\ny"
    services = find_section(sections, "services")
    assert services is not None
    assert services.heading == "3. Services"
    assert extract_first_table("| a | b |\n|:-|-:|\n| 1 |\n|  |  |\n| 2 | 3 | 4 |\ntext\n| 5 | 6 |") == [
        {"a": "1", "b": ""},
        {"a": "2", "b": "3"},
    ]


# --- fuzz against the bridge ---------------------------------------------------------------------------------

AWKWARD = [
    "",
    " ",
    'He said "hi"',
    "[bracketed]",
    "Ünïcødé ✓",
    "emoji 🚀",
    "\u00a0padded\u00a0",
    "﻿bom",
    "a, b, , c",
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "x",
    "X",
    "1",
    "0",
    "yes",
    "NO",
    "Y",
    "true",
    "maybe",
    "left",
    "B",
    "sideways",
    "constructor:thing",
    "azure:storage-accounts",
    "azure:not-an-icon",
    "AZURE:storage-accounts",
    "aws:lambda",
    "logos:kubernetes",
    "bad icon!",
    "Database",
    "SERVER",
    "1..*",
    "0..1",
    "#ff0000",
    "string",
    "int id PK",
    "List~int~",
    "+",
    "-",
    "#",
    "~",
    "static",
    "abstract",
    "a\u2028b",
    "tab\there",
]


def _pools(doc: str, sections: list[FormSection]) -> dict[str, list[str]]:
    """Candidate values per column header: what the example puts there, the options the placeholder or the
    header itself lists ("Left / Right", "(Top to bottom / Left to right)"), and every `code` word in the doc."""
    tables, _ = _example(doc)
    code_words = sorted(set(re.findall(r"`([^`\n]{1,30})`", doc)))
    pools: dict[str, list[str]] = {}
    for section in sections:
        for col, header in enumerate(section.headers):
            values: list[str] = []
            for table in tables:
                if header in table[0]:
                    index = table[0].index(header)
                    values += [row[index] for row in table[1:] if index < len(row)]
            for row in section.placeholder:
                if col < len(row):
                    values += [v.strip() for v in row[col].split("/")]
            listed = re.search(r"\(([^)]*/[^)]*)\)", header)
            if listed:
                values += [v.strip() for v in listed[1].split("/")]
            pools[header] = [v for v in values if v] + code_words
    return pools


def _short_header(header: str) -> str:
    """The alternate a person might type: "Type (Enterprise / System)" -> "Type"."""
    return re.sub(r"\s*\(.*\)\s*$", "", header) or header


def random_template(rnd: random.Random, doc: str) -> str:
    title, sections = _form(doc)
    pools = _pools(doc, sections)
    names = [f"Name {i}" for i in range(4)] + ["Web Server", "web-server", "Customer", "Order"]
    # Names used anywhere are reused elsewhere, so references between sections often resolve.
    used: list[str] = []
    filled: list[tuple[str, list[str], list[list[str]]]] = []
    for section in sections:
        if rnd.random() < 0.08:
            continue  # a dropped section
        heading = section.heading
        if rnd.random() < 0.1:
            heading = re.sub(r"^\d+\.\s*", "", heading)
        if rnd.random() < 0.05:
            heading = heading.upper()
        headers = [(_short_header(h) if rnd.random() < 0.15 else h) for h in section.headers]
        if rnd.random() < 0.05:
            headers.append("Extra")
        rows: list[list[str]] = []
        if headers[:2] == ["Field", "Value"]:
            for row in section.placeholder:
                if rnd.random() < 0.85:
                    rows.append([row[0], rnd.choice([*pools.get("Value", []), *names, *AWKWARD, "Left to right"])])
        else:
            for _ in range(rnd.randint(0, 6)):
                row = []
                for col, header in enumerate(section.headers):
                    roll = rnd.random()
                    if col == 0 or roll < 0.25:
                        value = rnd.choice(used) if used and roll < 0.3 else rnd.choice(names + pools[header][:6])
                        used.append(value)
                    elif roll < 0.7:
                        value = rnd.choice(pools[header]) if pools[header] else ""
                    elif roll < 0.85:
                        value = ""
                    elif roll < 0.92 and used:
                        value = ", ".join(rnd.sample(used, min(len(used), rnd.randint(1, 3))))
                    else:
                        value = rnd.choice(AWKWARD)
                    row.append(value.replace("|", "/"))
                if rnd.random() < 0.1:
                    row = row[: rnd.randint(1, len(row))]
                rows.append(row)
            if rnd.random() < 0.1 and rows:
                rows.append(list(rnd.choice(rows)))  # a duplicate row
        filled.append((heading, headers, rows))
    if rnd.random() < 0.15:
        rnd.shuffle(filled)
    return _document(title, filled, rnd.choice(["\n", "\n", "\n", "\r\n"]))


def _example_sections(doc: str) -> tuple[str, list[FormSection], list[tuple[str, list[str], list[list[str]]]]]:
    title, form = _form(doc)
    tables, _ = _example(doc)
    filled = []
    for section in form:
        if doc.startswith("# C4 Context"):
            rows = [list(r) for r in C4_CONTEXT_EXAMPLE[section.heading[:2]]]
        else:
            rows = next(([list(r) for r in t[1:]] for t in tables if t[0] == section.headers), [])
        filled.append((section.heading, list(section.headers), rows))
    return title, form, filled


def mutated_example(rnd: random.Random, doc: str) -> str:
    """The doc's worked example (which compiles) with a few changes, so most results still compile: metadata
    filled in, a name renamed everywhere to awkward text, cells changed, rows dropped or copied."""
    title, form, filled = _example_sections(doc)
    pools = _pools(doc, form)
    for heading, headers, rows in filled:
        if headers[:2] == ["Field", "Value"]:
            placeholder = next(s.placeholder for s in form if s.heading == heading)
            for row in placeholder:
                if rnd.random() < 0.7:
                    rows.append([row[0], rnd.choice([*pools.get("Value", []), "Shop", 'The "Shop"', "Ünïcødé ✓"])])
    for _ in range(rnd.choice([0, 0, 1, 1, 2, 3])):
        heading, headers, rows = rnd.choice(filled)
        if not rows:
            continue
        action = rnd.random()
        if action < 0.3:
            # Rename a name everywhere it appears (a cell, or an item of a comma-separated cell).
            old = rnd.choice(rows)[0]
            new = rnd.choice(["Web Server", 'He said "hi"', "[x] y", "Ünïcødé ✓", "constructor", "a\u00a0b", "API"])
            for _, _, other_rows in filled:
                for row in other_rows:
                    for col, value in enumerate(row):
                        parts = [p.strip() for p in value.split(",")]
                        if old in parts:
                            row[col] = ", ".join(new if p == old else p for p in parts)
        elif action < 0.6:
            row = rnd.choice(rows)
            col = rnd.randrange(len(row))
            choices = pools.get(headers[col], []) if col < len(headers) else []
            row[col] = rnd.choice(choices or [""]) if rnd.random() < 0.7 else rnd.choice(AWKWARD)
        elif action < 0.75:
            rows.remove(rnd.choice(rows))
        elif action < 0.9:
            copy = list(rnd.choice(rows))
            copy[0] = copy[0] + rnd.choice(["", " 2", "!"])  # the same name slugs alike: a numbered id
            rows.append(copy)
        else:
            filled.remove((heading, headers, rows))
    return _document(title, [(h, hd, rows or [[""] * len(hd)]) for h, hd, rows in filled], rnd.choice(["\n", "\r\n"]))


@pytest.fixture(scope="module")
def bridge(bridge_url: str | None) -> Iterator[DiagramBridge]:
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    with DiagramBridge(bridge_url) as client:
        yield client


@pytest.mark.parametrize("seed", [5, 11, 23, 2026])
def test_native_templates_match_the_bridge(bridge: DiagramBridge, seed: int) -> None:
    rnd = random.Random(seed)
    docs = {name: (DOCS / name).read_text("utf-8") for name in DOC_NAMES}
    failures: list[str] = []
    outcomes = {"dsl": 0, "errors": 0}
    for index in range(400):
        type_id = rnd.choice(sorted(DOC_FOR_TYPE))
        # Mostly the type's own doc; sometimes another doc, which mostly exercises the missing-section paths.
        doc = docs[DOC_FOR_TYPE[type_id] if rnd.random() < 0.9 else rnd.choice(DOC_NAMES)]
        template = mutated_example(rnd, doc) if rnd.random() < 0.6 else random_template(rnd, doc)
        mine = compile_template(type_id, template)
        theirs = bridge.compile_template(type_id, template)
        outcomes["dsl" if "dsl" in theirs else "errors"] += 1
        if mine != theirs:
            failures.append(f"seed={seed} index={index} type={type_id}\n{template}\nmine={mine}\ntheirs={theirs}")
    assert not failures, f"{len(failures)} differ; first:\n" + "\n\n".join(failures[:2])
    # The generator must keep reaching both outcomes, or the fuzz silently stops testing one of them.
    assert outcomes["dsl"] >= 40, outcomes
    assert outcomes["errors"] >= 40, outcomes


@pytest.mark.parametrize("doc_name", DOC_NAMES)
def test_the_raw_docs_match_the_bridge(bridge: DiagramBridge, doc_name: str) -> None:
    """The docs as published (blank form, mapping reference and example included), for every type."""
    doc = (DOCS / doc_name).read_text("utf-8")
    for type_id in DOC_FOR_TYPE:
        assert compile_template(type_id, doc) == bridge.compile_template(type_id, doc), type_id


def test_diagram_core_compiles_templates_natively_without_a_bridge() -> None:
    doc = (DOCS / "erd-template.md").read_text("utf-8")
    assert DiagramCore(None, mode="native").compile_template("erd", doc) == compile_template("erd", doc)
