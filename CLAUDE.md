# canvas Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-07-26

## Active Technologies
- No new technology added in 003-parser-correctness-fixes — it extends `packages/diagram-core`
  only (no new package, no persistence/schema changes; every new model field is optional and
  reuses the existing `DiagramContainer`/`DiagramEdge`/`DiagramNode` entities).

- TypeScript 5.x end-to-end: React frontend, Fastify backend, Node.js 22 LTS. Shared
  `diagram-core` package (Mermaid DSL parser/serializer/validator) used identically by frontend
  and backend. PostgreSQL + a blob store for icon/shape library assets. (001-diagramming-platform)
- No new technology added in 002-editing-lifecycle-enhancements — it extends the same stack
  (one additive Postgres migration for diagram soft-delete; no new packages/services).

## Project Structure

```text
apps/web/src/{canvas,palette,standards,admin,projects,app}   # frontend
apps/api/src/{diagrams,standards,libraries,projects,sharing,admin,export,auth}  # backend
packages/diagram-core/src/{model,dsl,standards,libraries}    # shared parser/serializer/validator
```

## Commands

npm run test --workspace=@canvas/diagram-core && npm run test --workspace=@canvas/api && npm run test --workspace=@canvas/web

## Code Style

TypeScript, standard conventions. `diagram-core` round-trip and standards-validation contract
tests are NON-NEGOTIABLE and must exist (and fail) before implementing any diagram-type or export
work — see `.specify/memory/constitution.md` Principle IV.

## Recent Changes
- 003-parser-correctness-fixes: Architecture parser now parses `-->`/`<--` connections (previously
  a hard defect — only plain `--` worked); ER diagrams support attribute blocks (`{ type name
  PK/FK/UK }`); sequence diagrams support notes and nestable control-flow blocks (`loop`/`alt`/
  `opt`/`par`/`critical`/`break`); and `%%` comments are now honored in every parser, not just
  flowchart's.
- 002-editing-lifecycle-enhancements: Sign-out control, shape/connector label editing, shape
  deletion (with confirmation), diagram soft-delete + admin restore, and flowchart parser
  extensions (`graph` header alias, `style` directive, `%%` comments).
- 001-diagramming-platform: Added TypeScript/React/Fastify web app + shared diagram-core package
  for a governed, multi-persona (Business/Enterprise/Solution/Technical Architect) diagramming
  platform with Mermaid DSL/SVG/PNG export and Azure/AWS icon libraries.

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
