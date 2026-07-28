# Requirements Brief: Canvas Authoring & Admin Console

**Status**: Ready for `/speckit-specify`
**Created**: 2026-07-28
**Source**: Six items raised after reviewing the 005 UI redesign

This brief captures six requests, records what each one *actually* looks like in the code today
(verified, not assumed), and proposes a breakdown into independently deliverable user stories.

---

## 1. Verified current state

Findings from inspecting the running app and the source. Two change what the requests mean.

| # | Request | What exists today | What is actually missing |
|---|---|---|---|
| 1 | Edit shape labels | **Already works** — double-click a shape or connector opens an inline editor (`node-label-input-*`, feature 002) | **Discoverability only.** There is no visible affordance; nothing tells a user double-click is the gesture. |
| 2 | Container objects | Partial — "Group Selected" wraps 2+ selected shapes in a dashed box | Cannot create an empty container, rename it (label is hardcoded `"Group"`), move it, resize it, or drag shapes in or out. It is rendered as decoration: the container `<g>` has **no interaction handlers at all**. |
| 3 | Admin overview pushed left | Confirmed — renders flush against the viewport edge, no padding, links run together ("Manage StandardsManage Users") | A centered page container. Affects **all five** admin screens, not just Overview. |
| 4 | History: last 5 + search | Version history lists **every** version, unbounded, no filter | A cap and a way to find older versions. |
| 5 | Standard name/description/dates | `standards` has `created_at` and `published_at` | **`name`, `description`, and `retired_at` do not exist.** Retiring sets `status='retired'` but records no date. |
| 6 | Admin nav on every screen | Admin links appear only on the home screen; Overview has two of five | Persistent navigation — **and a way back to the diagrams**, which currently requires editing the URL or using browser Back. |

### Two findings worth calling out

**Item 1 is not a missing feature.** Label editing has worked since feature 002 — double-click a
shape or a connector. What is missing is any hint that the gesture exists. That reframes the work
from "build label editing" to "make it discoverable", which is much smaller. Worth confirming
this matches the intent before building anything.

**Item 3 is a regression I introduced.** Feature 005 deliberately scoped admin screens to
"inherit tokens, no bespoke layout". That assumption was wrong: those screens had no layout of
their own to inherit, so they came out unstyled and flush-left. This brief corrects that decision.

### Why item 5 matters more than it looks

The dev database currently holds **33 standards — 1 draft, 1 published, 31 retired** — and not
one of them has a name. They are distinguishable only by UUID and version number. Governance is
the product's core value proposition (Constitution II), and an admin cannot currently answer
"which standard is this, and why was it retired?"

---

## 2. Proposed breakdown

Five independently deliverable stories. Each can ship alone.

### US1 (P1) — Navigate and read the admin console

Centered, padded content on all five admin screens, plus navigation that is present on **every**
admin screen (including a route back to the diagrams).

*Why P1*: it is a live defect that makes admin work unpleasant right now, it is the smallest
slice here, and every other admin-facing story lands on top of it.

### US2 (P2) — Organize a diagram with containers

Create a container, name it, move it (members travel with it), resize it, and drag shapes in and
out. Nesting is already supported by the data model.

*Why P2*: the largest genuinely new capability in this batch, and the one that changes what users
can express.

### US3 (P3) — Discover how to edit a label

A visible affordance for editing a shape or connector label, so the existing capability is
findable without knowing the gesture.

*Why P3*: high value per unit of effort, but the capability already works for anyone who knows
about it.

### US4 (P4) — Identify and govern a standard

Name and description on a standard; creation date surfaced; retirement date recorded and shown.

*Why P4*: real governance value, but it needs a schema migration, making it the heaviest item
relative to its visible payoff.

### US5 (P5) — Find a specific version in history

Show the most recent five by default, with search to reach older ones.

*Why P5*: the smallest usability gain of the six, and only bites on long-lived diagrams.

**On the ordering**: US1 leads because it is a defect rather than an enhancement. If you would
rather lead with the headline capability, swap US1 and US2 — the stories are independent and
nothing else shifts.

---

## 3. Recommendation: where the admin navigation belongs

**Recommended: a horizontal sub-navigation bar directly beneath the global app header, shown on
every admin screen**, carrying the five destinations plus a "Back to diagrams" action.

Reasoning:

- **Consistency**: the diagram editor already establishes a context bar under the global header
  (the document bar). Reusing that vocabulary makes admin read as the same product rather than a
  bolted-on console.
- **Content width**: the admin screens are wide data tables (Users, Standards, Deleted Diagrams).
  A left sidebar would take 200–240px from content that needs it.
- **Scale**: five destinations sit comfortably on one row. A sidebar earns its cost at roughly
  eight or more, or when navigation nests — neither applies.
- **Cost**: works with the existing `?admin=` query-param routing; no router library, no new
  dependency.

**Alternative considered — left sidebar rail**: the conventional admin-console pattern, and the
better choice if the number of admin screens grows substantially or gains sub-sections. Rejected
for now on the content-width and scale points above.

**Alternative considered — put the links in the global header**: rejected because they would then
be present in the diagram editor too, where they are noise.

This is the one design decision in this brief that is genuinely reversible-but-annoying to
change later, so it is worth an explicit yes/no before implementation.

---

## 4. Implementation implications

Flagged here because they affect sizing, not because the spec should contain them.

- **Containers need `diagram-core` operations that do not exist.** The module has node and edge
  operations only; containers are currently assembled inline in `Canvas.tsx`. This story needs
  pure `addContainer` / `updateContainerLabel` / `moveContainer` / `resizeContainer` /
  `assignNodeToContainer` functions — exactly the gap feature 004 closed for `addNode`/`addEdge`,
  and for the same reason: one mutation path shared by manual, AI, and DSL edits.
- **The container data model is already sufficient** — `DiagramContainer` carries `id`, `label`,
  `position`, `size`, `style`, and `parentContainerId` (nesting), and the flowchart DSL already
  round-trips containers as `subgraph`. No model or DSL change is expected.
- **Standards metadata needs an additive migration** — `name`, `description`, `retired_at`.
  `created_at` already exists. Existing rows need a sensible backfill, since 33 unnamed standards
  are already stored.
- **Both renderers stay in scope-of-care.** Containers are drawn by the screen renderer *and* the
  export renderer; anything that changes container appearance must change both, or exports stop
  matching the canvas (Constitution I).
- **The testid and accessibility contracts from 005 still apply**: 108 identifiers preserved, and
  the axe-core zero-violation gate covers the admin screens this work touches.

---

## 5. Out of scope

- Any diagram type other than flowchart for container editing.
- Reworking the admin screens' information architecture beyond centering and navigation.
- Version *comparison* or diffing — US5 is find-and-restore only.
- Standards approval workflow; US4 adds descriptive metadata, not process.

---

## 6. Open questions

1. **Item 1 intent** — label editing already works via double-click. Is the request for a visible
   affordance (assumed here), or for something else, such as an inspector panel for editing a
   shape's other properties?
2. **Container membership rule** — does dropping a shape onto a container add it automatically,
   or should membership be explicit? Auto-add on drop is assumed.
3. **History search scope** — search by version number and date is assumed; searching by author
   would need author names surfaced, which they are not today.
