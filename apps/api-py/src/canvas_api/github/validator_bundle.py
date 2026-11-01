"""The CI validator bundle (packages/validator-cli, built to dist/validator.mjs) and the example workflow
beside it (apps/api/src/github/validator-bundle.ts).

Canvas commits the bundle to `.canvas/validator.mjs` with every submission; unchanged content leaves the
repository's tree unchanged, so it only produces a diff when the validator itself changes. Read once and
cached. Found at CANVAS_VALIDATOR_DIR, else packages/validator-cli/dist in this repository (the image sets
CANVAS_VALIDATOR_DIR). Missing (not built) = submissions skip the file.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Literal

#: packages/validator-cli/dist, from src/canvas_api/github/ in apps/api-py.
DEFAULT_DIR = Path(__file__).resolve().parents[5] / "packages" / "validator-cli" / "dist"

_cache: dict[Path, str | None] = {}
_lock = threading.Lock()


def _read(directory: str | None, file: Literal["validator.mjs", "canvas-diagrams.yml"]) -> str | None:
    # `directory` is CANVAS_VALIDATOR_DIR (operator configuration) and `file` one of two fixed names:
    # nothing from a request reaches this path.
    path = (Path(directory) if directory else DEFAULT_DIR) / file
    with _lock:
        if path not in _cache:
            try:
                # bearer:disable python_lang_path_traversal
                _cache[path] = path.read_text(encoding="utf-8")
            except OSError:
                _cache[path] = None
        return _cache[path]


def validator_bundle(directory: str | None) -> str | None:
    """The bundled validator, or None when it hasn't been built."""
    return _read(directory, "validator.mjs")


def example_workflow(directory: str | None) -> str | None:
    """The example workflow (.github/workflows/canvas-diagrams.yml for the repository), or None."""
    return _read(directory, "canvas-diagrams.yml")


def reset_cache() -> None:
    """Tests only: forget what was read."""
    with _lock:
        _cache.clear()
