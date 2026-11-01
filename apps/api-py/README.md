# Canvas API (Python)

The backend is moving here from `apps/api` (TypeScript), route group by route group. Plan, phases
and decisions: [docs/python-backend-assessment.md](../../docs/python-backend-assessment.md)
(epic canvas-1bty). Until a route group moves, `apps/api` still serves it.

Stack: Python 3.13, FastAPI, SQLAlchemy Core (Postgres or SQLite, never the ORM), pydantic, uv,
ruff, mypy, pytest.

```bash
cd apps/api-py
uv sync                                   # install (versions at least two weeks old, see pyproject)
uv run pytest                             # Postgres: schema canvas_py in canvas_test on localhost:5433
TEST_DB_CLIENT=sqlite uv run pytest       # SQLite, in memory
uv run ruff check . && uv run ruff format --check . && uv run mypy
DB_CLIENT=sqlite DATABASE_URL=/tmp/canvas.db uv run uvicorn canvas_api.main:app --reload
```

Moved so far: projects, diagram types, the icon library list and search, app settings (phase 2,
canvas-1bty.6); comments, sharing and project members, admin users (not local accounts), the audit log
and user lookup (phase 3, canvas-1bty.7); diagrams, versions, presence, drafts, import and template
import (phase 4, canvas-1bty.8) -- see `apps/api/src/python/route-groups.ts`, which the
TypeScript front door forwards. Each route's shapes are held to `apps/api/contract/openapi.json`:
`tests/api.py`'s client checks every response a test gets against it. Routes not moved yet can't be
called from these tests, so tests seed those rows directly (`Api.diagram`, `Api.grant`, ...).

Diagram routes parse and validate through the diagram-core bridge; the tests start it once per run
(`bridge_url` in tests/conftest.py, `npm run build --workspace=@canvas/diagram-bridge` first) and skip
the tests that need it when Node or the bundle is missing.

Query UUID columns with fixed `text()` statements: SQLAlchemy Core binds a string as VARCHAR, which
Postgres won't compare with a UUID.

The schema comes from `apps/api/migrations` (plain SQL, shared by both services); there are no
Python-specific migrations.
