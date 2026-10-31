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

The schema comes from `apps/api/migrations` (plain SQL, shared by both services); there are no
Python-specific migrations.
