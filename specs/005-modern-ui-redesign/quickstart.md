# Quickstart: Modern UI Redesign

Builds on `specs/001-diagramming-platform/quickstart.md`. This feature adds **no** setup step —
no migration, no seed, no environment variable, no dependency install. If the app runs today, it
runs this feature.

```bash
docker compose up -d
npm run build --workspace=@canvas/diagram-core
npm run dev --workspace=@canvas/api     # separate terminal
npm run dev --workspace=@canvas/web     # separate terminal
```

Sign in at `http://localhost:5173/?projectId=<seed-printed-id>` as
`admin@example.com` / `admin-dev-password`.

> Validate at a **1440×900** window — the primary supported size. A few checks below are about
> what fits on screen without scrolling, and a smaller window will fail them legitimately.

---

## Manual validation by user story

### US1 — A credible, consistent interface

1. Visit login, home, the diagram editor, and each admin screen.
2. Confirm no screen renders in browser defaults — **serif body text anywhere means the
   stylesheet is not loading**.
3. Compare a primary button on two different screens; confirm they are identical.
4. Open an admin screen (e.g. `?admin=users`). Confirm the table, dropdowns, and checkboxes are
   styled and legible **even though no admin file was edited** — this is bare-element styling
   from `base.css` doing its job.
5. Tab through a form. Confirm every control shows a clearly visible focus indicator.

### US2 — A focused diagram editing workspace

1. Open a diagram. Without scrolling, confirm you can see: the diagram name, save control, save
   status, Export, and Share.
2. Confirm the canvas is the largest region on screen.
3. Confirm the **DSL panel is the panel showing by default**.
4. Switch to Chat, Issues, and History in turn — each in one click, with no scrolling and without
   leaving the diagram.
5. Type an unsent message into Chat, switch to DSL, switch back. **The draft must still be
   there** and the conversation must not have reloaded.
6. Open a diagram that violates its standard. Confirm the violation count is visible on the
   Issues tab *before* you open it.
7. Confirm the palette shows shape, tool, and icon controls under separate labels.
8. Toggle connect mode. Confirm its active state is visually obvious.

### US3 — Dialogs that preserve context

1. From home, click New Diagram. Confirm the dialog overlays the screen with the previous
   context still visible behind it.
2. Press Tab repeatedly. Confirm focus never leaves the dialog.
3. Press `Escape`. Confirm it closes and nothing was created.
4. Confirm focus returned to the New Diagram button.
5. Repeat for Import, Share, Create via AI Chat, and the delete confirmation.
6. On the delete confirmation, confirm the destructive action is visually distinct and names what
   is being deleted.

### US4 — Clear feedback in every state

1. Search the icon palette for nonsense (`zzzz`). Confirm a specific "no results" message, not a
   blank area.
2. Open a diagram with no violations — confirm an explicit "no violations" state.
3. Open a never-saved diagram — confirm History shows an explicit empty state.
4. Open a diagram never chatted with — confirm Chat shows a prompt to start, not a blank panel.
5. Stop the API (`Ctrl-C`) and reload. Confirm panels report failure and offer retry rather than
   hanging empty.
6. Enable "reduce motion" in your OS, reload, and confirm no animation plays.

---

## Regression checks (the ones most likely to catch a real mistake)

1. **Exports unchanged** — the core guarantee behind SC-004:
   ```bash
   git diff --stat main -- packages/diagram-core/src/render/   # MUST be empty
   ```
   Then export a diagram to SVG and PNG and confirm both still match the canvas.

2. **Accessibility gate** — zero violations, the same bar as today:
   ```bash
   cd apps/web && npx playwright test tests/e2e/accessibility.spec.ts
   ```

3. **Canvas performance** — must not regress:
   ```bash
   RUN_PERF_TESTS=1 npx playwright test tests/e2e/canvas-performance.spec.ts
   ```
   If this fails, the usual cause is a shadow, filter, or transition applied to diagram nodes.

4. **Admin-defined colors still truthful** — as admin, set a standard color palette, apply it,
   and confirm shapes render exactly those colors and remain the dominant color on the canvas
   (FR-027).

5. **Full suite**:
   ```bash
   npm run build --workspace=@canvas/diagram-core
   npm run test --workspace=@canvas/diagram-core     # 115
   npm run test --workspace=@canvas/api              # 80
   cd apps/web && npx playwright test                # 33
   ```

---

## Re-verifying contrast after any token change

The palette is pre-verified at 23/23 pairs passing. **If you change a color token, re-run the
check** — the accessibility gate is a build failure, not a review comment, and the first draft of
this palette had three failures that visual inspection would not reliably have caught.

The one rule most likely to be broken by accident: **a form control's border must use
`--border-control`** (3.59:1). The softer `--border-default` (1.52:1) and `--border-subtle`
(1.25:1) are decorative separators only. Swapping one in to soften an input's look produces
something that looks fine and fails WCAG 1.4.11.
