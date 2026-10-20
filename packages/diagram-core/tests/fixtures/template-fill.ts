import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * canvas-73s.1-.5: test helpers that work on the REAL template documents in docs/, so a column the
 * doc names and the compiler reads can never drift apart unnoticed.
 */

export function readTemplateDoc(fileName: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../docs/${fileName}`, import.meta.url)), 'utf-8');
}

/**
 * Fills the doc's sections: for each key (a case-insensitive prefix of a `##` heading, ignoring its
 * "3." number), the rows replace that section's first table's data rows. Sections not named keep
 * their blank placeholder row. `null` removes the section entirely.
 */
export function fillTemplate(doc: string, rowsBySection: Record<string, string[][] | null>): string {
  // Only the form part of the doc: stop before the mapping reference / example.
  const formEnd = doc.search(/^## Mapping reference/m);
  let form = formEnd === -1 ? doc : doc.slice(0, formEnd);
  for (const [key, rows] of Object.entries(rowsBySection)) {
    const sections = form.split(/(?=^## )/m);
    const index = sections.findIndex((s) => s.replace(/^##\s+(\d+\.\s*)?/, '').toLowerCase().startsWith(key.toLowerCase()));
    if (index === -1) throw new Error(`No section "${key}" in the template doc`);
    if (rows === null) {
      sections.splice(index, 1);
    } else {
      const lines = sections[index].split('\n');
      const separator = lines.findIndex((line, i) => i > 0 && /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line) && lines[i - 1].startsWith('|'));
      if (separator === -1) throw new Error(`Section "${key}" has no table`);
      let end = separator + 1;
      while (end < lines.length && lines[end].startsWith('|')) end++;
      lines.splice(separator + 1, end - separator - 1, ...rows.map((row) => `| ${row.join(' | ')} |`));
      sections[index] = lines.join('\n');
    }
    form = sections.join('');
  }
  return form;
}

/** The tables in the doc's "Example" section, in order, as rows (header row dropped). */
export function exampleTables(doc: string): string[][][] {
  const example = doc.slice(doc.search(/^## Example/m));
  const tables: string[][][] = [];
  let current: string[][] | null = null;
  const lines = example.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      current = null;
      continue;
    }
    if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    if (current === null) {
      current = []; // header row
      tables.push(current);
      continue;
    }
    current.push(cells);
  }
  return tables;
}

/** The last fenced code block in the doc -- the example's expected DSL. */
export function exampleDsl(doc: string): string {
  const blocks = [...doc.matchAll(/```\n([\s\S]*?)```/g)];
  return blocks[blocks.length - 1][1];
}

/** DSL lines with indentation and blank lines removed, for comparing layout-insensitively. */
export function dslLines(dsl: string): string[] {
  return dsl
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
