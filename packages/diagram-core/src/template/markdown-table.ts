/**
 * Generic GFM-Markdown "intake form" parsing — no diagram-type knowledge lives here. This is the
 * shared foundation every per-diagram-type TemplateCompiler (starting with
 * c4-context-template-compiler.ts) builds on: a filled-in template document (like
 * docs/c4-context-template.md) is a sequence of `##` sections, each holding one pipe table meant
 * to be hand-filled, ending in a "mapping reference" the compiler encodes instead of the user
 * reading it. Splitting/extraction is intentionally a minimal GFM subset (one table per section,
 * no nested tables, no multi-line cells) — sufficient for every template authored so far.
 */

export interface MarkdownSection {
  /** Heading text with the leading '#'s stripped and trimmed, e.g. "1. Diagram metadata". */
  heading: string;
  /** Number of leading '#' characters (1-6). */
  level: number;
  /** Raw text between this heading and the next heading of the same or shallower level. */
  body: string;
}

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;

/** Splits a Markdown document into sections by heading line. A section's body runs until the next
 *  heading whose level is <= its own (matching normal Markdown document-outline semantics), or
 *  end of document. Content before the first heading is discarded — every template document
 *  starts with a level-1 title heading of its own. */
export function splitIntoSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const headings: { level: number; heading: string; startLine: number }[] = [];

  lines.forEach((line, i) => {
    const match = line.match(HEADING_LINE);
    if (match) {
      headings.push({ level: match[1].length, heading: match[2], startLine: i });
    }
  });

  return headings.map((h, i) => {
    // A section's body ends at the next heading of level <= its own, not simply "the next
    // heading" -- otherwise a subsection (deeper level) would be silently excluded from its
    // parent's body instead of being part of it.
    let endLine = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].startLine;
        break;
      }
    }
    const body = lines.slice(h.startLine + 1, endLine).join('\n');
    return { heading: h.heading, level: h.level, body };
  });
}

const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_SEPARATOR_CELL = /^:?-{1,}:?$/;

function splitRow(line: string): string[] {
  const match = line.match(TABLE_ROW);
  const inner = match ? match[1] : line;
  return inner.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
}

/**
 * Extracts the first GFM pipe table found in `text` (a header row, a `---` separator row, then
 * zero or more data rows) into row-objects keyed by the trimmed header-row column names. A data
 * row whose every cell is blank (the template's own unfilled placeholder rows, e.g. "| | | |") is
 * dropped -- an unfilled section is legitimately empty, not an error. Returns `[]` if no table is
 * found in `text` at all (an optional section left untouched) or the table has a header+separator
 * but zero non-blank data rows.
 */
export function extractFirstTable(text: string): Record<string, string>[] {
  const lines = text.split(/\r\n|\r|\n/);

  let headerIndex = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (TABLE_ROW.test(lines[i]) && isSeparatorRow(splitRow(lines[i + 1]))) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return [];

  const headerCells = splitRow(lines[headerIndex]);
  const rows: Record<string, string>[] = [];
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!TABLE_ROW.test(line)) break;
    const cells = splitRow(line);
    if (cells.every((cell) => cell === '')) continue;
    const row: Record<string, string> = {};
    headerCells.forEach((header, col) => {
      row[header] = cells[col] ?? '';
    });
    rows.push(row);
  }
  return rows;
}
