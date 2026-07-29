# UI Contract: Reaching a Diagram Shared With You

## The `data-testid` contract

144 identifiers are an interface contract: **additions are fine; removals, renames, and merges are
not.** Nothing in this feature removes or renames one.

### New identifiers

| testid | Element |
|---|---|
| `shared-diagrams` | The list section itself — absent from the DOM entirely when there is nothing to show (FR-002) |
| `shared-diagram-{id}` | One row |
| `open-shared-diagram-{id}` | Opens that diagram (reuses the existing open-diagram flow) |
| `shared-diagram-project-{id}` | The project name, read-only text — asserted on to prove it is present (FR-005) *and* that it carries no `href`/`onClick` (the FR-013a carve-out) |
| `shared-diagram-shared-by-{id}` | Who granted access (FR-007) |
| `shared-diagram-access-{id}` | The resolved access level (view/comment/edit) |

None of these collide with `project-node-{id}` or `open-diagram-{id}` (`ProjectBrowser.tsx`) — a
diagram appearing in both places (FR-006) renders as two distinct rows with two distinct testids,
not a shared element.

---

## Behavioural contract

### Visibility of the section

- The section renders only when `GET /shared-diagrams` returns at least one entry — omitted
  entirely otherwise, not shown as an empty state (spec Clarifications, Q2).
- Rendered independent of the current project — above/outside the existing
  `hasNoProjects ? … : …` branch in `App.tsx`, never nested inside the project browser
  (spec Assumptions; research.md §6).
- For a user with zero projects **and** at least one shared diagram: the first-run
  `create-first-project` invitation (text and its create-project form) is suppressed entirely,
  per FR-003's literal wording — the shared list is the whole of that user's home screen. This is
  the accepted clarification, not a gap to quietly patch by showing both.
- For a user with zero projects and zero shared diagrams: today's `create-first-project`
  invitation, byte-for-byte unchanged.

### Naming the project

- Shows the diagram's immediate containing project's name as plain text.
- Never a link, never accompanied by a way to browse that project, and never extended to an
  ancestor project even when the immediate project is itself nested (FR-005, spec Clarifications).
  This is the one place feature 007's FR-013a ("projects belonging to others MUST NOT be listed or
  named") is deliberately narrowed — the amendment lives in
  `specs/007-project-context/spec.md`, not here.

### Sharer identity

- Shows the granting user's name, unchanged by whether their account is later deactivated
  (FR-007, spec Clarifications) — do not conditionally swap in a placeholder.

### Opening a diagram

- Calls the same `openDiagram` path `ProjectBrowser` already uses (`api.getDiagram` →
  `setDiagram`). No new access path, no new client-side gating (FR-004, FR-010).

### Accessibility

- Every row and control operable by keyboard alone.
- Zero axe violations (FR-008) — add a case to `accessibility.spec.ts` covering a signed-in user
  who has at least one shared diagram, since none of the existing audited pages/states include
  this section.

---

## Preservation contract

- No existing control removed, merged, or renamed.
- `ProjectBrowser`, `project-context.ts`, and the project picker are untouched — this feature adds
  a sibling section, not a modification to how project selection or navigation works.
- No change to diagram rendering or export. `packages/diagram-core/src/render/` is untouched.
