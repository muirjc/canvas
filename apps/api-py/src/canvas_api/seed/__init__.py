"""The catalog seed (apps/api/src/seed/catalog.ts): reference data every environment needs -- the built-in diagram
types, their published reference/starter standards, the bundled icon/shape libraries and the default AI personas.
Idempotent (upserts and check-then-insert) and never demo content or a credential, so a clean environment can run
it unconditionally (the canvas-catalog-seed job, `python -m canvas_api.jobs.seed_catalog`). The demo accounts and
project are jobs/seed_demo.py's.
"""

from __future__ import annotations

from sqlalchemy import Engine

from canvas_api.diagram_core import DiagramCore
from canvas_api.migrations import run_migrations
from canvas_api.seed.ai_personas import seed_ai_personas
from canvas_api.seed.diagram_types import seed_diagram_types
from canvas_api.seed.libraries import seed_libraries
from canvas_api.seed.reference_standards import seed_reference_standards

__all__ = ["seed_catalog"]


def seed_catalog(
    engine: Engine, core: DiagramCore | None = None, *, aws_icons_manifest_path: str | None = None
) -> None:
    """Migrates, then seeds, in TypeScript's order."""
    core = core or DiagramCore()
    run_migrations(engine)
    seed_diagram_types(engine)
    # canvas-tfr: after the types exist; only fills a type with no standards at all.
    seed_reference_standards(engine, core)
    seed_libraries(engine, core, aws_icons_manifest_path)
    seed_ai_personas(engine)
