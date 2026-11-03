"""The catalog seed (canvas_api/seed, jobs/seed_catalog.py) and the demo seed (jobs/seed_demo.py), ports of
apps/api/src/seed/{catalog,diagram-types.seed,reference-standards.seed,libraries.seed,ai-personas.seed,run}.ts.
Each test gets an empty database of its own (tests/job_helpers.py). The comparison with the TypeScript seed itself is
test_jobs_seed_parity.py."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, text

from canvas_api.auth.passwords import verify_password
from canvas_api.catalog import BUILTIN_DIAGRAM_TYPE_IDS
from canvas_api.diagram_core import DiagramCore
from canvas_api.jobs import seed_catalog as seed_catalog_job
from canvas_api.jobs import seed_demo as seed_demo_job
from canvas_api.seed import seed_catalog
from canvas_api.seed.diagram_types import DIAGRAM_TYPES
from canvas_api.seed.libraries import AwsIconsManifestError, bundled_manifest
from canvas_api.seed.reference_standards import BUILT_IN_STANDARDS, seed_reference_standards
from tests.job_helpers import JobDb, job_db_fixture  # noqa: F401 - fixture
from tests.seed_helpers import compare_dumps, dump_tables

CONTRACT_CONSTANTS = Path(__file__).resolve().parents[1] / "contract" / "constants.json"


@pytest.fixture()
def no_aws(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """Seeds the bundled AWS placeholders, whatever vendor-icons/ holds on this machine."""
    path = str(tmp_path / "no-aws-icons.json")
    monkeypatch.setenv("AWS_ICONS_MANIFEST", path)
    return path


def _rows(engine: Engine, sql: str, **params: Any) -> list[Any]:
    with engine.connect() as conn:
        return list(conn.execute(text(sql), params).all())


# --- data ----------------------------------------------------------------------------------------------------


def test_the_seeded_type_ids_are_the_contracts_built_in_ids() -> None:
    """canvas_api.catalog and the contract's constants.json list the same ids as the seed."""
    ids = [t.id for t in DIAGRAM_TYPES]
    assert ids == list(BUILTIN_DIAGRAM_TYPE_IDS)
    assert ids == json.loads(CONTRACT_CONSTANTS.read_text(encoding="utf-8"))["builtinDiagramTypeIds"]


def test_every_built_in_standard_is_for_a_built_in_type_and_passes_the_definition_check() -> None:
    families = {t.id: t.dsl_family for t in DIAGRAM_TYPES}
    core = DiagramCore()
    assert len({s["diagramTypeId"] for s in BUILT_IN_STANDARDS}) == len(BUILT_IN_STANDARDS)
    for standard in BUILT_IN_STANDARDS:
        family = families[standard["diagramTypeId"]]
        assert core.check_standard(standard["rules"], family) == [], standard["diagramTypeId"]


def test_the_bundled_manifests_load() -> None:
    core = DiagramCore()
    for name, count in (("generic", 5), ("azure-icons", 257), ("aws-icons", 8), ("mermaid-architecture", 5)):
        loaded = core.load_library(bundled_manifest(name))
        assert loaded["ok"], name
        assert len(loaded["library"]["icons"]) == count


# --- the catalog seed ----------------------------------------------------------------------------------------


def test_the_catalog_seed_fills_an_empty_database_and_a_second_run_changes_nothing(job_db: JobDb, no_aws: str) -> None:
    seed_catalog(job_db.engine)
    first = dump_tables(job_db.engine)
    assert len(first["diagram_types"]) == len(DIAGRAM_TYPES)
    assert len(first["standards"]) == len(BUILT_IN_STANDARDS)
    assert {dict(r)["status"] for r in first["standards"]} == {"published"}
    assert len(first["ai_personas"]) == 4
    libraries = {(dict(r)["id"], dict(r)["version"]) for r in first["icon_libraries"]}
    assert libraries == {
        ("generic", "1.0.0"),
        ("azure-icons", "2024.1"),
        ("aws-icons", "2024.1"),
        ("mermaid-architecture", "1.0.0"),
    }
    assert {dict(r)["origin"] for r in first["icon_libraries"]} == {"builtin"}
    assert first["schema_migrations"]

    seed_catalog(job_db.engine)
    compare_dumps(first, dump_tables(job_db.engine))


def test_palette_and_personas_keep_the_seeds_order(job_db: JobDb, no_aws: str) -> None:
    seed_catalog(job_db.engine)
    palette = _rows(
        job_db.engine,
        "SELECT library_id FROM diagram_type_palette_libraries WHERE diagram_type_id = 'network' ORDER BY position",
    )
    assert [r.library_id for r in palette] == ["mermaid-architecture", "azure-icons", "aws-icons"]
    assert not _rows(job_db.engine, "SELECT * FROM diagram_type_palette_libraries WHERE diagram_type_id = 'c4-context'")
    personas = _rows(
        job_db.engine,
        "SELECT persona FROM diagram_types_personas WHERE diagram_type_id = 'value-chain' ORDER BY position",
    )
    assert [r.persona for r in personas] == ["Business", "Enterprise"]


def test_an_admin_edited_or_custom_type_is_never_overwritten(job_db: JobDb, no_aws: str) -> None:
    seed_catalog(job_db.engine)
    with job_db.engine.begin() as conn:
        conn.execute(
            text("UPDATE diagram_types SET name = 'Our flowchart', admin_edited = :yes WHERE id = 'flowchart'"),
            {"yes": True},
        )
        conn.execute(text("DELETE FROM diagram_types_personas WHERE diagram_type_id = 'flowchart' AND position > 0"))
        conn.execute(text("DELETE FROM diagram_type_palette_libraries WHERE diagram_type_id = 'flowchart'"))
        # An admin-made type that took a built-in id (as if the built-in came later).
        conn.execute(text("UPDATE diagram_types SET name = 'Mine', origin = 'custom' WHERE id = 'roadmap'"))
        conn.execute(text("DELETE FROM diagram_types_personas WHERE diagram_type_id = 'roadmap'"))
        # An untouched built-in type is restored to the catalog.
        conn.execute(text("UPDATE diagram_types SET name = 'Drifted' WHERE id = 'erd'"))

    seed_catalog(job_db.engine)
    names = {r.id: r.name for r in _rows(job_db.engine, "SELECT id, name FROM diagram_types")}
    assert names["flowchart"] == "Our flowchart"
    assert names["roadmap"] == "Mine"
    assert names["erd"] == "Entity-Relationship Diagram"
    personas = _rows(job_db.engine, "SELECT persona FROM diagram_types_personas WHERE diagram_type_id = 'flowchart'")
    assert [r.persona for r in personas] == ["Business"]
    assert not _rows(job_db.engine, "SELECT * FROM diagram_type_palette_libraries WHERE diagram_type_id = 'flowchart'")
    assert not _rows(job_db.engine, "SELECT * FROM diagram_types_personas WHERE diagram_type_id = 'roadmap'")


def test_standards_are_seeded_only_into_types_with_none(job_db: JobDb, no_aws: str) -> None:
    seed_catalog(job_db.engine)
    with job_db.engine.begin() as conn:
        # A retired standard is still a standard: the type is left alone (a deliberate retire stays).
        conn.execute(text("UPDATE standards SET status = 'retired' WHERE diagram_type_id = 'erd'"))
        # A type that lost its standards somehow gets one again.
        for table in ("standard_allowed_shapes", "standard_mandatory_shapes"):
            conn.execute(
                text(
                    f"DELETE FROM {table} WHERE standard_id IN"  # noqa: S608 - fixed names
                    " (SELECT id FROM standards WHERE diagram_type_id = 'uml')"
                )
            )
        conn.execute(text("DELETE FROM standards WHERE diagram_type_id = 'uml'"))
    assert seed_reference_standards(job_db.engine, DiagramCore()) == ["uml"]
    assert seed_reference_standards(job_db.engine, DiagramCore()) == []
    erd = _rows(job_db.engine, "SELECT status FROM standards WHERE diagram_type_id = 'erd'")
    assert [r.status for r in erd] == ["retired"]
    uml = _rows(job_db.engine, "SELECT version, status, name FROM standards WHERE diagram_type_id = 'uml'")
    assert [(r.version, r.status, r.name) for r in uml] == [(1, "published", "UML Class Diagram (starter)")]
    shapes = _rows(
        job_db.engine,
        "SELECT s.shape_id FROM standard_allowed_shapes s JOIN standards t ON t.id = s.standard_id"
        " WHERE t.diagram_type_id = 'uml' ORDER BY s.position",
    )
    assert shapes


def test_a_seeded_standard_rechecks_the_types_existing_diagrams(job_db: JobDb, no_aws: str) -> None:
    """revalidateDiagramsForType after publishing: a value-chain diagram drawn before the standard existed."""
    from canvas_api.migrations import run_migrations

    run_migrations(job_db.engine)
    with job_db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO diagram_types (id, name, abstraction_level, dsl_family)"
                " VALUES ('value-chain', 'x', 'N/A', 'flowchart')"
            )
        )
        conn.execute(
            text("INSERT INTO users (id, name, email, role) VALUES (:id, 'U', 'u@example.com', 'admin')"),
            {"id": "00000000-0000-4000-8000-000000000001"},
        )
        conn.execute(
            text("INSERT INTO projects (id, name, owner_id) VALUES (:id, 'P', :owner)"),
            {"id": "00000000-0000-4000-8000-000000000002", "owner": "00000000-0000-4000-8000-000000000001"},
        )
        conn.execute(
            text(
                "INSERT INTO diagrams (id, project_id, diagram_type_id, name, owner_id)"
                " VALUES (:id, :project, 'value-chain', 'D', :owner)"
            ),
            {
                "id": "00000000-0000-4000-8000-000000000003",
                "project": "00000000-0000-4000-8000-000000000002",
                "owner": "00000000-0000-4000-8000-000000000001",
            },
        )
        conn.execute(
            text(
                "INSERT INTO diagram_versions (id, diagram_id, sequence_number, dsl_content, author_id)"
                " VALUES (:id, :diagram, 1, :dsl, :owner)"
            ),
            {
                "id": "00000000-0000-4000-8000-000000000004",
                "diagram": "00000000-0000-4000-8000-000000000003",
                "dsl": "flowchart LR\n  A[Just a box]\n",
                "owner": "00000000-0000-4000-8000-000000000001",
            },
        )
        conn.execute(
            text("UPDATE diagrams SET current_version_id = :v WHERE id = :d"),
            {"v": "00000000-0000-4000-8000-000000000004", "d": "00000000-0000-4000-8000-000000000003"},
        )
    seed_catalog(job_db.engine)
    row = _rows(job_db.engine, "SELECT last_validation_result, standard_version_at_last_check FROM diagrams")[0]
    violations = (
        json.loads(row.last_validation_result)
        if isinstance(row.last_validation_result, str)
        else row.last_validation_result
    )
    assert row.standard_version_at_last_check == 1
    assert {v["rule"] for v in violations} >= {"unknown-kind", "kind-min-count"}


def test_the_seed_keeps_an_admins_library_changes(job_db: JobDb, no_aws: str) -> None:
    seed_catalog(job_db.engine)
    with job_db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE icon_libraries SET display_name = 'Azure', retired_at = CURRENT_TIMESTAMP"
                " WHERE id = 'azure-icons'"
            )
        )
        conn.execute(
            text(
                "UPDATE icons SET display_name = 'Edited', retired_at = CURRENT_TIMESTAMP"
                " WHERE library_id = 'generic' AND id = 'circle'"
            )
        )
    seed_catalog(job_db.engine)
    library = _rows(
        job_db.engine, "SELECT display_name, retired_at, origin FROM icon_libraries WHERE id = 'azure-icons'"
    )[0]
    assert library.display_name == "Azure"
    assert library.retired_at is not None
    assert library.origin == "builtin"
    icon = _rows(
        job_db.engine, "SELECT display_name, retired_at FROM icons WHERE library_id = 'generic' AND id = 'circle'"
    )[0]
    # The icon's artwork and name follow the manifest; its retirement is the admin's.
    assert icon.display_name == "Circle"
    assert icon.retired_at is not None


def test_the_legacy_aws_placeholder_version_is_removed(job_db: JobDb, no_aws: str) -> None:
    seed_catalog(job_db.engine)
    with job_db.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO icon_libraries (id, version, origin) VALUES ('aws-icons', '2024.1-placeholder', 'builtin')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO icons (library_id, library_version, id, display_name, category, asset_ref)"
                " VALUES ('aws-icons', '2024.1-placeholder', 'ec2', 'EC2', 'Compute', 'x')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO icon_keywords (library_id, library_version, icon_id, keyword, position)"
                " VALUES ('aws-icons', '2024.1-placeholder', 'ec2', 'vm', 0)"
            )
        )
    seed_catalog(job_db.engine)
    assert _rows(job_db.engine, "SELECT * FROM icon_libraries WHERE version = '2024.1-placeholder'") == []
    assert _rows(job_db.engine, "SELECT * FROM icons WHERE library_version = '2024.1-placeholder'") == []
    assert _rows(job_db.engine, "SELECT * FROM icon_keywords WHERE library_version = '2024.1-placeholder'") == []


def _aws_manifest(tmp_path: Path, **changes: Any) -> str:
    manifest = {
        "id": "aws-icons",
        "version": "2024.1",
        "license": "AWS terms",
        "icons": [
            {
                "id": "lambda",
                "displayName": "AWS Lambda",
                "keywords": ["serverless"],
                "category": "Compute",
                "assetRef": "<rect/>",
            }
        ],
    }
    manifest.update(changes)
    path = tmp_path / "aws-icons.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return str(path)


def test_a_generated_aws_manifest_replaces_the_placeholders(job_db: JobDb, tmp_path: Path) -> None:
    seed_catalog(job_db.engine, aws_icons_manifest_path=_aws_manifest(tmp_path))
    icons = _rows(job_db.engine, "SELECT id FROM icons WHERE library_id = 'aws-icons'")
    assert [r.id for r in icons] == ["lambda"]
    assert _rows(job_db.engine, "SELECT license FROM icon_libraries WHERE id = 'aws-icons'")[0].license == "AWS terms"


def test_the_aws_manifest_path_comes_from_the_environment(
    job_db: JobDb, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AWS_ICONS_MANIFEST", _aws_manifest(tmp_path))
    seed_catalog(job_db.engine)
    assert [r.id for r in _rows(job_db.engine, "SELECT id FROM icons WHERE library_id = 'aws-icons'")] == ["lambda"]


@pytest.mark.parametrize(
    ("changes", "shown"),
    [({"version": "2023.9"}, "aws-icons@2023.9"), ({"id": "aws"}, "aws@2024.1"), ({"version": None}, "aws-icons@null")],
)
def test_a_generated_aws_manifest_of_the_wrong_version_is_refused(
    job_db: JobDb,
    tmp_path: Path,
    changes: dict[str, Any],
    shown: str,
) -> None:
    path = _aws_manifest(tmp_path, **changes)
    with pytest.raises(AwsIconsManifestError) as error:
        seed_catalog(job_db.engine, aws_icons_manifest_path=path)
    assert str(error.value) == (
        f"{path} is {shown}; expected aws-icons@2024.1. "
        "Regenerate it with packages/diagram-core/scripts/generate-aws-icons.mjs."
    )


def test_an_existing_persona_is_never_changed(job_db: JobDb, no_aws: str) -> None:
    seed_catalog(job_db.engine)
    with job_db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE ai_personas SET system_prompt = 'Edited', status = 'archived' WHERE name = 'Solution Architect'"
            )
        )
        conn.execute(text("DELETE FROM ai_personas WHERE name = 'Technical Architect'"))
    seed_catalog(job_db.engine)
    rows = {r.name: r for r in _rows(job_db.engine, "SELECT name, system_prompt, status FROM ai_personas")}
    assert (rows["Solution Architect"].system_prompt, rows["Solution Architect"].status) == ("Edited", "archived")
    assert rows["Technical Architect"].system_prompt.startswith("You are a Technical Architect")
    assert len(rows) == 4


def test_the_catalog_job(
    job_db: JobDb, no_aws: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    job_db.use(monkeypatch)
    assert seed_catalog_job.main() == 0
    assert capsys.readouterr().out == (
        "Catalog seed complete (DiagramTypes, reference Standards, Icon/Shape Libraries, AiPersonas).\n"
    )
    assert len(_rows(job_db.engine, "SELECT id FROM diagram_types")) == len(DIAGRAM_TYPES)


def test_the_catalog_job_fails_with_a_bad_aws_manifest(
    job_db: JobDb,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    job_db.use(monkeypatch)
    monkeypatch.setenv("AWS_ICONS_MANIFEST", _aws_manifest(tmp_path, version="1"))
    assert seed_catalog_job.main() == 1
    assert "expected aws-icons@2024.1" in capsys.readouterr().err


# --- the demo seed -------------------------------------------------------------------------------------------


def test_the_demo_seed_refuses_local_mode_before_touching_the_database(
    job_db: JobDb,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    job_db.use(monkeypatch)
    monkeypatch.setenv("AUTH_MODE", "local")
    assert seed_demo_job.main() == 1
    assert capsys.readouterr().err == (
        "The demo seed refuses to run with AUTH_MODE=local (its accounts have published passwords). "
        "Use bootstrap-admin instead.\n"
    )
    with job_db.engine.connect() as conn:
        assert conn.dialect.has_table(conn, "users") is False
    with pytest.raises(seed_demo_job.LocalModeError):
        seed_demo_job.seed_demo(job_db.engine, "local")


def test_the_demo_seed(
    job_db: JobDb, no_aws: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    job_db.use(monkeypatch)
    monkeypatch.delenv("AUTH_MODE", raising=False)
    assert seed_demo_job.main() == 0
    project = _rows(job_db.engine, "SELECT id, owner_id FROM projects WHERE name = 'Smoke Test'")[0]
    assert capsys.readouterr().out == (
        "Seed complete.\n"
        "  Admin login: admin@example.com / admin-dev-password\n"
        "  Architect login: architect@example.com / architect-dev-password\n"
        "  Guest login: guest@example.com / guest-dev-password (no project access)\n"
        f"  Project id: {project.id}\n"
    )
    users = {
        r.email: r
        for r in _rows(
            job_db.engine,
            "SELECT u.id, u.email, u.name, u.role, c.password_hash, c.password_salt, c.must_change_password"
            " FROM users u JOIN local_credentials c ON c.user_id = u.id",
        )
    }
    assert {e: (u.name, u.role) for e, u in users.items()} == {
        "admin@example.com": ("Admin", "admin"),
        "architect@example.com": ("Architect", "architect"),
        "guest@example.com": ("Guest", "viewer"),
    }
    for email, password in (
        ("admin@example.com", "admin-dev-password"),
        ("architect@example.com", "architect-dev-password"),
        ("guest@example.com", "guest-dev-password"),
    ):
        assert verify_password(password, users[email].password_hash, users[email].password_salt)
        assert not users[email].must_change_password
    assert str(project.owner_id) == str(users["admin@example.com"].id)
    grants = _rows(
        job_db.engine,
        "SELECT subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id FROM share_grants",
    )
    assert [
        (g.subject_type, str(g.subject_id), str(g.grantee_user_id), g.access_level, str(g.granted_by_user_id))
        for g in grants
    ] == [
        ("project", str(project.id), str(users["architect@example.com"].id), "edit", str(users["admin@example.com"].id))
    ]
    assert len(_rows(job_db.engine, "SELECT id FROM diagram_types")) == len(DIAGRAM_TYPES)

    # Again: same accounts (passwords untouched), same project, still one grant.
    before = dump_tables(job_db.engine)
    assert seed_demo_job.seed_demo(job_db.engine) == str(project.id)
    compare_dumps(before, dump_tables(job_db.engine))
    hashes = {
        r.email: r.password_hash
        for r in _rows(
            job_db.engine, "SELECT u.email, c.password_hash FROM users u JOIN local_credentials c ON c.user_id = u.id"
        )
    }
    assert hashes == {e: u.password_hash for e, u in users.items()}
