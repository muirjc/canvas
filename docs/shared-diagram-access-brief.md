# Requirements Brief: Reaching a Diagram Shared With You

**Status**: Ready for `/speckit-specify`
**Created**: 2026-07-29
**Tracked as**: bead `canvas-ijq` (P2 bug)
**Introduced by**: feature 007 (`specs/007-project-context/`), deliberately

---

## 1. The problem

A user who has been granted access to a **diagram** — but not to the project containing it — has no
way to reach that diagram. Nothing in the product tells them it exists.

Worse, the home screen actively misinforms them. Having no project access, they are shown the
first-run invitation:

> You do not have any projects yet. Create one to start drawing diagrams.

They do have work. It is one query away, and they are told the opposite.

### Measured, not inferred

Signed in as a user with one diagram-level `view` grant and no project access:

| Request | Result |
|---|---|
| `GET /projects` | `{"projects":[]}` → the empty-state invitation |
| `GET /diagrams/<shared-id>` | **200** — the diagram is already fully readable |
| `GET /projects/<owning-project>/tree` | **403** — correctly refused |

**The access control is right; the navigation is missing.** No fetching rule needs to change. The
gap is entirely one of discovery.

---

## 2. Why it exists

Before feature 007, this worked — but only as a side effect of a hole. Any signed-in user could
read any project's entire diagram tree by id, so a diagram-grantee could simply browse the owning
project and find their diagram sitting among everyone else's.

007 closed that (`specs/007-project-context/research.md` §1). The navigation path disappeared with
it, because the path *was* the hole. **Restoring the old behaviour is not an option**: it would mean
letting someone granted one diagram see the names of every other diagram in the project.

### The seed currently hides this

`apps/api/src/seed/run.ts` grants the architect **project-level** access to the seeded project, so
`apps/web/tests/e2e/sharing.spec.ts` still navigates via the project browser and passes. That grant
is legitimate for a usable dev environment, but it means **no test currently exercises the
diagram-only case**. Any specification here should treat "a user with a diagram grant and no
project grant" as a first-class scenario rather than assuming the seeded environment represents it.

---

## 3. Options

| Option | Verdict |
|---|---|
| **A.** A "shared with me" list of diagrams granted directly to the user | **Recommended.** Solves discovery, which is the actual defect. Self-contained: one query over `share_grants`, one endpoint, one screen region. Purely additive, so it cannot disturb the project-context navigation 007 just settled. |
| **B.** Per-diagram deep links (`?diagramId=`) | **Complement, not a substitute — do not treat as an alternative.** It does not fix this bug: the recipient still needs somebody to send them a link, and nothing tells them there is anything to ask for. Independently worthwhile (there is currently no way to link to a diagram at all) and worth its own specification. It also touches the URL/history logic 007 stabilised, so bundling it here imports risk for no gain on this defect. |
| **C.** Grant project access implicitly when a diagram is shared | **Rejected — do not revisit.** Sharing one diagram would expose the names of every other diagram in that project. This is precisely the leak 007 closed. |

The bead originally framed A and B as alternatives. Investigation showed that is wrong: only A
addresses the reported problem.

---

## 4. Scope

**In scope**

- A user seeing the diagrams shared directly with them, without holding project access.
- Opening such a diagram from that list, at whatever access level the grant carries.
- The empty state telling the truth: "no projects" must not be shown to someone who has diagrams
  waiting.

**Out of scope**

- Per-diagram deep links (option B) — its own change.
- Any alteration to who may read what. Access resolution is already correct and must not move.
- Sharing UI changes; granting already works.
- Project-level sharing, which already works and is how a colleague gets a whole project.

---

## 5. Constraints

- The **`data-testid` identifiers are a contract**: additions fine, removals and renames are not.
- **Zero axe violations**, and any new list must be keyboard-operable (WCAG 2.1 AA).
- `packages/diagram-core/src/render/` must stay untouched.
- Current suites are green and must stay so: **154** diagram-core, **112** api, **96 passed / 1
  skipped** E2E.
- No change to `resolveDiagramAccess`. A diagram grant already yields the right level, including
  the `view` / `comment` / `edit` ladder.

---

## 6. Open questions for the specification

1. **Must the list avoid naming the owning project?** This is the sharp one. FR-013a of feature 007
   states that projects a user does not hold "MUST NOT be listed or **named**". A row reading
   *"Payment Flow — in Confidential Merger"* would name a project the user has no access to, and
   would breach that requirement while appearing helpful. Does a shared-diagram row show only the
   diagram, or is naming its project acceptable — and if so, does FR-013a need amending rather than
   quietly contradicting?
2. **Should diagrams already reachable through project access appear in the list too?** Listing only
   the otherwise-unreachable ones keeps it small and purposeful; listing all of them makes "shared
   with me" mean one consistent thing. Duplication versus a surprising omission.
3. **Where does it belong** — a section on the home screen beneath the project browser, or somewhere
   that is reachable regardless of the project in view? The home screen currently assumes a project
   context; this list has none.
4. **What identifies the sharer?** Showing who granted access is useful for judging what a diagram
   is, and unlike the project name it reveals nothing the user cannot already infer.
