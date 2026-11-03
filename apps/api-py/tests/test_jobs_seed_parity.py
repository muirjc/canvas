"""The Python catalog seed against the TypeScript one (apps/api/src/seed/catalog.ts, `npm run seed:catalog`): each
seeds a fresh database of the suite's engine (Postgres schema or SQLite file), and every table's rows must match.

Generated values that TypeScript would also vary are normalised: timestamps become "set or not", a standard's id
becomes its type and version, a persona's id its name, any other uuid "<uuid>". JSON columns compare as values
(Postgres stores JSONB) and, on SQLite, as the stored text too. Then the Python seed runs again over the TypeScript
database (a deployment switching services) and must change nothing.

Skipped without Node and apps/api's installed dependencies (tsx); goes away with apps/api in phase 12b.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.seed import seed_catalog
from canvas_api.seed.libraries import DEFAULT_AWS_ICONS_MANIFEST
from tests.conftest import PG_DATABASE, TEST_SESSION_SECRET
from tests.seed_helpers import compare_dumps, dump_tables

REPO = Path(__file__).resolve().parents[3]
TSX = REPO / "node_modules" / ".bin" / "tsx"
pytestmark = pytest.mark.skipif(
    shutil.which("npm") is None or not TSX.exists() or not (REPO / "apps" / "api" / "src" / "seed").is_dir(),
    reason="needs Node and the TypeScript service (npm ci at the repository root)",
)


class Databases:
    def __init__(self, base: Settings, tmp_path: Path) -> None:
        self.base = base
        self.tmp_path = tmp_path
        self.schemas: list[str] = []

    def fresh(self, name: str) -> Settings:
        if self.base.db_client == "sqlite":
            return self.base.model_copy(update={"database_url": str(self.tmp_path / f"{name}.db")})
        schema = f"canvas_py_seed_{name}"
        with psycopg.connect(PG_DATABASE, autocommit=True) as conn:
            conn.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            conn.execute(f"CREATE SCHEMA {schema}")
        self.schemas.append(schema)
        return self.base.model_copy(update={"database_url": f"{PG_DATABASE}?options=-csearch_path%3D{schema}"})

    def drop(self) -> None:
        with psycopg.connect(PG_DATABASE, autocommit=True) as conn:
            for schema in self.schemas:
                conn.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")


@pytest.fixture()
def databases(settings: Settings, tmp_path: Path) -> Iterator[Databases]:
    dbs = Databases(settings, tmp_path)
    yield dbs
    if dbs.schemas:
        dbs.drop()


def _typescript_seed(settings: Settings, aws_manifest: str | None) -> None:
    env = {k: v for k, v in os.environ.items() if k not in ("NODE_ENV", "TEST_DB_CLIENT", "AWS_ICONS_MANIFEST")}
    env.update({"DB_CLIENT": settings.db_client, "DATABASE_URL": settings.database_url})
    env["SESSION_SECRET"] = TEST_SESSION_SECRET
    if aws_manifest is not None:
        env["AWS_ICONS_MANIFEST"] = aws_manifest
    result = subprocess.run(
        ["npm", "run", "seed:catalog", "--workspace=@canvas/api"],  # noqa: S607 - test only
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Catalog seed complete" in result.stdout


@pytest.mark.parametrize("aws", ["placeholder", "generated"])
def test_python_catalog_seed_writes_what_typescript_writes(
    aws: str, databases: Databases, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AWS_ICONS_MANIFEST", raising=False)
    if aws == "generated" and not DEFAULT_AWS_ICONS_MANIFEST.is_file():
        pytest.skip("no generated vendor-icons/aws-icons.json here")
    aws_path = str(databases.tmp_path / "no-such-aws-icons.json") if aws == "placeholder" else None

    ts_settings = databases.fresh("ts")
    _typescript_seed(ts_settings, aws_path)
    py_settings = databases.fresh("py")
    py_engine = create_db_engine(py_settings)
    ts_engine = create_db_engine(ts_settings)
    try:
        seed_catalog(py_engine, aws_icons_manifest_path=aws_path)
        ts_dump = dump_tables(ts_engine)
        py_dump = dump_tables(py_engine)
        compare_dumps(ts_dump, py_dump)
        assert ts_dump["standards"], "nothing seeded"
        aws_versions = {dict(r)["version"] for r in ts_dump["icon_libraries"] if dict(r)["id"] == "aws-icons"}
        assert aws_versions == {"2024.1"}

        # Python taking over a database TypeScript seeded: nothing changes.
        seed_catalog(ts_engine, aws_icons_manifest_path=aws_path)
        compare_dumps(ts_dump, dump_tables(ts_engine))
    finally:
        py_engine.dispose()
        ts_engine.dispose()
