# Quickstart: Canvas Authoring & Admin Console

Builds on `specs/001-diagramming-platform/quickstart.md`. One new setup step: an additive
migration for standards metadata.

```bash
docker compose up -d
npm run build --workspace=@canvas/diagram-core
npm run migrate --workspace=@canvas/api     # applies the standards metadata migration + backfill
npm run dev --workspace=@canvas/api         # separate terminal (AI_PROVIDER=mock for the AI specs)
npm run dev --workspace=@canvas/web         # separate terminal
```

Sign in at `http://localhost:5173/?projectId=<seed-printed-id>` as
`admin@example.com` / `admin-dev-password`. Validate at **1440×900**.

---

## Manual validation by user story

### US1 — Admin console navigation and layout

1. Visit each admin screen: Overview, Standards, Users, Deleted Diagrams, AI Personas.
2. Confirm content is **centred with clear margins** on every one — none flush against the window
   edge.
3. Confirm navigation to every other admin destination is visible without scrolling, and that the
   screen you are on is visually distinct.
4. Use the route back to the diagrams. Confirm it works **without** editing the URL or pressing
   browser Back.
5. Confirm adjacent links are visually separated — the "Manage StandardsManage Users" run-together
   defect must be gone.
6. Sign in as `architect@example.com` and confirm admin destinations remain inaccessible.

### US2 — Containers

1. On a flowchart diagram, create a container **without selecting any shape first**. Confirm it
   appears with a name.
2. Rename it to something meaningful. Save, reopen the diagram, and confirm the name persisted.
3. Drag two shapes into it. Confirm they become members.
4. **Move the container.** Confirm every member moves with it and their positions *relative to*
   the container are unchanged.
5. **Resize it.** Confirm no shape inside moved or resized. Now shrink it smaller than its
   contents and confirm **nothing is ejected or hidden**.
6. Drag one shape out. Confirm it is no longer a member and no longer moves with the container.
7. **Delete the container.** Confirm you are told the contents will be kept, and that after
   confirming every shape is still on the canvas at its original position.
8. Save, reopen, and confirm containers, names, sizes, and membership all survived.
9. Export to SVG and confirm containers, names, and membership match the canvas.
10. Confirm the relabelled group action still works and reads as creating a container.

### US3 — Discoverable label editing

1. Hover a shape. Confirm a visible affordance indicates the label can be edited.
2. Select a shape **using only the keyboard**. Confirm the same affordance appears — it must not
   be hover-only.
3. Activate it and confirm the inline editor opens.
4. Confirm **double-click still works** exactly as before.
5. Repeat for a connector.

### US4 — Standards identity and lifecycle

1. Open the standards admin screen. Confirm every standard shows a **name**, including ones
   created before this feature.
2. Create a standard with a name and description; confirm both appear in the list.
3. Confirm its creation date is shown.
4. Retire it explicitly. Confirm a retirement date is recorded and displayed.
5. **The path most likely to be missed**: publish a *new* standard for a diagram type that already
   has a published one. The superseded standard is auto-retired — confirm **it too** has a
   retirement date, not just the explicitly retired one.
6. Confirm a standard that has never been retired shows no retirement date.

### US5 — Version history

1. Save a diagram more than five times.
2. Open version history. Confirm **only the five most recent** are listed, and that it is evident
   older versions exist.
3. Search for an older version. Confirm it appears and can be restored.
4. Search for something that matches nothing. Confirm an explicit "no matches" message, not a
   blank area.
5. On a diagram with **exactly five** versions, confirm all five show and nothing implies hidden
   versions.

---

## Regression checks

1. **Exports still match the canvas** — container appearance is deliberately unchanged, so:
   ```bash
   git diff --stat main -- packages/diagram-core/src/render/   # expected: empty
   ```
   Then export a diagram containing containers to SVG and PNG and compare against the canvas.

2. **Empty containers survive a round trip** — the likeliest silent-data-loss bug in this feature.
   Create a container with no shapes in it, save, reopen, and confirm it is still there **at the
   same position**. A container written without a size is dropped from the DSL front-matter.

3. **Accessibility gate** — zero violations, now including the admin screens and the new
   affordance:
   ```bash
   cd apps/web && npx playwright test tests/e2e/accessibility.spec.ts
   ```

4. **Canvas performance with containers present** — the gate must be exercised *with* containers,
   not just nodes:
   ```bash
   RUN_PERF_TESTS=1 npx playwright test tests/e2e/canvas-performance.spec.ts
   ```

5. **Full suite**:
   ```bash
   npm run build --workspace=@canvas/diagram-core
   npm run test --workspace=@canvas/diagram-core
   npm run test --workspace=@canvas/api
   cd apps/web && npx playwright test
   ```

---

## Two traps worth knowing before you start

**A container must always have a size.** The flowchart serializer writes container geometry with
`.filter((c) => c.size)` — a container without one is omitted from front-matter entirely and loses
its position on the next parse. Any code path that creates or modifies a container must leave a
size present.

**`status = 'retired'` is written in two places.** `retireStandard()` handles the explicit admin
action, but `publishStandard()` also auto-retires the previously published standard inside its
transaction. Both must set `retired_at`, or the more common supersession path silently produces
standards with no retirement date.
