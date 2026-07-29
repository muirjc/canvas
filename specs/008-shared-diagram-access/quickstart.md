# Quickstart: Validating Shared Diagram Access

How to confirm this feature works — and, as importantly, how to avoid the two ways it can look
finished while actually testing the wrong scenario.

---

## Baseline before starting

```bash
npm run test --workspace=@canvas/diagram-core   # expect 154 passing, untouched by this feature
npm run test --workspace=@canvas/api            # expect 112 passing, 1 skipped (unrelated perf test)
npm run test:e2e --workspace=@canvas/web        # expect 96 passing, 1 skipped
```

None of these should fail before any code changes. If they do, that's pre-existing breakage —
resolve it first so a later red run can be trusted to mean this feature broke something.

---

## The fixture gap that matters most

Neither seeded user can currently represent User Story 1's own precondition (research.md §5):

- **admin** bypasses every access check outright.
- **architect** already holds a *project-level* grant on the Smoke Test project
  (`apps/api/src/seed/run.ts`) — permanent seed state, not something to unshare mid-test.

**Before writing the User Story 1 E2E test, add a third seeded user with zero project access** —
no ownership, no project-level grant, nothing. A test then has admin share one specific diagram
with that user (via the existing, unchanged `POST /diagrams/:id/shares`) and signs in as them to
prove the diagram is reachable with *no other path in*. Skipping this step and testing with the
architect account instead would produce a green test that actually covers FR-006 (duplication)
while believing it covers User Story 1 — the exact "green for the wrong reason" trap 007's
research flagged for a different fixture gap.

---

## Manual check that matters most

1. As admin, create a new project, create a diagram in it, and share that diagram (not the
   project) with the new zero-access user at `view` level.
2. Sign in as that user.
3. Confirm: no `create-first-project` invitation, no project picker (they still have no project),
   and the shared diagram is visible and opens read-only.
4. Separately, confirm a user with **no shares and no projects** still sees the ordinary
   first-run invitation, unchanged.

---

## Automated coverage this feature must add

### 1. API contract — `GET /shared-diagrams`

Using the existing `seedUser`/`seedProject` helpers (`apps/api/tests/helpers/setup.js`), which
already produce a user with no project by default:

- A user with a direct diagram grant and no project access sees exactly that diagram.
- A user with project-level access to a diagram **and** a direct grant on it sees it once, not
  duplicated in the array, and not omitted (FR-006).
- Revoking the grant (`DELETE /shares/:id`) removes the diagram from a subsequent call.
- Soft-deleting the diagram (existing delete endpoint) removes it from a subsequent call.
- `accessLevel` in the response matches what was granted, not the caller's role.
- The response never includes a field naming an ancestor project — only the immediate one.
- A user with nothing shared gets `{ "diagrams": [] }` and 200, not 404.

### 2. E2E — the two home-screen user stories

In `project-visibility.spec.ts` or a new `shared-diagrams.spec.ts` (either is fine; do not bury it
somewhere it won't be found alongside the other project/visibility coverage):

- The zero-access user (see fixture gap above) sees the shared diagram and opens it, with no
  `create-first-project` invitation shown.
- A user with genuinely nothing shared and no project still sees the ordinary invitation.
- A user with both project access and a directly-shared diagram in a *different* project sees the
  diagram in both the project browser (if it's in one of their projects) and the shared list,
  without either list breaking.
- The project name shown in a shared-list row has no `href` and no click handler — assert the
  element is not an anchor and a click on it does not navigate.

### 3. Accessibility

Add a case to `accessibility.spec.ts` for a signed-in user whose home screen includes the shared
list — none of the currently-audited pages/states include it, so it is unvalidated by omission
otherwise.

---

## Migration check

```bash
psql "$DATABASE_URL" -c "\d share_grants"   # confirm share_grants_grantee_idx now exists
```

This migration adds only an index — no backfill, no column, no risk of the ownerless-row problem
feature 007's migration had to guard against. There is nothing to verify beyond the index
existing.

---

## Full validation before calling it done

```bash
npm run test --workspace=@canvas/diagram-core   # 154, unchanged
npm run test --workspace=@canvas/api            # 112 + new shared-diagrams contract tests
npm run test:e2e --workspace=@canvas/web        # 96 + new shared-diagram-access coverage
```

Then confirm what automation does not fully cover:

- **SC-004** — `git diff` shows no weakened assertion in any existing spec file. Check the diff;
  a green run proves nothing about this on its own.
- **FR-005 / FR-013a carve-out** — read the actual rendered project-name element in a browser or
  test trace; confirm it is inert text, not a disguised link.
- **FR-008** — operate the shared list with the keyboard alone, tab order included.

---

## The two ways this looks done but isn't

1. **Testing User Story 1 with the seeded architect account.** It already has project access, so
   this silently tests FR-006 instead and leaves the actual reported defect (zero project access)
   unverified — see the fixture gap above.
2. **A project name that "shows" but is actually a link.** Rendering `<a>{projectName}</a>` out of
   habit (every other project reference in this codebase *is* a link) would pass a naive "is the
   name visible" test while reopening exactly the disclosure feature 007 closed, one hop removed.
   The test must assert the *absence* of navigability, not just the presence of text.
