# Sequence Diagram — Intake Template

Fill in each section below, then use **Import from Template** in Canvas and
pick the *Sequence* diagram type. Each section maps onto Mermaid's
`sequenceDiagram`; the mapping reference at the bottom shows how.

---

## 1. Diagram metadata

| Field | Value |
|---|---|
| Diagram title | |
| Number the messages (Yes / No) | |

---

## 2. Participants

One row per lifeline, in the order they should appear left to right.

| Name | Type |
|---|---|
| | Participant / Actor |

**Type legend:**
- `Participant` — a system, service or component (drawn as a box)
- `Actor` — a person (drawn as a stick figure)

---

## 3. Messages

One row per message, in the order they happen. `#` is the step number used
by Sections 4 and 5 to refer to a message. A participant may send a message
to itself (same name in From and To).

| # | From | To | Message | Arrow | Activation |
|---|---|---|---|---|---|
| | | | | Sync / Reply / Async / Lost | Start / End / (blank) |

**Arrow legend:**
- `Sync` — a call that waits for an answer (solid line, filled arrowhead). The default.
- `Reply` — the answer to an earlier call (dashed line)
- `Async` — fire-and-forget (solid line, open arrowhead)
- `Lost` — a message that fails or is never received (solid line, cross)

**Activation legend** (the narrow bar showing a participant is busy):
- `Start` — the **receiver** becomes active with this message
- `End` — the **sender** stops being active after this message

---

## 4. Blocks (optional)

Group a run of messages into a loop, an alternative, an optional step, etc.
Blocks may nest inside each other but must not partly overlap.

| Type | Label | First # | Last # | Branches |
|---|---|---|---|---|
| | | | | |

**Type legend:** `Loop`, `Alt` (alternatives: if / else), `Opt` (optional),
`Par` (in parallel), `Critical`, `Break`.

**Branches** — only for `Alt`, `Par` and `Critical`: where each further
branch starts, as `step: label`, separated by `;`. For example
`5: Card declined; 7: Timeout` starts an `else Card declined` branch at
message 5 and an `else Timeout` branch at message 7. Each branch must start
inside the block, after its first message.

---

## 5. Notes (optional)

| After # | Position | Participants | Text |
|---|---|---|---|
| | Over / Left of / Right of | | |

- `After #` — the message the note follows; `0` puts it before the first message.
- `Participants` — one name, or two separated by a comma for `Over`
  (the note then spans both lifelines).

---

## Mapping reference — template fields → Mermaid sequenceDiagram

```
sequenceDiagram
    title <Diagram title>
    autonumber                      (when "Number the messages" = Yes)

    participant <id> as <Name>      (Type = Participant)
    actor <id> as <Name>            (Type = Actor)

    <from> ->> <to>: <Message>      (Sync)
    <from> -->> <to>: <Message>     (Reply)
    <from> -) <to>: <Message>       (Async)
    <from> -x <to>: <Message>       (Lost)
    <from> ->>+ <to>: <Message>     (Activation = Start)
    <from> -->>- <to>: <Message>    (Activation = End)

    loop <Label>                    (Section 4 blocks wrap their messages)
        ...
    end
    alt <Label>
        ...
    else <Branch label>
        ...
    end

    Note over <id>,<id>: <Text>
```

- Ids are generated from the Name (e.g. "Payment Service" → `paymentService`).
- `Par` branches become `and <label>`; `Critical` branches become `option <label>`.

## Example — filled template → output

| Name | Type |
|---|---|
| Customer | Actor |
| Web Shop | Participant |
| Payment Service | Participant |

| # | From | To | Message | Arrow | Activation |
|---|---|---|---|---|---|
| 1 | Customer | Web Shop | Place order | Sync | Start |
| 2 | Web Shop | Payment Service | Charge card | Sync | Start |
| 3 | Payment Service | Web Shop | Payment approved | Reply | End |
| 4 | Payment Service | Web Shop | Card declined | Reply | End |
| 5 | Web Shop | Customer | Order confirmation | Reply | End |

| Type | Label | First # | Last # | Branches |
|---|---|---|---|---|
| Alt | Card accepted | 3 | 4 | 4: Card declined |

```
sequenceDiagram
    actor customer as Customer
    participant webShop as Web Shop
    participant paymentService as Payment Service

    customer ->>+ webShop: Place order
    webShop ->>+ paymentService: Charge card
    alt Card accepted
        paymentService -->>- webShop: Payment approved
    else Card declined
        paymentService -->>- webShop: Card declined
    end
    webShop -->>- customer: Order confirmation
```
