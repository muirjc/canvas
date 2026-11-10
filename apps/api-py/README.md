# Canvas API (Python)

Canvas's backend: the API, its jobs, and the front door that serves the built web app. It replaced
the TypeScript API (`apps/api`) route group by route group (epic canvas-1bty,
[docs/python-backend-assessment.md](../../docs/python-backend-assessment.md)). Comments and
docstrings that cite `apps/api/...` refer to the TypeScript original at tag `typescript-api-final`
(`git show typescript-api-final:apps/api/<path>`).

Stack: Python 3.15, FastAPI, SQLAlchemy Core (Postgres or SQLite, never the ORM), pydantic, uv,
ruff, mypy, pytest.

```bash
cd apps/api-py
uv sync                                   # install (versions at least two weeks old, see pyproject)
cp .env.example .env                      # local settings (gitignored)
uv run --env-file .env python -m canvas_api.jobs.seed_demo                # migrate + demo data
uv run --env-file .env uvicorn canvas_api.main:app --port 3000 --reload   # the API on :3000
uv run pytest                             # Postgres: schema canvas_py in canvas_test on localhost:5433
TEST_DB_CLIENT=sqlite uv run pytest       # SQLite, in memory
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

The service reads only the process environment (`env_file=None` in `config.py`), so pass a local
`.env` with `--env-file`. Settings and defaults: `src/canvas_api/config.py`; the table is in
[RUNBOOK.md](../../RUNBOOK.md). The Postgres tests need a `canvas_test` database
(`docker compose exec postgres createdb -U canvas canvas_test`, once); each run recreates the
`canvas_py` schema in it, so don't run two at once.

Layout (`src/canvas_api/`):

- `app.py` builds the app; `main.py` is uvicorn's entry point (`canvas_api.main:app`).
- `routes/`: one module per route group (projects, diagrams, standards, export, github, ai, auth,
  library admin, ...).
- `front_door/`: serves `WEB_DIST_DIR` and the paused page (`CANVAS_PAUSED`), CORS for
  `WEB_ORIGINS`, security headers, and the route table (`route_groups.py`).
- `auth/`: sessions, Canvas passwords, lockout, TOTP and recovery codes, Entra OIDC with PKCE.
- `ai/`: the chat loop with the Anthropic/OpenAI SDKs or the rule-based mock (`mock_model.py`).
- `github/`: the GitHub App client, submissions and status sync (`sync_run.py`, the scheduled job).
- `diagram_core/`: the Python port of `packages/diagram-core` (every family's parse/serialize,
  validation, rendering, templates, the icon clean-up, embeds, the AI tools). Front matter is YAML
  written byte for byte as the `yaml` npm package writes it (`jsyaml.py`).
- `jobs/`: `python -m canvas_api.jobs.<name>`: `migrate`, `seed_catalog`, `seed_demo`,
  `bootstrap_admin`, `purge` (`--dry-run`), `e2e_reset`. Catalog data is in `seed/`.

The schema is the plain SQL in `migrations/` (Postgres) and `migrations/sqlite/` (SQLite), applied
by `migrations.py`. The API contract is `contract/openapi.json` and `contract/constants.json`: frozen,
and edited by hand together with the route it describes. `tests/api.py`'s client checks every
response a test gets against it, and every request the API accepted (body and query parameters);
`tests/test_contract.py` checks that each route's body and query parameters are in it.

The browser still runs the TypeScript diagram-core, so the Python port must keep matching it. The
TypeScript diagram-core bridge (`packages/diagram-bridge`) is the tests' reference: the tests start it
once per run (`bridge_url` in tests/conftest.py; `npm run build --workspace=@canvas/diagram-bridge`
first) and compare Python with it; they skip those comparisons when Node or the bundle is missing
(never in CI: `REQUIRE_BRIDGE=1`). The app itself never calls it (`tests/diagram_bridge.py` is the
client).

Query UUID columns with fixed `text()` statements: SQLAlchemy Core binds a string as VARCHAR, which
Postgres won't compare with a UUID.
