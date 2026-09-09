# C4 Context Diagram — Intake Template

Fill in each section below. Once complete, this maps directly onto Mermaid's
`C4Context` diagram type — the mapping notes at the bottom show exactly how
each field becomes a line of DSL, which is useful if you're feeding this into
a generator (e.g. Canvas) rather than writing Mermaid by hand.

---

## 1. Diagram metadata

| Field | Value |
|---|---|
| Diagram title | |
| Central system name | |
| Central system description (one line) | |
| Central system technology (optional) | |

---

## 2. Boundaries (optional)

Only fill this in if you want entities visually grouped (e.g. "Internal —
Acme Corp" vs. everything external). Leave blank to skip boundaries
entirely — most Level 1 diagrams don't need them.

| Boundary name | Type (Enterprise / System) | Entities inside |
|---|---|---|
| | | |

---

## 3. Surrounding entities

One row per person or system that talks to the central system. Do not
connect entities to each other — Level 1 only shows their relationship to
the central system.

| Name | Type | Internal/External | Description (one line) | Technology (optional) |
|---|---|---|---|---|
| | Person / System / SystemDb / SystemQueue | Internal / External | | |

**Type legend** (drives which Mermaid macro is used):
- `Person` — a human user
- `System` — another software system
- `SystemDb` — a system whose role is primarily data storage
- `SystemQueue` — a system whose role is primarily a message queue
- Add `_Ext` implicitly when Internal/External = External (e.g. an external
  Person becomes `Person_Ext`, an external System becomes `System_Ext`)

---

## 4. Relationships

One row per arrow. Every relationship must run between the central system
and one surrounding entity — never between two surrounding entities.

| From | To | Label (short verb phrase) | Technology/protocol (optional) |
|---|---|---|---|
| | | | |

Direction is implied by the From/To order — put the central system on
whichever side matches the actual call direction. For a two-way
relationship, add two rows (one each direction) rather than inventing a
bidirectional label.

---

## 5. Styling notes (optional)

Only needed if you want to override the default C4 palette (blue = central/
internal, grey = external). Leave blank to use defaults.

| Entity name | Background color | Font color | Border color |
|---|---|---|---|
| | | | |

---

## Mapping reference — template fields → Mermaid C4Context DSL

```
C4Context
    title <Diagram title>

    Person(alias, "<Name>", "<Description>")
    Person_Ext(alias, "<Name>", "<Description>")
    System(alias, "<Name>", "<Description>")
    System_Ext(alias, "<Name>", "<Description>")
    SystemDb(alias, "<Name>", "<Description>")
    SystemQueue_Ext(alias, "<Name>", "<Description>")

    System_Boundary(boundaryAlias, "<Boundary name>") {
        System(alias, "<Name>", "<Description>")
    }

    Rel(fromAlias, toAlias, "<Label>", "<Technology>")
    BiRel(fromAlias, toAlias, "<Label>", "<Technology>")

    UpdateElementStyle(alias, $bgColor="...", $fontColor="...", $borderColor="...")
```

- Each row in Section 3 becomes one `Person(...)` / `System(...)` /
  `SystemDb(...)` / `SystemQueue(...)` line — append `_Ext` when
  Internal/External = External.
- Aliases are short, unique, camelCase identifiers you assign per entity
  (not shown as a column above — generate as `firstNameLikeToken` from the
  Name field, e.g. "Payment Gateway" → `paymentGateway`).
- Each row in Section 4 becomes one `Rel(from, to, "label", "tech")` line.
- Section 2 boundaries wrap the relevant `System(...)` lines in a
  `System_Boundary(...) { ... }` block.
- Section 5 rows become trailing `UpdateElementStyle(...)` lines.

## Example — filled template → output

**Central system:** OrderService — "Handles order creation and fulfillment"

| Name | Type | Internal/Ext | Description |
|---|---|---|---|
| Customer | Person | Internal | Places and tracks orders |
| Payment Gateway | System | External | Processes credit card payments |

| From | To | Label | Tech |
|---|---|---|---|
| Customer | OrderService | Places orders using | HTTPS |
| OrderService | Payment Gateway | Sends payment requests to | HTTPS/JSON |

```
C4Context
    title System Context diagram: OrderService

    Person(customer, "Customer", "Places and tracks orders")
    System(orderService, "OrderService", "Handles order creation and fulfillment")
    System_Ext(paymentGateway, "Payment Gateway", "Processes credit card payments")

    Rel(customer, orderService, "Places orders using", "HTTPS")
    Rel(orderService, paymentGateway, "Sends payment requests to", "HTTPS/JSON")
```
