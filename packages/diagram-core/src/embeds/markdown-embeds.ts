/**
 * canvas-finl: Markdown documents in a repository can embed a Canvas diagram with a marker:
 *
 *   <!-- MERMAID: architecture/payments/payments-context.mmd -->
 *
 * The path is from the repository root. Under the marker Canvas writes a generated section and an
 * end marker, and later replaces only what's between the two:
 *
 *   <!-- MERMAID: architecture/payments/payments-context.mmd -->
 *   ```mermaid
 *   ...the portable .mmd...
 *   ```
 *   <!-- /MERMAID -->
 *
 * A path ending `.mmd` embeds the Mermaid text (GitHub draws it); `.svg` embeds an image link to the
 * committed picture. Markers inside code blocks are ignored, so documentation can show the syntax.
 * Pure text in, text out: the API runs it at submit time and the repository validator in CI.
 */

export const EMBED_END_MARKER = '<!-- /MERMAID -->';

const START = /^<!--\s*MERMAID:\s*(\S+?)\s*-->$/i;
const END = /^<!--\s*\/MERMAID\s*-->$/i;
const FENCE = /^(`{3,}|~{3,})/;

export type EmbedKind = 'mermaid' | 'svg';

/** What a marker points at, as the caller found it in the repository. */
export type EmbedSource = { kind: 'mermaid'; text: string } | { kind: 'svg' };

export type EmbedStatus =
  /** The section already matches. */
  | 'current'
  /** The section was there but out of date, and was replaced. */
  | 'updated'
  /** The marker had no section yet; one was added. */
  | 'filled'
  /** The path doesn't exist in the repository. The section is left as it was. */
  | 'missing'
  /** Not a path Canvas can embed (not .mmd/.svg, or leaves the repository). Left as it was. */
  | 'unsupported';

export interface EmbedResult {
  /** The path as written in the marker. */
  target: string;
  /** The same path, normalised (no leading ./ or /), or null when unsupported. */
  path: string | null;
  /** 1-based line of the marker in the original document. */
  line: number;
  status: EmbedStatus;
}

export interface EmbedUpdate {
  markdown: string;
  changed: boolean;
  results: EmbedResult[];
}

export interface EmbedMarker {
  target: string;
  path: string | null;
  kind: EmbedKind | null;
  /** 0-based index of the marker line. */
  index: number;
  /** 0-based index of its end marker, or null when it has no section yet. */
  endIndex: number | null;
}

/** A marker path from the repository root: no `..`, no empty segments, `.mmd` or `.svg`. */
export function normaliseEmbedPath(target: string): { path: string; kind: EmbedKind } | null {
  const path = target.replace(/^\.\//, '').replace(/^\/+/, '');
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..') || path.includes('\\')) return null;
  if (path.endsWith('.canvas.mmd')) return null;
  if (path.endsWith('.mmd')) return { path, kind: 'mermaid' };
  if (path.endsWith('.svg')) return { path, kind: 'svg' };
  return null;
}

/** Every marker outside code blocks, with where its section ends (if it has one). */
export function findEmbedMarkers(markdown: string): EmbedMarker[] {
  const lines = markdown.split(/\r?\n/);
  const markers: EmbedMarker[] = [];
  let fence: string | null = null;
  let open: EmbedMarker | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const fenceMatch = trimmed.match(FENCE);
    if (fence) {
      if (fenceMatch && trimmed.startsWith(fence) && trimmed.slice(fenceMatch[1].length).trim() === '' && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const start = trimmed.match(START);
    if (start) {
      const normalised = normaliseEmbedPath(start[1]);
      open = { target: start[1], path: normalised?.path ?? null, kind: normalised?.kind ?? null, index: i, endIndex: null };
      markers.push(open);
      continue;
    }
    if (END.test(trimmed) && open && open.endIndex === null) {
      open.endIndex = i;
      open = null;
    }
  }
  return markers;
}

/** The generated section for a marker in `docPath`, end marker included. */
export function renderEmbed(source: EmbedSource, targetPath: string, docPath: string): string[] {
  if (source.kind === 'svg') {
    const name = targetPath.slice(targetPath.lastIndexOf('/') + 1).replace(/\.svg$/, '');
    const alt = name.replace(/[[\]\\]/g, '');
    const href = relativePath(docPath, targetPath).split('/').map(encodeURIComponent).join('/');
    return [`![${alt}](${href})`, EMBED_END_MARKER];
  }
  const text = source.text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}mermaid`, ...text.split('\n'), fence, EMBED_END_MARKER];
}

/**
 * Rewrites each marker's section in `markdown` (a document at `docPath`, from the repository root).
 * `resolve` says what a normalised path is: its source, or undefined when the file doesn't exist.
 * With `only`, markers pointing elsewhere are left alone and not reported.
 */
export function updateEmbeds(
  markdown: string,
  docPath: string,
  resolve: (path: string) => EmbedSource | undefined,
  only?: ReadonlySet<string>,
): EmbedUpdate {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const results: EmbedResult[] = [];
  const replacements: { from: number; to: number; lines: string[] }[] = [];
  for (const marker of findEmbedMarkers(markdown)) {
    if (only && (!marker.path || !only.has(marker.path))) continue;
    const result = (status: EmbedStatus) => results.push({ target: marker.target, path: marker.path, line: marker.index + 1, status });
    if (!marker.path || !marker.kind) {
      result('unsupported');
      continue;
    }
    const source = resolve(marker.path);
    if (!source || source.kind !== marker.kind) {
      result('missing');
      continue;
    }
    const section = renderEmbed(source, marker.path, docPath);
    if (marker.endIndex === null) {
      replacements.push({ from: marker.index + 1, to: marker.index, lines: section });
      result('filled');
      continue;
    }
    const existing = lines.slice(marker.index + 1, marker.endIndex + 1);
    if (existing.length === section.length && existing.every((line, i) => line === section[i])) {
      result('current');
      continue;
    }
    replacements.push({ from: marker.index + 1, to: marker.endIndex, lines: section });
    result('updated');
  }
  if (replacements.length === 0) return { markdown, changed: false, results };
  // Back to front, so earlier indexes stay valid.
  for (const r of [...replacements].sort((a, b) => b.from - a.from)) lines.splice(r.from, r.to - r.from + 1, ...r.lines);
  return { markdown: lines.join(eol), changed: true, results };
}

/** `to` relative to the folder holding `from`; both repository paths with forward slashes. */
function relativePath(from: string, to: string): string {
  const fromDir = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let common = 0;
  while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) common++;
  const up = fromDir.length - common;
  const rest = toParts.slice(common);
  return up === 0 ? `./${rest.join('/')}` : [...Array(up).fill('..'), ...rest].join('/');
}
