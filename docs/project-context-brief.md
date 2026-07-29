# Requirements Brief: Project Context

**Status**: Ready for `/speckit-specify`
**Created**: 2026-07-29
**Tracked as**: bead `canvas-xyl` (P1 bug) — full diagnostic history lives there
**Evidence**: `apps/web/tests/e2e/project-context.spec.ts` — 3 tests, currently failing 0/3

---

## 1. The problem

Creating a diagram from the ordinary entry point fails:

> Missing ?projectId= in the URL — create a project first (User Story 4).

**`projectId` is URL-only state that the application reads but never writes.** Across all of
`apps/web/src`, only two places touch it: the reader `getProjectIdFromUrl()`, and `AdminShell`'s
back-link. Every `<a href="?…">` is an absolute query-string replacement, so any click discards
it. The only way to hold a project context is to type it into the address bar.

`App.tsx` already carries a comment conceding the query parameter stands in for a project chooser
that was never built. This is that chooser.

### Two journeys reach the error

| # | Journey | Notes |
|---|---|---|
| 1 | Land on `/` with no query string → sign in → New Diagram → pick a type → Create | Not an edge case. This is what happens to anyone who does not know the parameter exists. |
| 2 | Sign in *with* `?projectId=…` → visit any admin screen → come back → create | The parameter is lost on the **first** hop. |

For journey 2: `AdminShell`'s back-link is correct in isolation — it preserves what it is given.
The loss happens one hop earlier, in the `?admin=` links that carry no `projectId` at all (five in
`AdminShell.tsx`, five in `App.tsx`'s home nav).

### Secondary defect, fixable independently

`createDiagram()` calls `setPickingType(false)` **before** the `projectId` guard, so the picker
closes and the user's chosen diagram type is discarded before the error appears. Import and
Create-with-AI at least fail on the first click. Two-line fix; worth doing regardless of the
approach chosen.

---

## 2. Why the test suite never caught it

Worth recording, because it is a class of blind spot rather than a one-off.

Every spec that clicks `new-diagram`, `import-diagram-button`, or `create-via-ai-chat` first
navigates to `/?projectId=${PROJECT_ID}`. The only bare `page.goto('/')` calls are in
`accessibility.spec.ts` (login-page audit, never signs in) and `ui-foundation.spec.ts` (reads
computed styles, then re-enters through a helper that supplies the parameter).

**No test ever reached the home screen the way a user does**, so the defect was structurally
invisible to a suite of 83 passing E2E tests. Test fixtures that always supply a value the real UI
never sets will hide this entire class of bug.

---

## 3. Options

| Option | Verdict |
|---|---|
| **A.** Thread `projectId` through the ten `?admin=` links | Repairs journey 2 only. Leaves journey 1 broken and makes the bug *harder to hit* — worse than leaving it obvious. Necessary as part of a real fix, insufficient alone. |
| **B.** Fall back to the only/first project when absent | **Rejected — do not revisit.** `projects` has no owner or membership column (`0001_init.sql`), so "the user's project" is not expressible. The fallback would mean "the sole project", which breaks silently the moment a second exists. There is also no `GET /projects` endpoint today (only `POST /projects`, `GET /projects/:id`, `GET /projects/:id/tree`). |
| **C.** Hold the selected project in application state, seeded from the URL, with a picker | **Recommended.** Removes the class of bug rather than patching links, and delivers the chooser the code already admits is missing. Subsumes A: the state must still survive navigation. |

---

## 4. Scope

**In scope**

- Selecting a project in the UI, without touching the address bar.
- Project context surviving in-app navigation, including the admin console round trip.
- A sensible first-run experience when no project exists yet.
- URLs remaining shareable — a link to a specific project should still work, and should still
  reflect the current project so it can be copied.
- Preserving the user's diagram-type choice when creation cannot proceed.

**Out of scope**

- Project CRUD beyond what selection requires (no rename, delete, or nesting UI).
- Project-level permissions or ownership — the schema has no owner column, and adding one is its
  own change.
- Any change to diagram rendering or export.

---

## 5. Constraints

- The **108 `data-testid` identifiers are a contract**; additions fine, removals and renames are
  not.
- **Zero axe violations** on the audited screens, and any new picker must be keyboard-operable.
- `packages/diagram-core/src/render/` must stay untouched — exports must keep matching the canvas.
- The existing suite is green: **154 diagram-core, 95 api, 83 E2E**. The three tests in
  `project-context.spec.ts` are the target; they must pass **without being weakened**.
- A `GET /projects` endpoint does not exist. If project selection needs to list projects, that is
  new API surface and should be specified deliberately rather than assumed.

---

## 6. Open questions for the specification

1. **Multiple projects** — the seeded database has exactly one. When several exist, is the picker
   a dropdown in the header, a landing screen, or something else? What is selected by default?
2. **First run, no projects** — create one implicitly on first use, or prompt? Implicit creation is
   friendlier but invents a name on the user's behalf.
3. **Should the URL keep reflecting the selection?** Assumed yes, via a mechanism that does not add
   a history entry per switch, so shareable links keep working and the Back button stays sane.
