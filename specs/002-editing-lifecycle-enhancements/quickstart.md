# Quickstart: Editing & Lifecycle Enhancements

Builds on `specs/001-diagramming-platform/quickstart.md` — same setup, plus the new
`0003_diagram_soft_delete.sql` migration (applied automatically by the existing
`npm run migrate --workspace=@canvas/api`).

## Manual validation by user story

### US1 — Edit shape and connector labels

1. Open any diagram. Double-click a shape's label, change it, confirm the canvas and DSL panel
   both update immediately.
2. Connect two shapes if not already connected. Double-click the new connector (or its label
   area) and add a label; confirm it appears on the canvas and in the DSL.
3. Edit an existing connector label to a new value, then clear it entirely; confirm the DSL
   reflects an unlabeled connector.

### US2 — Delete shapes from the canvas

1. Select a shape with no connections; delete it (key or button) and confirm the deletion
   dialog; confirm it's gone from canvas and DSL.
2. Select a connected shape; delete it; confirm its connector is also gone (no dangling
   reference).
3. Select multiple shapes at once (shift-click) and delete them together in one confirmation.
4. Delete the last remaining shape in a group; confirm the now-empty group disappears too.
5. Start a delete, then cancel the confirmation; confirm nothing changed.

### US3 — Sign out

1. From any screen (main, editor, admin), confirm a Sign Out control is visible.
2. Click it; confirm you land on the sign-in screen.
3. Try to reload a previously-open diagram URL; confirm you're asked to sign in again.

### US4 — Delete and restore a diagram

1. As the owner, delete a diagram from the project browser, confirming the prompt.
2. Confirm it no longer appears in the project browser or search for you or anyone it was
   shared with.
3. As admin, visit the deleted-diagrams admin view and restore it; confirm it's fully back,
   unchanged, for the owner and prior collaborators.

### US5 — Broader Mermaid compatibility

1. Import a diagram starting with `graph TD` (instead of `flowchart TD`); confirm it imports
   identically to the flowchart-header equivalent.
2. Import a diagram containing `style A fill:#e1f5fe` lines; confirm the referenced node shows
   that fill color on the canvas.
3. Import a diagram containing a `%% this is a comment` line; confirm the comment doesn't block
   the import.
4. Import the exact example that originally failed:

   ```
   graph TD
       A[🚀 Welcome to Playground] --> B{Try Mermaid}
       B -->|Edit Code| C[📝 Live Preview]
       B -->|Love It?| D[✨ Sign Up]
       C --> E[🎯 See Changes Instantly]
       D --> F[💾 Save & Export]

       style A fill:#e1f5fe
       style D fill:#f3e5f5
       style F fill:#e8f5e8
   ```

   Confirm it imports successfully with A, D, and F showing their specified fill colors.

## Test commands

```bash
npm run test --workspace=@canvas/diagram-core     # graph alias / style directive / diagram-ops contract tests
npm run test --workspace=@canvas/api               # delete/restore + soft-delete-filtering contract tests
npm run test:e2e --workspace=@canvas/web           # sign-out, label-edit, delete-shape, delete/restore-diagram specs
```
