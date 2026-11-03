"""Port of diagram-core's template/sequence-template-compiler.ts: a filled-in docs/sequence-template.md ->
Mermaid `sequenceDiagram` DSL. Blocks are message ranges (First # .. Last #) and must nest properly; Alt/Par/
Critical branches start at a message inside their block.

Steps are JavaScript numbers (`Number(text)`: "0x10", "1e2" and "2.0" are whole numbers too), kept as floats and
written with `js_number`.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from canvas_api.diagram_core.templates.helpers import (
    AliasAllocator,
    camel_slug,
    cell,
    err,
    find_section,
    pick_option,
    read_metadata_fields,
    read_yes_no,
)
from canvas_api.diagram_core.templates.jsregex import DOT, S
from canvas_api.diagram_core.templates.markdown_table import extract_first_table, split_into_sections
from canvas_api.github.jstext import js_number, js_trim

__all__ = ["compile_sequence"]

PARTICIPANT_TYPES = ("Participant", "Actor")
ARROWS = {"Sync": "->>", "Reply": "-->>", "Async": "-)", "Lost": "-x"}
ARROW_NAMES = tuple(ARROWS)
ACTIVATIONS = ("Start", "End")
BLOCK_TYPES = ("Loop", "Alt", "Opt", "Par", "Critical", "Break")
BRANCH_KEYWORD = {"Alt": "else", "Par": "and", "Critical": "option"}
NOTE_POSITIONS = ("Over", "Left of", "Right of")

_BRANCH = re.compile(f"([0-9]+){S}*:{S}*({DOT}*)")
_DECIMAL = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
_NON_DECIMAL = re.compile(r"0(?:[xX]([0-9a-fA-F]+)|[oO]([0-7]+)|[bB]([01]+))")


@dataclass
class _Message:
    step: float
    line: str


@dataclass
class _Branch:
    step: float
    label: str


@dataclass
class _Block:
    type: str
    label: str
    first: float
    last: float
    branches: list[_Branch] = field(default_factory=list)


@dataclass
class _Note:
    after: float
    line: str


def _js_to_number(value: str) -> float:
    """JavaScript's `Number(value)` for a string."""
    value = js_trim(value)
    if not value:
        return 0.0
    if _DECIMAL.fullmatch(value):
        return float(value)
    match = _NON_DECIMAL.fullmatch(value)
    if match:
        hex_digits, oct_digits, bin_digits = match.groups()
        number = int(hex_digits, 16) if hex_digits else int(oct_digits, 8) if oct_digits else int(bin_digits, 2)
        try:
            return float(number)
        except OverflowError:
            return math.inf
    return math.nan


def _text(value: str) -> str:
    """Sequence text runs to the end of the line; a `;` would end the statement in Mermaid."""
    return js_trim(value.replace(";", ","))


def _parse_step(value: str) -> float | None:
    n = _js_to_number(value)
    return n if js_trim(value) != "" and math.isfinite(n) and n.is_integer() and n >= 0 else None


def compile_sequence(markdown: str) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    sections = split_into_sections(markdown)
    metadata_section = find_section(sections, "diagram metadata")
    participants_section = find_section(sections, "participants")
    messages_section = find_section(sections, "messages")
    blocks_section = find_section(sections, "blocks")
    notes_section = find_section(sections, "notes")

    if participants_section is None:
        errors.append(err('Missing required section "2. Participants".'))
    if messages_section is None:
        errors.append(err('Missing required section "3. Messages".'))
    if participants_section is None or messages_section is None:
        return {"errors": errors}

    fields = read_metadata_fields(metadata_section) if metadata_section else {}
    title = _text(fields.get("Diagram title", ""))
    numbering = fields.get("Number the messages (Yes / No)")
    if numbering is None:
        numbering = fields.get("Number the messages", "")
    autonumber = read_yes_no(numbering, False)
    if autonumber is None:
        errors.append(err('Section 1: "Number the messages" must be Yes or No.'))

    # Section 2: participants
    aliases = AliasAllocator(lambda name: camel_slug(name, "participant"))
    id_by_name: dict[str, str] = {}
    participant_lines: list[str] = []
    for row in extract_first_table(participants_section.body):
        name = cell(row, "Name")
        if not name:
            continue
        participant_type = pick_option(cell(row, "Type") or "Participant", PARTICIPANT_TYPES)
        if participant_type is None:
            errors.append(
                err(f'Section 2, "{name}": unrecognized Type "{cell(row, "Type")}" (expected Participant or Actor).')
            )
            continue
        if name in id_by_name:
            errors.append(err(f'Section 2: participant "{name}" is listed twice.'))
            continue
        participant_id = aliases.allocate(name)
        id_by_name[name] = participant_id
        participant_lines.append(f"{participant_type.lower()} {participant_id} as {_text(name)}")
    if not id_by_name:
        errors.append(err("Section 2: list at least one participant."))

    def resolve(name: str, where: str) -> str | None:
        participant_id = id_by_name.get(name)
        if not participant_id:
            errors.append(err(f'{where}: "{name}" is not listed in Section 2 (Participants).'))
        return participant_id

    # Section 3: messages
    messages: list[_Message] = []
    for row in extract_first_table(messages_section.body):
        from_ = cell(row, "From")
        to = cell(row, "To")
        label = cell(row, "Message")
        if not from_ and not to and not label:
            continue
        step_raw = cell(row, "#")
        step = _parse_step(step_raw) if step_raw else float(len(messages) + 1)
        where = f"Section 3, message {step_raw or len(messages) + 1}"
        if step is None or step == 0:
            errors.append(err(f'{where}: "#" must be a whole number from 1.'))
            continue
        if any(m.step == step for m in messages):
            errors.append(err(f"{where}: step {js_number(step)} is used twice."))
            continue
        if messages and step < messages[-1].step:
            errors.append(err(f"{where}: messages must be listed in step order."))
            continue
        arrow = pick_option(cell(row, "Arrow") or "Sync", ARROW_NAMES)
        if arrow is None:
            errors.append(
                err(f'{where}: unrecognized Arrow "{cell(row, "Arrow")}" (expected {", ".join(ARROW_NAMES)}).')
            )
            continue
        activation_raw = cell(row, "Activation")
        activation = pick_option(activation_raw, ACTIVATIONS) if activation_raw else None
        if activation_raw and not activation:
            errors.append(err(f'{where}: unrecognized Activation "{activation_raw}" (expected Start, End or blank).'))
            continue
        if not label:
            errors.append(err(f"{where}: the Message text is required."))
            continue
        from_id = resolve(from_, where)
        to_id = resolve(to, where)
        if not from_id or not to_id:
            continue
        marker = "+" if activation == "Start" else "-" if activation == "End" else ""
        messages.append(_Message(step, f"{from_id} {ARROWS[arrow]}{marker} {to_id}: {_text(label)}"))
    if not messages and not errors:
        errors.append(err("Section 3: list at least one message."))
    steps = {m.step for m in messages}

    # Section 4: blocks
    blocks: list[_Block] = []
    if blocks_section:
        for row in extract_first_table(blocks_section.body):
            type_raw = cell(row, "Type")
            if not type_raw and not cell(row, "First #") and not cell(row, "Label"):
                continue
            block_type = pick_option(type_raw, BLOCK_TYPES)
            where = f'Section 4, block "{cell(row, "Label") or type_raw}"'
            if block_type is None:
                errors.append(err(f'{where}: unrecognized Type "{type_raw}" (expected {", ".join(BLOCK_TYPES)}).'))
                continue
            first = _parse_step(cell(row, "First #"))
            last = _parse_step(cell(row, "Last #"))
            if first is None or last is None or first not in steps or last not in steps or first > last:
                errors.append(
                    err(f'{where}: "First #" and "Last #" must be message steps from Section 3, first <= last.')
                )
                continue
            branches: list[_Branch] = []
            branches_raw = cell(row, "Branches")
            if branches_raw and block_type not in BRANCH_KEYWORD:
                errors.append(err(f"{where}: only Alt, Par and Critical blocks have branches."))
                continue
            branch_error = False
            for part in (p for p in (js_trim(p) for p in branches_raw.split(";")) if p):
                match = _BRANCH.fullmatch(part)
                branch_step = float(match[1]) if match else None
                if match is None or branch_step is None or branch_step not in steps or not first < branch_step <= last:
                    errors.append(
                        err(
                            f'{where}: branch "{part}" must be "step: label", '
                            "with the step a message inside the block after its first."
                        )
                    )
                    branch_error = True
                    continue
                branches.append(_Branch(branch_step, _text(match[2])))
            if branch_error:
                continue
            branches.sort(key=lambda br: br.step)
            blocks.append(_Block(block_type, _text(cell(row, "Label")), first, last, branches))
        # Blocks must nest: two ranges either don't overlap or one contains the other.
        for i, a in enumerate(blocks):
            for b in blocks[i + 1 :]:
                overlap = a.first <= b.last and b.first <= a.last
                nested = (a.first <= b.first and b.last <= a.last) or (b.first <= a.first and a.last <= b.last)
                if overlap and not nested:
                    errors.append(
                        err(
                            f'Section 4: blocks "{a.label or a.type}" and "{b.label or b.type}" partly overlap '
                            "-- blocks must nest."
                        )
                    )
                    continue
                # A block nested inside another can't straddle one of the outer block's branches.
                outer, inner = (a, b) if nested and b.first >= a.first and b.last <= a.last else (b, a)
                if overlap and any(inner.first < br.step <= inner.last for br in outer.branches):
                    errors.append(
                        err(
                            f'Section 4: block "{inner.label or inner.type}" crosses a branch of '
                            f'"{outer.label or outer.type}" -- end it before the branch starts.'
                        )
                    )

    # Section 5: notes
    notes: list[_Note] = []
    if notes_section:
        for row in extract_first_table(notes_section.body):
            note_text = cell(row, "Text")
            participants = cell(row, "Participants")
            if not note_text and not participants:
                continue
            where = f'Section 5, note "{note_text}"'
            after = _parse_step(cell(row, "After #") or "0")
            if after is None or (after != 0 and after not in steps):
                errors.append(err(f'{where}: "After #" must be 0 or a message step from Section 3.'))
                continue
            position = pick_option(cell(row, "Position") or "Over", NOTE_POSITIONS)
            if position is None:
                errors.append(
                    err(
                        f'{where}: unrecognized Position "{cell(row, "Position")}" '
                        "(expected Over, Left of or Right of)."
                    )
                )
                continue
            names = [n for n in (js_trim(n) for n in participants.split(",")) if n]
            if not names or len(names) > 2 or (len(names) == 2 and position != "Over"):
                errors.append(err(f'{where}: give one participant, or two for "Over".'))
                continue
            ids = [resolve(n, where) for n in names]
            if not all(ids):
                continue
            notes.append(_Note(after, f"Note {position.lower()} {','.join(i for i in ids if i)}: {_text(note_text)}"))

    if errors:
        return {"errors": errors}

    # Assembly
    lines = ["sequenceDiagram"]
    if title:
        lines.append(f"    title {title}")
    if autonumber:
        lines.append("    autonumber")
    lines.extend(f"    {p}" for p in participant_lines)
    lines.append("")
    depth = 1

    def push_notes_after(step: float) -> None:
        lines.extend(f"{'    ' * depth}{note.line}" for note in notes if note.after == step)

    push_notes_after(0)
    for message in messages:
        # A branch divider first (at its block's own depth, one level out from the block's messages) -- a block
        # opening at the same step belongs to the new branch.
        for block in blocks:
            branch = next((br for br in block.branches if br.step == message.step), None)
            if branch:
                label = f" {branch.label}" if branch.label else ""
                lines.append(f"{'    ' * (depth - 1)}{BRANCH_KEYWORD[block.type]}{label}")
        # Then open blocks starting here, outermost (longest) first.
        for block in sorted((b for b in blocks if b.first == message.step), key=lambda b: -b.last):
            label = f" {block.label}" if block.label else ""
            lines.append(f"{'    ' * depth}{block.type.lower()}{label}")
            depth += 1
        lines.append(f"{'    ' * depth}{message.line}")
        push_notes_after(message.step)
        # Close blocks ending here, innermost (shortest) first.
        for _ in (b for b in blocks if b.last == message.step):
            depth -= 1
            lines.append(f"{'    ' * depth}end")
    return {"dsl": "\n".join(lines) + "\n"}
