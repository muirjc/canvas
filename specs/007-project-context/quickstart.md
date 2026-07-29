# Quickstart: Validating Project Context

How to confirm this feature works — and, as importantly, how to avoid the two ways it can look
finished while being broken.

---

## Baseline before starting

```bash
npm run test --workspace=@canvas/diagram-core   # expect 154 passing
npm run test --workspace=@canvas/api            # expect  95 passing
npm run test --workspace=@canvas/web            # unit
npm run test:e2e --workspace=@canvas/web        # expect 83 passing + 3 failing (the target)
```

The three failures in `project-context.spec.ts` are the point. **Confirm they fail for the right
reason** — the missing-project error — before changing anything. A test failing because the dev
server is down proves nothing, and this session has already lost time once to a stale API process
holding port 3000.

---

## The manual check that matters most

The defect exists because no automated test ever reached the home screen the way a user does.
So do that by hand, first:

1. Open the app at the bare root — **nothing after the domain**.
2. Sign in.
3. Click New Diagram, pick a type, create.

It must succeed with no address-bar editing. Then, without touching the address bar: visit an
admin screen, come back, and create another diagram. Still the same project.

---

## Automated coverage this feature must add

The existing reproduction test covers User Stories 1 and 2 only. Three areas need new tests:

### 1. Access enforcement — one negative test per guarded route

Non-negotiable, because of the parameter-name trap in `contracts/projects-api.md`: a guard copied
from `requireDiagramAccess` reads `params.id`, which is `undefined` on the three `:projectId`
routes, and silently lets every request through. **A happy-path test cannot see this.**

For each of the five routes, as a user who neither owns the project nor has been granted it:

| Route | Expect |
|---|---|
| `GET /projects/:id` | 403 |
| `GET /projects/:id/tree` | 403 |
| `POST /projects/:projectId/diagrams` | 403 |
| `GET /projects/:projectId/diagrams` | 403 |
| `POST /projects/:projectId/diagrams/import` | 403 |

Plus: a genuinely nonexistent id returns **404**, not 403 (matching the existing diagram
convention — see `data-model.md`).

### 2. Visibility — `GET /projects`

With two users and at least three projects (A owns one, B owns one, B shares a third with A):

- A sees exactly two — their own and the shared one.
- A does **not** see B's unshared project, by id or by name.
- A user with access to nothing gets `{ "projects": [] }` and 200, not 404.

### 3. Nesting

Access inherits downward but not upward (`data-model.md`):

- A user who can see a parent can see its children.
- A user granted only a child sees **neither** the parent nor its siblings.

---

## Migration check

The backfill is the one step that can quietly break every environment at once.

```bash
# Against a database with existing data, including the seeded project:
psql "$DATABASE_URL" -c "SELECT count(*) FROM projects WHERE owner_id IS NULL;"
```

Must return **0**. Any ownerless project is invisible to everyone — the exact failure FR-013b
exists to prevent.

Verify against a database where **a project has no diagrams** (the seeded one may qualify). A
migration that only infers ownership from diagram owners has nothing to infer from and will fail
or leave NULL precisely there.

---

## Full validation before calling it done

```bash
npm run test --workspace=@canvas/diagram-core   # 154, unchanged — this feature touches none of it
npm run test --workspace=@canvas/api            # 95 + new access-control tests
npm run test --workspace=@canvas/web
npm run test:e2e --workspace=@canvas/web        # 83 + 3 now passing + new picker tests
```

Then confirm each success criterion that automation does not cover:

- **SC-005** — the three reproduction tests pass **and** `git diff` shows no weakened assertion in
  `project-context.spec.ts`. Check the diff; do not take the green tick as evidence.
- **SC-007** — axe reports zero violations, including on the new picker.
- **SC-008** — an address explicitly naming a project still opens it.
- **FR-018** — operate the picker with the keyboard alone.

---

## The two ways this looks done but isn't

1. **"0/3 → 3/3, ship it."** Those three tests cover US1 and US2. They do not touch the visibility
   rule, which is the part whose failure is a data leak rather than a bug.
2. **A guard that returns 200 for everyone.** Reading the wrong route parameter disables
   enforcement completely while every happy-path test stays green. This is why §1 above demands a
   negative test per route rather than per middleware.
