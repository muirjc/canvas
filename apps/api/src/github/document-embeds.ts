import { updateEmbeds, type EmbedSource } from '@canvas/diagram-core';
import type { GitHubClient, TreeEntry } from './github-client.js';

/**
 * canvas-finl: at submit time, Canvas updates every Markdown document in the repository that embeds
 * this diagram (`<!-- MERMAID: <path>.mmd|.svg -->`), in the same commit as the diagram's files, so
 * reviewers approve both together. Only markers pointing at this diagram's files are touched; the
 * repository's CI validator checks the rest.
 *
 * Reads the tree once, then only Markdown files. Blobs are cached by sha (content-addressed, so a
 * cached entry is never stale); files without a marker are cached as "nothing here".
 */

/** Larger documents are skipped (GitHub's blob API and a reviewer's patience both have limits). */
const MAX_DOCUMENT_BYTES = 512 * 1024;
/** At most this many Markdown files are read per submission. */
const MAX_DOCUMENTS = 500;
const CONCURRENCY = 8;
const CACHE_LIMIT = 5000;

const blobCache = new Map<string, string | null>();
const MARKER_HINT = /<!--\s*mermaid:/i;

export interface DiagramFiles {
  /** Repository path of the committed portable Mermaid file, and its text. */
  mmdPath: string;
  mmdText: string;
  /** Repository path of the committed SVG. */
  svgPath: string;
}

export interface DocumentEmbedUpdate {
  /** Documents to write in the submission commit. */
  files: TreeEntry[];
  /** Every document that embeds this diagram (changed or already current), for the PR description. */
  documents: string[];
  /** True when not every Markdown file could be checked (huge repository). */
  incomplete: boolean;
}

export async function documentEmbedUpdates(
  client: GitHubClient,
  token: string,
  repo: { owner: string; name: string },
  treeSha: string,
  diagram: DiagramFiles,
): Promise<DocumentEmbedUpdate> {
  const listing = await client.listTreeFiles(token, repo, treeSha);
  const markdown = listing.files.filter((f) => /\.md$/i.test(f.path) && f.size <= MAX_DOCUMENT_BYTES).sort((a, b) => a.path.localeCompare(b.path));
  const checked = markdown.slice(0, MAX_DOCUMENTS);
  const incomplete = listing.truncated || markdown.length > checked.length;

  const sources: Record<string, EmbedSource> = {
    [diagram.mmdPath]: { kind: 'mermaid', text: diagram.mmdText },
    [diagram.svgPath]: { kind: 'svg' },
  };
  const only = new Set(Object.keys(sources));
  const files: TreeEntry[] = [];
  const documents: string[] = [];

  let next = 0;
  const worker = async () => {
    while (next < checked.length) {
      const file = checked[next++];
      const text = await readMarkdown(client, token, repo, file.sha);
      if (text === null) continue;
      const update = updateEmbeds(text, file.path, (path) => sources[path], only);
      if (update.results.some((r) => r.status === 'current' || r.status === 'updated' || r.status === 'filled')) documents.push(file.path);
      if (update.changed) files.push({ path: file.path, content: update.markdown });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, checked.length) }, worker));
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), documents: documents.sort(), incomplete };
}

/** The document's text, or null when it has no marker at all. */
async function readMarkdown(client: GitHubClient, token: string, repo: { owner: string; name: string }, sha: string): Promise<string | null> {
  if (blobCache.has(sha)) return blobCache.get(sha)!;
  const text = await client.getBlobText(token, repo, sha);
  const value = MARKER_HINT.test(text) ? text : null;
  if (blobCache.size >= CACHE_LIMIT) blobCache.delete(blobCache.keys().next().value!);
  blobCache.set(sha, value);
  return value;
}
