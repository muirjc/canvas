"""The folder an admin links a project to, and the per-diagram paths Canvas writes under it
(apps/api/src/github/folder-path.ts).

Strict on purpose: every path Canvas commits passes through `assert_safe_repo_path`, so a folder, a diagram
name or a type id can never reach `.git`, `.github` (workflows) or another diagram's files.
"""

from __future__ import annotations

import re
import unicodedata

from canvas_api.github.jstext import js_len, js_trim


class InvalidRepoPathError(Exception):
    pass


_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
MAX_PATH_LENGTH = 200
MAX_DEPTH = 10
#: Folders Canvas never writes into (it writes `.canvas/` itself, but never under a linked folder).
_RESERVED = {".git", ".github", ".canvas", ".gitmodules", ".gitattributes", ".gitignore"}


def _check_segments(path: str, what: str) -> None:
    segments = path.split("/")
    if len(segments) > MAX_DEPTH:
        raise InvalidRepoPathError(f"{what} is nested too deeply (at most {MAX_DEPTH} levels).")
    for segment in segments:
        if segment in ("", ".", ".."):
            raise InvalidRepoPathError(f'{what} has an empty, "." or ".." part.')
        if segment.lower() in _RESERVED:
            raise InvalidRepoPathError(f'{what} can\'t use "{segment}".')
        if not _SEGMENT.fullmatch(segment):
            raise InvalidRepoPathError(
                f'{what} may use letters, numbers, ".", "_" and "-" only, and each part must start with a letter'
                f' or number ("{segment}").'
            )


def normalize_folder(value: str) -> str:
    """An admin-entered folder ("/architecture/diagrams/" -> "architecture/diagrams"). Never the root."""
    folder = re.sub(r"/+", "/", js_trim(value).replace("\\", "/"))
    folder = re.sub(r"^/|/$", "", folder)
    if folder == "":
        raise InvalidRepoPathError('Choose a folder in the repository (for example "architecture/diagrams").')
    if js_len(folder) > MAX_PATH_LENGTH:
        raise InvalidRepoPathError(f"The folder is too long (at most {MAX_PATH_LENGTH} characters).")
    _check_segments(folder, "The folder")
    return folder


def slugify(name: str) -> str:
    """A diagram's folder name: kebab-case from its name, at most 60 characters."""
    slug = re.sub(r"[̀-ͯ]", "", unicodedata.normalize("NFKD", name)).lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"^-+|-+$", "", slug)[:60]
    slug = re.sub(r"-+$", "", slug)
    return slug or "diagram"


def assert_safe_repo_path(path: str) -> str:
    """Re-checks a full path Canvas is about to write (a file inside a diagram folder, or a standard)."""
    if js_len(path) > MAX_PATH_LENGTH + 120:
        raise InvalidRepoPathError("The file path is too long.")
    # `.canvas/standards/...` is Canvas's own folder; everything else follows the folder rules.
    checked = path[len(".canvas/") :] if path.startswith(".canvas/") else path
    _check_segments(checked, "The file path")
    return path
