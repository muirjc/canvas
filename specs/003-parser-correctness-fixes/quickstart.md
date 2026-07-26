# Quickstart: Mermaid Parser Correctness Fixes

Builds on `specs/001-diagramming-platform/quickstart.md` and
`specs/002-editing-lifecycle-enhancements/quickstart.md` — same setup, no new migration, no new
service. All changes land in `packages/diagram-core`; rebuild it before testing against the API
or web app (`npm run build --workspace=@canvas/diagram-core`).

## Manual validation by user story

### US1 — Architecture diagrams with directional connections

1. Import an architecture diagram containing `serviceA:R --> L:serviceB`; confirm it imports
   successfully and the connection appears between the two services.
2. Import one containing `serviceA:R <-- L:serviceB`; confirm it imports successfully.
3. Save/export the imported diagram; confirm the re-exported DSL still shows the correct arrow
   direction and anchor hints.
4. Import a diagram using only the pre-existing plain `--` connector; confirm it still imports
   exactly as before.

### US2 — ER diagrams with attribute blocks

1. Import an ER diagram with an entity attribute block, e.g.:

   ```
   erDiagram
     CUSTOMER {
       string id PK
       string name
       string email UK
     }
   ```

   Confirm the `CUSTOMER` entity shows all three attributes with their types and key markers.
2. Export the diagram; confirm the attribute block reappears with the same types/names/keys.
3. Import an attribute line with an unrecognized constraint keyword or a trailing comment;
   confirm the import still succeeds.
4. Import an ER diagram with no attribute blocks (bare relationship lines only); confirm it still
   imports exactly as before.
5. Import an ER diagram with an entity's `{` left unclosed; confirm a specific, structured error
   identifies that entity and its opening line.

### US3 — Sequence diagrams with notes and control-flow blocks

1. Import a sequence diagram containing `Note over Alice, Bob: some text`; confirm the note
   appears on the canvas, associated with both participants.
2. Import one containing a `loop` wrapping two messages; confirm the loop's boundary/label
   appears on the canvas and both messages are inside it.
3. Import one with a nested block (e.g., an `alt` inside a `loop`); confirm both levels of
   nesting appear correctly.
4. Export any of the above; confirm the re-exported DSL reproduces the same notes/blocks/nesting
   in the same order as the original.
5. Import a sequence diagram using only the pre-existing bare `participant` + message form;
   confirm it still imports exactly as before.
6. Import a sequence diagram with a `loop` left unclosed (no matching `end`); confirm a specific,
   structured error identifies the block and its opening line.

### US4 — Comments everywhere

1. Import a sequence, class, ER, C4, or architecture diagram containing a `%%` comment line;
   confirm the import succeeds and the comment has no visible effect.
2. Confirm flowchart `%%` comment behavior (from feature 002) is unchanged.

## Test commands

```bash
npm run build --workspace=@canvas/diagram-core   # required before any of the below
npm run test --workspace=@canvas/diagram-core     # architecture/ERD/sequence/comments contract tests
npm run test --workspace=@canvas/api              # import API contract tests (existing suite, extended)
npm run test:e2e --workspace=@canvas/web          # one new import.spec.ts case (canvas rendering check)
```
