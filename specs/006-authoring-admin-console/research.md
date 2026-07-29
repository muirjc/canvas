# Phase 0 Research: Canvas Authoring & Admin Console

Grounded in direct inspection of the model, both renderers, the standards service, the version
service, and the admin screens. Each decision records what was chosen, why, and what was rejected.

---

## 1. Container operations belong in `diagram-core`

**Decision**: Add pure functions to `packages/diagram-core/src/model/diagram-ops.ts` —
`addContainer`, `updateContainerLabel`, `moveContainer`, `resizeContainer`,
`assignNodeToContainer`, `removeNodeFromContainer`, `removeContainer` — and route the canvas
through them.

**Rationale**: The module currently exposes node and edge operations only; containers are
assembled inline in `Canvas.tsx` (the `groupSelected` handler builds the object literal by hand,
including a module-level `containerIdCounter`). This is precisely the gap feature 004 closed for
`addNode`/`addEdge`, and for the same reason: one mutation path shared by manual editing, the DSL,
and any future AI tool-calling. Leaving container mutation inline would mean AI container support
later has nothing to call.

**Alternatives rejected**: keeping the logic in the component (blocks reuse, and the counter is
module-global state that resets per page load, risking id collisions across diagrams); a separate
`container-ops` module (no benefit — same entity family, same file is where callers look).

---

## 2. Moving a container moves its members by delta

**Decision**: `moveContainer(model, id, position)` computes the delta from the container's current
position and applies it to every node whose `containerId` matches, and to any container whose
`parentContainerId` matches.

**Rationale**: Node positions in the model are **absolute**, not relative to a parent. There is no
transform hierarchy, so "contents travel with the container" (FR-009) can only mean rewriting
member positions. Applying a delta preserves each member's position *relative to* the container,
which is what the requirement and SC-004 demand.

Nested containers are included in the delta even though creating nesting is out of scope (§9),
because imported diagrams may already contain them and moving a parent must not tear them apart.

**Alternatives rejected**: storing member positions relative to the container (a model change that
would break every existing diagram and both renderers); recomputing membership from geometry on
each move (see §3).

---

## 3. Membership is explicit, set by drop hit-testing

**Decision**: Membership stays the existing explicit `node.containerId` field. Dropping a node
resolves membership by testing the dropped node's centre point against container bounds, then
calling `assignNodeToContainer` or `removeNodeFromContainer`.

**Rationale**: The model already carries `containerId`, the flowchart serializer already emits
membership as `subgraph` nesting, and the parser already reads it back. Geometry is used only at
the moment of the drop to *decide* membership; it is never the source of truth. That keeps a
shape's membership stable when a container is later resized — otherwise resizing a container
smaller would silently eject shapes, which the spec's edge cases forbid.

**Alternatives rejected**: purely geometric membership (fails the resize edge case, and cannot
express a shape deliberately outside a container that overlaps it); an explicit "add to container"
menu action (FR-011 requires direct manipulation).

---

## 4. A container must always carry a size

**Decision**: `addContainer` always sets a `size`, and no operation may clear it.

**Rationale**: This is a genuine round-trip trap. The flowchart serializer writes container
geometry to front-matter with `.filter((c) => c.size)` — a container **without** a size is
silently omitted, and the parser then falls back to an auto-position. A container created empty
without a size would therefore lose its position on the very first save/reload cycle, which is
exactly the "silent loss" Constitution Principle I prohibits.

**Alternatives rejected**: changing the serializer to emit position without size (widens the
front-matter contract and still leaves size undefined for the renderers, which both fall back to
300×200).

---

## 5. Deleting a container releases its shapes

**Decision**: `removeContainer(model, id)` removes the container and clears `containerId` on every
member, leaving node positions untouched.

**Rationale**: Settled during clarification — deletion never destroys contained shapes (FR-013).
Implemented as clearing the membership field rather than moving anything, so SC-004a ("100% of
shapes remain at unchanged positions") holds by construction. Nested child containers are
similarly re-parented to no parent rather than deleted.

---

## 6. Canvas interaction without breaking the performance gate

**Decision**: Containers get pointer handlers for drag, and resize handles rendered **only for the
selected container**. No shadow, filter, blur, or transition on containers or nodes.

**Rationale**: The existing gate asserts >50fps while dragging among 300 elements, and feature
005 established that the canvas sustains it only because nodes carry no expensive effects.
Containers are few relative to nodes, but a resize handle set rendered for *every* container would
add four elements each. Rendering handles only for the selection keeps the steady-state element
count essentially unchanged.

Dragging a container is the one new operation that touches many nodes at once (§2). It is a
position-only update on an existing immutable-model path, the same shape of work as dragging a
node, so it is expected to sit within the gate — but the gate must be re-run with containers
present rather than assumed.

---

## 7. Export fidelity: appearance unchanged, affordances screen-only

**Decision**: Do not change container *appearance*. Selection highlight, drag affordance, and
resize handles are screen-only and must never reach the export renderer.

**Rationale**: Containers are drawn by **both** renderers — `apps/web/src/canvas/Canvas.tsx` for
the screen and `packages/diagram-core/src/render/svg-renderer.ts` (`renderContainer`, dashed rect
plus label) for export. Constitution Principle I requires exports to match the canvas, so any
appearance change costs a coordinated edit in both plus export-fidelity verification. This feature
adds interaction, not styling, so that cost is avoidable entirely.

What *does* change in exports is content: new containers, names, and membership must appear
(FR-015). That already works through the existing `subgraph` serialization — it needs testing, not
new rendering code.

---

## 8. Standards metadata: additive migration, and **both** retire paths

**Decision**: One additive migration adding `name` (text), `description` (text), and `retired_at`
(timestamptz) to `standards`. Backfill existing rows with a derived readable name. Set
`retired_at` in **both** places that retire a standard.

**Rationale**: The table already has `created_at` and `published_at`; only these three are
missing. The important detail is that `status = 'retired'` is written in **two** places in
`standard.service.ts`:

1. `retireStandard(id)` — the explicit admin action.
2. `publishStandard(id)` — which auto-retires the previously published standard for that diagram
   type inside its transaction.

Updating only the first would leave every standard retired by publication with a null retirement
date, which is the majority path in practice. FR-024 must be satisfied by both.

**Backfill**: 33 standards already exist with no name. Derive one from diagram type and version
(e.g. "flowchart v3") so FR-026 and SC-006 hold for pre-existing rows without inventing intent.

---

## 9. Version history: cap and search server-side

**Decision**: Extend the existing versions endpoint with optional `limit` (defaulting to 5) and a
search term, filtering on version number and creation date. The client does not fetch the full
history.

**Rationale**: `listDiagramVersions` currently issues `SELECT ... ORDER BY sequence_number DESC`
with no bound, so the payload grows without limit — that unbounded response *is* the problem
FR-028 describes, and capping only in the UI would leave it untouched. Searching server-side also
means the architect can reach a version that was never transferred.

**Alternatives rejected**: fetching everything and slicing in the browser (simpler, no API change,
and search becomes trivial — but it keeps the unbounded payload and only hides it, which fails the
intent of the requirement on exactly the long-lived diagrams the story is about).

**Note on scope**: this adds API surface, which Constitution Principle VI asks to justify. The
justification is that the alternative does not actually solve the stated problem.

---

## 10. Admin console: one shell, navigation beneath the global header

**Decision**: A single `AdminShell` component providing the centred page container and a
horizontal navigation bar beneath the global app header, wrapping every admin screen. Admin
screens themselves are otherwise not restructured.

**Rationale**: All five admin screens render bare markup with no page container, which is why they
sit flush against the viewport edge — feature 005 gave them tokens but deliberately no layout, and
they had no layout of their own to inherit. Wrapping at the routing site in `App.tsx` fixes all
five at once without editing them individually, mirroring how bare-element CSS already restyled
them.

Placement beneath the global header (rather than a left sidebar) is the product decision recorded
in the spec's Assumptions: it matches the diagram editor's existing document-bar pattern and
preserves horizontal width for the wide Users, Standards, and Deleted Diagrams tables.

The bar also carries the route back to the diagrams (FR-003), which today does not exist anywhere
— an admin can currently only leave by editing the URL.

---

## 11. Label-editing affordance

**Decision**: An edit control revealed on hover **and** on selection/focus of a shape or
connector, activating the same inline editor the existing double-click opens.

**Rationale**: Hover alone would be undiscoverable by keyboard and would fail the accessibility
gate, so selection and focus must reveal it too. Reusing the existing editor keeps FR-019 and
FR-020 trivially true — the affordance is a second entry point to code that already works, not a
second implementation.

The control lives inside the SVG. The existing inline editors already use `foreignObject` for
exactly this, so the same mechanism applies and no new rendering approach is introduced.

---

## 12. Terminology change preserves the test contract

**Decision**: Relabel the visible text of the group action to present it as creating a container.
The `group-selected` testid, its `role`, and its accessible name pattern are preserved.

**Rationale**: Feature 005 established the 108 `data-testid` identifiers as a contract, and
`delete-shapes.spec.ts` drives `group-selected` directly. Only user-visible wording changes, so no
test needs editing — the control is preserved exactly as the spec's FR-033 requires.

---

## 13. Nesting: deferred for creation, preserved on round-trip

**Decision**: No UI for creating a container inside a container. Existing nested containers must
continue to render, save, and export unchanged.

**Rationale**: Settled during clarification. The model (`parentContainerId`) and the flowchart DSL
(nested `subgraph`) already support nesting, and `serializeContainer` recurses — so nested
containers arriving from an import already work. Deferring only the *authoring* of nesting keeps
the interaction surface small (Constitution VI) while avoiding a regression in what already
round-trips.

**Consequence**: `moveContainer` still cascades to child containers (§2), and `removeContainer`
re-parents children rather than deleting them (§5), so imported nested structures behave sanely
even though they cannot be created here.
