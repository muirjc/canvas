"""The Python service reads the same schema the TypeScript service's migrations create."""

from sqlalchemy import Engine, text

from canvas_api.migrations import migration_dir, run_migrations


def test_every_migration_file_is_applied_once(engine: Engine) -> None:
    files = sorted(p.name for p in migration_dir(engine.dialect.name).glob("*.sql"))
    with engine.connect() as conn:
        recorded = sorted(row[0] for row in conn.execute(text("SELECT filename FROM schema_migrations")))
    assert recorded == files
    # Running again applies nothing.
    assert run_migrations(engine) == []


def test_core_tables_exist_and_are_queryable(engine: Engine) -> None:
    with engine.connect() as conn:
        for table in ("users", "projects", "diagrams", "diagram_versions", "sessions"):
            count = conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar_one()  # noqa: S608 - fixed names
            assert count >= 0


def test_foreign_keys_are_enforced(engine: Engine) -> None:
    from uuid import uuid4

    import pytest
    from sqlalchemy.exc import IntegrityError

    row = {"id": str(uuid4()), "diagram": str(uuid4()), "author": str(uuid4())}
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO diagram_versions (id, diagram_id, sequence_number, dsl_content, author_id) "
                "VALUES (:id, :diagram, 1, 'x', :author)"
            ),
            row,
        )
