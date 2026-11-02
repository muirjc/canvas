"""Test databases: TEST_DB_CLIENT=postgres|sqlite, like the TypeScript suite.

Postgres uses its own schema, canvas_py, inside the TypeScript tests' database (canvas_test on
localhost:5433, locally and in CI), so both suites can run on one machine without touching each
other's tables. The schema is recreated for each test session.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from canvas_api.app import create_app
from canvas_api.config import Settings
from canvas_api.db import create_db_engine
from canvas_api.github.validator_bundle import reset_cache
from canvas_api.migrations import run_migrations
from tests.fake_github import FakeGitHub

#: The TypeScript tests' fixed session secret (apps/api/src/config.ts TEST_SESSION_SECRET).
TEST_SESSION_SECRET = "test-secret-at-least-32-characters-long"
PG_DATABASE = "postgresql://canvas:canvas_dev_password@localhost:5433/canvas_test"
PG_SCHEMA = "canvas_py"


def _fresh_postgres() -> str:
    with psycopg.connect(PG_DATABASE, autocommit=True) as conn:
        conn.execute(f"DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE")
        conn.execute(f"CREATE SCHEMA {PG_SCHEMA}")
    return f"{PG_DATABASE}?options=-csearch_path%3D{PG_SCHEMA}"


#: canvas-1bty.8: the diagram-core bridge (packages/diagram-bridge), for routes that parse or validate.
BRIDGE_BUNDLE = Path(__file__).resolve().parents[3] / "packages" / "diagram-bridge" / "dist" / "bridge.mjs"
BRIDGE_AVAILABLE = shutil.which("node") is not None and BRIDGE_BUNDLE.exists()
if not BRIDGE_AVAILABLE and os.environ.get("REQUIRE_BRIDGE") == "1":
    raise RuntimeError("REQUIRE_BRIDGE=1 but node or packages/diagram-bridge/dist/bridge.mjs is missing")


@pytest.fixture(scope="session")
def bridge_url() -> Iterator[str | None]:
    """One bridge process for the whole run, or None without Node and the built bundle."""
    if not BRIDGE_AVAILABLE:
        yield None
        return
    proc = subprocess.Popen(  # noqa: S603 - fixed command, test only
        ["node", str(BRIDGE_BUNDLE)],  # noqa: S607
        env={**os.environ, "BRIDGE_PORT": "0", "BRIDGE_HOST": "127.0.0.1"},
        stdout=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    line = proc.stdout.readline()
    match = re.search(r":(\d+)$", line.strip())
    assert match, f"unexpected bridge output: {line!r}"
    yield f"http://127.0.0.1:{match.group(1)}"
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture()
def needs_bridge(bridge_url: str | None) -> str:
    """Skips a test that needs the bridge when it isn't available (never in CI: REQUIRE_BRIDGE=1)."""
    if bridge_url is None:
        pytest.skip("needs node and packages/diagram-bridge/dist/bridge.mjs")
    return bridge_url


@pytest.fixture(scope="session")
def settings(bridge_url: str | None) -> Settings:
    client = os.environ.get("TEST_DB_CLIENT", "postgres")
    common = {"SESSION_SECRET": TEST_SESSION_SECRET, **({"DIAGRAM_BRIDGE_URL": bridge_url} if bridge_url else {})}
    if client == "sqlite":
        return Settings(DB_CLIENT="sqlite", DATABASE_URL=":memory:", **common)
    return Settings(DB_CLIENT="postgres", DATABASE_URL=_fresh_postgres(), **common)


@pytest.fixture(scope="session")
def engine(settings: Settings) -> Iterator[Engine]:
    engine = create_db_engine(settings)
    run_migrations(engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def client(settings: Settings, engine: Engine) -> Iterator[TestClient]:
    with TestClient(create_app(settings, engine)) as test_client:
        yield test_client


@pytest.fixture()
def api(client: TestClient, engine: Engine) -> Iterator[Any]:
    """A clean database and a contract-checking client (tests/api.py)."""
    from tests.api import Api, reset

    reset(engine)
    yield Api(client, engine)


@pytest.fixture(scope="session")
def fake_github() -> FakeGitHub:
    """The in-memory GitHub (tests/fake_github.py); its App key is generated once per run."""
    return FakeGitHub()


def github_settings(base: Settings, fake: FakeGitHub, validator_dir: Path) -> Settings:
    """Settings for an app wired to the fake GitHub. CANVAS_VALIDATOR_DIR always points somewhere (an empty
    directory by default): unlike the TypeScript service, Python has no NODE_ENV=test switch that keeps a
    locally built validator out of the results."""
    return base.model_copy(
        update={
            "github_app_id": fake.app_id,
            "github_app_private_key": fake.private_key_pem(),
            "github_app_api_url": fake.url,
            "canvas_public_url_setting": "http://canvas.test",
            "canvas_validator_dir": str(validator_dir),
        }
    )


@pytest.fixture(scope="session")
def github_engine(settings: Settings, engine: Engine, tmp_path_factory: pytest.TempPathFactory) -> Iterator[Engine]:
    """The GitHub tests' database. Postgres: the usual one. SQLite: a file, not :memory:, because the in-memory
    engine shares ONE connection between all threads, and these tests send simultaneous requests (a real
    SQLite deployment uses a file, with a connection per thread, as better-sqlite3 never interleaves)."""
    if settings.db_client != "sqlite":
        yield engine
        return
    file_settings = settings.model_copy(update={"database_url": str(tmp_path_factory.mktemp("sqlite") / "canvas.db")})
    file_engine = create_db_engine(file_settings)
    run_migrations(file_engine)
    yield file_engine
    file_engine.dispose()


@pytest.fixture()
def github(
    settings: Settings, github_engine: Engine, fake_github: FakeGitHub, tmp_path: Path, needs_bridge: str
) -> Iterator[Any]:
    """A clean database and an app wired to the fake GitHub, with its installation, two repositories and users."""
    from tests.api import Api, reset
    from tests.github_helpers import GH

    engine = github_engine
    empty = tmp_path / "validator-none"
    empty.mkdir()
    reset(engine)
    fake_github.reset()
    reset_cache()
    app = create_app(github_settings(settings, fake_github, empty), engine, fake_github.transport())
    with TestClient(app) as test_client:
        yield GH(Api(test_client, engine), app, fake_github, engine, tmp_path, needs_bridge)
    reset_cache()


@pytest.fixture()
def scripted(client: TestClient) -> Any:
    """The AI chat's language model replaced by a scripted one (tests/ai_helpers.py); needs the bridge for the tools."""
    from tests.ai_helpers import ScriptedModel

    model = ScriptedModel()
    client.app.state.language_model = model.factory  # type: ignore[attr-defined]
    return model


@pytest.fixture()
def ai_env(client: TestClient, settings: Settings) -> Any:
    """Switches the app's AI provider settings (like setting AI_PROVIDER and friends in the environment).

    Starts unconfigured (no provider, key or model), whatever the machine's environment says; call it with
    keyword arguments (`ai_provider="anthropic", anthropic_api_key=...`) to change them.
    """
    from canvas_api.ai.model_list import clear_cache

    blank = {"ai_provider": None, "ai_model": None, "anthropic_api_key": None, "openai_api_key": None}

    def use(**changes: Any) -> Settings:
        current: Settings = settings.model_copy(update={**blank, **changes})
        client.app.state.settings = current  # type: ignore[attr-defined]
        return current

    clear_cache()
    use()
    yield use
    clear_cache()
