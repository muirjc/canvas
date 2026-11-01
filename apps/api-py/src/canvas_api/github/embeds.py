"""canvas-finl: at submit time, Canvas updates every Markdown document in the repository that embeds this
diagram (`<!-- MERMAID: <path>.mmd|.svg -->`), in the same commit as the diagram's files, so reviewers
approve both together (apps/api/src/github/document-embeds.ts). Only markers pointing at this diagram's
files are touched; the repository's CI validator checks the rest.

Reads the tree once, then only Markdown files. Blobs are cached by sha (content-addressed, so a cached
entry is never stale); files without a marker are cached as "nothing here".
"""

from __future__ import annotations

import re
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from canvas_api.diagram_core import DiagramBridge
from canvas_api.github.client import GitHubClient, RepoRef

#: Larger documents are skipped (GitHub's blob API and a reviewer's patience both have limits).
MAX_DOCUMENT_BYTES = 512 * 1024
#: At most this many Markdown files are read per submission.
MAX_DOCUMENTS = 500
CONCURRENCY = 8
CACHE_LIMIT = 5000

_MARKER_HINT = re.compile(r"<!--\s*mermaid:", re.IGNORECASE)
_MARKDOWN = re.compile(r"\.md$", re.IGNORECASE)
_blob_cache: OrderedDict[str, str | None] = OrderedDict()
_cache_lock = threading.Lock()


@dataclass(frozen=True)
class DiagramFiles:
    #: Repository path of the committed portable Mermaid file, and its text.
    mmd_path: str
    mmd_text: str
    #: Repository path of the committed SVG.
    svg_path: str


@dataclass(frozen=True)
class EmbedUpdate:
    #: Documents to write in the submission commit.
    files: list[dict[str, str]]
    #: Every document that embeds this diagram (changed or already current), for the PR description.
    documents: list[str]
    #: True when not every Markdown file could be checked (huge repository).
    incomplete: bool


def _utf16_key(text: str) -> bytes:
    """Array.prototype.sort()'s order: UTF-16 code units."""
    return text.encode("utf-16-be", errors="surrogatepass")


def _locale_key(text: str) -> tuple[str, str]:
    """Close to the TypeScript service's localeCompare (case-insensitive first). It only decides which
    documents are read when a repository has more than MAX_DOCUMENTS of them."""
    return text.casefold(), text


def document_embed_updates(
    client: GitHubClient, bridge: DiagramBridge, token: str, repo: RepoRef, tree_sha: str, diagram: DiagramFiles
) -> EmbedUpdate:
    listing, truncated = client.list_tree_files(token, repo, tree_sha)
    markdown = sorted(
        (f for f in listing if _MARKDOWN.search(f.path) and f.size <= MAX_DOCUMENT_BYTES),
        key=lambda f: _locale_key(f.path),
    )
    checked = markdown[:MAX_DOCUMENTS]
    incomplete = truncated or len(markdown) > len(checked)
    sources = {diagram.mmd_path: {"kind": "mermaid", "text": diagram.mmd_text}, diagram.svg_path: {"kind": "svg"}}
    only = list(sources)

    def check(path: str, sha: str) -> tuple[str, str | None, bool]:
        text = _read_markdown(client, token, repo, sha)
        if text is None:
            return path, None, False
        update = bridge.embeds(text, path, sources, only)
        embeds = any(r.get("status") in ("current", "updated", "filled") for r in update.get("results", []))
        return path, str(update["markdown"]) if update.get("changed") else None, embeds

    with ThreadPoolExecutor(max_workers=max(1, min(CONCURRENCY, len(checked)))) as pool:
        results = list(pool.map(lambda f: check(f.path, f.sha), checked))
    files = [{"path": path, "content": content} for path, content, _ in results if content is not None]
    documents = [path for path, _, embeds in results if embeds]
    return EmbedUpdate(
        files=sorted(files, key=lambda f: _locale_key(f["path"])),
        documents=sorted(documents, key=_utf16_key),
        incomplete=incomplete,
    )


def _read_markdown(client: GitHubClient, token: str, repo: RepoRef, sha: str) -> str | None:
    """The document's text, or None when it has no marker at all."""
    with _cache_lock:
        if sha in _blob_cache:
            return _blob_cache[sha]
    text = client.get_blob_text(token, repo, sha)
    value = text if _MARKER_HINT.search(text) else None
    with _cache_lock:
        if len(_blob_cache) >= CACHE_LIMIT:
            _blob_cache.popitem(last=False)
        _blob_cache[sha] = value
    return value
