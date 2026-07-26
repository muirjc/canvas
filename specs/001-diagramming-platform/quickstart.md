# Quickstart: Governed Multi-Persona Diagramming Platform

The local dev workflow for the monorepo (`apps/web`, `apps/api`, `packages/diagram-core`), and a
manual validation walkthrough covering all six user stories. Uses npm workspaces (pnpm was
unavailable in the dev environment; npm workspaces is an equivalent substitute — see `.env.example`
files for the exact env vars each app needs).

## Local setup

```bash
# From repo root
npm install                                       # installs all three workspaces
npm run build --workspace=@canvas/diagram-core    # shared package must build before apps/api

docker compose up -d postgres                     # local Postgres, mapped to host port 5433
                                                   # (5432 may already be in use by another
                                                   # Postgres instance on the host)

# apps/api needs: DATABASE_URL, SESSION_SECRET (32+ chars), ALLOW_LOCAL_AUTH=true for local
# dev without a real OIDC provider, and WEB_ORIGINS matching wherever apps/web runs — copy
# apps/api/.env.example to apps/api/.env and adjust as needed, or export the vars directly:
export DATABASE_URL="postgres://canvas:canvas_dev_password@localhost:5433/canvas"
export SESSION_SECRET="change-me-to-a-random-string-of-at-least-32-characters"
export ALLOW_LOCAL_AUTH=true
export WEB_ORIGINS=http://localhost:5173

npm run migrate --workspace=@canvas/api           # apply DB schema
npm run seed --workspace=@canvas/api              # seed DiagramTypes, bundled icon/shape
                                                   # libraries, an admin + architect user, and
                                                   # a "Smoke Test" project — prints their ids
npm run dev --workspace=@canvas/api               # backend on :3000
npm run dev --workspace=@canvas/web                # frontend on :5173, in a second terminal
```

Then open `http://localhost:5173/?projectId=<the printed Smoke Test project id>`.

## Manual validation by user story

### US1 — Create and export a diagram

1. Sign in (`admin@example.com` / the password the seed script printed).
2. Click **New Diagram**, choose "Generic Flowchart".
3. On the canvas: add two shapes, connect them, add a text label, group them into a container.
   Confirm the live Mermaid DSL panel updates with every action (AS1).
4. Edit the DSL panel directly to add a third node; confirm the canvas re-renders it (AS2).
5. Click **Save**, then export Mermaid/SVG/PNG; confirm each file matches the canvas (AS3).
6. Add DSL text the parser can't map to a shape; confirm a specific error is shown, not a
   silent drop (AS4).

### US2 — Governance / standards enforcement

1. Visit `?admin=true`. Check some **Allowed shapes**, then **Create & Publish Standard**.
2. Create a diagram of that type using a non-approved shape; save it.
3. Confirm the save succeeds (soft-flag, FR-024) and the violation is listed with the specific
   element and rule (FR-013), not a generic pass/fail.

### US3 — Persona-specific diagram types & Azure/AWS icons

1. Click **New Diagram** and confirm the picker lists all built-in types (C4 levels, business
   capability map, sequence, ERD, UML, cloud infrastructure, etc.).
2. Open a "Cloud Infrastructure" diagram; search the palette for "Lambda" or "Blob Storage" and
   place the icon on the canvas. *(Bundled icon artwork is a clearly-labeled placeholder, not
   Microsoft's/AWS's actual proprietary icon files — see `packages/diagram-core/src/libraries/azure-icons.ts`.)*

### US4 — Organize & version diagrams

1. Save a diagram, edit it, save again — confirm a new entry appears in **Version History**.
2. Click **Restore** on an earlier version; confirm the canvas reflects that version's content
   and a *new* version is appended (history is never rewritten).
3. From the main screen, confirm the diagram is browsable/openable via the project tree.

### US5 — Import an existing Mermaid diagram

1. Click **Import Diagram**, paste or upload raw Mermaid text, click **Import**.
2. Confirm it renders correctly and is fully editable/exportable afterward.
3. Paste unrecognized text; confirm a specific error is shown (never a silent failure).

### US6 — Sharing & admin

1. Open a diagram you own, click **Share**, grant another user "view" access by email.
2. As that user, confirm you can open the diagram but editing/saving is blocked (403).
3. Upgrade the grant to "edit"; confirm the same save now succeeds.
4. As admin, visit `?admin=users` to change a user's role, or `?admin=overview` for the
   aggregated admin landing page.

## Test commands

```bash
npm run test --workspace=@canvas/diagram-core     # round-trip + validation + library contract tests
npm run test --workspace=@canvas/api              # HTTP contract tests (needs Postgres running;
                                                   # DATABASE_URL/SESSION_SECRET as above, NODE_ENV=test)
npm run test --workspace=@canvas/web              # unit tests
npm run test:e2e --workspace=@canvas/web          # Playwright: needs both dev servers running and
                                                   # E2E_PROJECT_ID=<seeded project id> set

# Opt-in, not part of the default suite (slower / environment-sensitive):
RUN_PERF_TESTS=1 npm run test --workspace=@canvas/api                                    # SC-007 search latency at 1,200 diagrams
RUN_PERF_TESTS=1 E2E_PROJECT_ID=<id> npm run test:e2e --workspace=@canvas/web -- canvas-performance
                                                                                           # 300-element canvas frame-rate check
E2E_PROJECT_ID=<id> npm run test:e2e --workspace=@canvas/web -- accessibility            # WCAG 2.1 AA audit (axe-core)
```
