"""The bundled icon/shape libraries (apps/api/src/seed/libraries.seed.ts), loaded as shipped: built-in origin,
through diagram-core's loadLibrary like TypeScript's ingestLibrary, no strict artwork clean-up.

The manifests are JSON copies of packages/diagram-core/src/libraries/*.ts in manifests/, held equal to them by
diagram-core's tests/contract/python-seed-libraries.test.ts (UPDATE_SEED_LIBRARIES=1 regenerates them).
"""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, text

from canvas_api.diagram_core import DiagramCore
from canvas_api.diagram_core.jsvalues import js_template
from canvas_api.library_store import ingest_library

MANIFESTS_DIR = Path(__file__).resolve().parent / "manifests"

#: jmuir-dtu.29: a deployment's locally generated AWS icon library, the repository root's vendor-icons/ folder
#: (gitignored apart from its README); AWS_ICONS_MANIFEST overrides it. parents: seed, canvas_api, src, api-py,
#: apps, the repository root (in the image, /app).
DEFAULT_AWS_ICONS_MANIFEST = Path(__file__).resolve().parents[5] / "vendor-icons" / "aws-icons.json"


@cache
def bundled_manifest(name: str) -> dict[str, Any]:
    """One of manifests/<name>.json: generic, azure-icons, aws-icons (the placeholder), mermaid-architecture."""
    manifest: dict[str, Any] = json.loads((MANIFESTS_DIR / f"{name}.json").read_text(encoding="utf-8"))
    return manifest


def _versions() -> dict[str, Any]:
    return bundled_manifest("versions")


def aws_icons_version() -> str:
    return str(_versions()["awsIconsVersion"])


def legacy_aws_placeholder_version() -> str:
    return str(_versions()["legacyAwsPlaceholderVersion"])


class AwsIconsManifestError(ValueError):
    """The generated AWS manifest isn't aws-icons at the version the placeholder carries."""


def load_generated_aws_icons(explicit_path: str | None = None) -> dict[str, Any] | None:
    """The generated AWS manifest, or None when there isn't one (the placeholders are seeded then)."""
    # TypeScript's `??`: an empty AWS_ICONS_MANIFEST is a path (that doesn't exist), not "unset".
    chosen = explicit_path if explicit_path is not None else os.environ.get("AWS_ICONS_MANIFEST")
    path = Path(chosen) if chosen is not None else DEFAULT_AWS_ICONS_MANIFEST
    if not path.is_file():
        return None
    manifest: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    expected = aws_icons_version()
    if manifest.get("id") != "aws-icons" or manifest.get("version") != expected:
        raise AwsIconsManifestError(
            f"{path} is {_js_text(manifest, 'id')}@{_js_text(manifest, 'version')}; expected"
            f" aws-icons@{expected}. Regenerate it with packages/diagram-core/scripts/generate-aws-icons.mjs."
        )
    return manifest


def _js_text(manifest: dict[str, Any], key: str) -> str:
    """`${manifest[key]}`: "undefined" when absent."""
    return js_template(manifest[key]) if key in manifest else "undefined"


_DELETE_VERSION = text("DELETE FROM icon_libraries WHERE id = :id AND version = :version")


def seed_libraries(engine: Engine, core: DiagramCore, aws_icons_manifest_path: str | None = None) -> None:
    """Each library in its own transaction, as TypeScript's ingestLibrary."""
    manifests = [
        bundled_manifest("generic"),
        bundled_manifest("azure-icons"),
        # jmuir-dtu.29: real AWS artwork when this deployment generated it, the placeholders otherwise.
        load_generated_aws_icons(aws_icons_manifest_path) or bundled_manifest("aws-icons"),
    ]
    for manifest in manifests:
        with engine.begin() as conn:
            ingest_library(conn, core, manifest)
    # The old '2024.1-placeholder' version only duplicates palette entries (saved references to it are upgraded
    # on read); its icons and keywords go with it (ON DELETE CASCADE).
    with engine.begin() as conn:
        conn.execute(_DELETE_VERSION, {"id": "aws-icons", "version": legacy_aws_placeholder_version()})
    with engine.begin() as conn:
        ingest_library(conn, core, bundled_manifest("mermaid-architecture"))
