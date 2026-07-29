# UI Contract: Project Context

## The `data-testid` contract

108 identifiers are an interface contract: **additions are fine; removals, renames, and merges are
not.** Nothing in this feature removes or renames one.

### New identifiers

| testid | Element |
|---|---|
| `project-picker` | The control showing and changing the current project |
| `project-picker-option` | One selectable project within it |
| `project-name` | The current project's name, readable on screen (FR-008) |
| `create-first-project` | The empty-state invitation (FR-014) |
| `project-switch-confirm` | Unsaved-changes warning on switch (FR-013d) |

**Verified**: `project-context.spec.ts` references **17 testids, all of them existing ones** —
`new-diagram`, `admin-users-link`, `diagram-canvas` and so on. It names none of the five above.

Two consequences, and the second is the important one:

1. The five new names are free choices, constrained only by convention. No pre-existing test
   depends on them.
2. **The reproduction test can pass without a project picker existing at all.** It exercises
   User Stories 1 and 2 — reaching the primary actions, and context surviving the admin round
   trip. It says nothing about User Story 3. Choosing, switching, and above all the *visibility*
   rule (FR-013a) are entirely uncovered by it and need their own tests.

Reading "0/3 → 3/3" as "the feature works" would therefore be a mistake: it means the reported
defect is fixed, which is necessary and not sufficient. SC-005 still forbids weakening any of its
assertions to get there.

---

## Behavioural contract

### Selecting and persisting

- The current project is application state, seeded from the address on load (FR-005).
- The address keeps naming the project in view, updated **without** adding a history entry per
  switch (FR-011, FR-012).
- With exactly one project available, the user is placed in it and never made to choose from a
  list of one (spec Assumptions). This is today's only real-world case.
- With none available, the user sees the create-a-project invitation — **not** an error, and no
  project is created on their behalf (FR-014, FR-015).

### Links

Every in-app destination is built through one helper that carries the current project. Ten links,
but only six edit sites: `AdminShell.tsx:55` generates all five admin destinations from one
template inside a loop, and `App.tsx:146–158` holds five literal `href="?admin=…"` attributes.
Hand-editing fixes today's ten while leaving the eleventh to reintroduce the bug.

`AdminShell`'s "Back to diagrams" link already preserves what it is given and needs no change —
the loss happens one hop earlier, on the way *in*.

### Preserving the user's choice

`createDiagram()` currently calls `setPickingType(false)` **before** the project guard, so the
picker closes and the chosen diagram type is discarded before the error is shown. The guard must
run first (FR-003). Import and Create-with-AI already fail on the first click and need no
equivalent change.

### Unsaved changes

Switching project with unsaved work warns and offers confirm or cancel; cancelling leaves the work
intact (FR-013d). No dirty-state signal exists today — `saveStatus` is `idle | saving | saved |
error`, which is *request* state and never becomes "dirty" when the model changes.

### Accessibility

- Fully keyboard-operable, including opening, moving through options, choosing, and dismissing.
- Zero axe violations (FR-018, SC-007).
- The current project is announced to assistive technology, not conveyed by position alone.

---

## Preservation contract

- No existing control removed, merged, or renamed (FR-017).
- Addresses that already name a project keep working (FR-016, SC-008) — the address remains the
  seed, so this is preserved by construction rather than by a compatibility shim.
- No change to diagram rendering or export. `packages/diagram-core/src/render/` is untouched, so
  the screen and export renderers cannot drift as a result of this feature.
