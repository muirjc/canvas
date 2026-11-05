"""canvas-mywp: create_db_engine makes the SQLite file's folder, so a fresh `./data/canvas.db` opens."""

from pathlib import Path

import pytest
from sqlalchemy import text

from canvas_api.config import Settings
from canvas_api.db import create_db_engine


def _settings(database_url: str) -> Settings:
    return Settings(DB_CLIENT="sqlite", DATABASE_URL=database_url, SESSION_SECRET="x" * 32)  # type: ignore[arg-type]


def _select_one(settings: Settings) -> int:
    engine = create_db_engine(settings)
    try:
        with engine.connect() as connection:
            return connection.execute(text("SELECT 1")).scalar_one()
    finally:
        engine.dispose()


def test_a_missing_nested_folder_is_created(tmp_path: Path) -> None:
    database = tmp_path / "a" / "b" / "canvas.db"
    assert not database.parent.exists()
    assert _select_one(_settings(str(database))) == 1
    assert database.parent.is_dir()


def test_an_existing_folder_still_works(tmp_path: Path) -> None:
    database = tmp_path / "canvas.db"
    assert _select_one(_settings(str(database))) == 1
    assert database.exists()


def test_memory_database_creates_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert _select_one(_settings(":memory:")) == 1
    assert list(tmp_path.iterdir()) == []
