import { describe, expect, it } from 'vitest';
import { EMBED_END_MARKER, findEmbedMarkers, normaliseEmbedPath, updateEmbeds, type EmbedSource } from '../../src/embeds/markdown-embeds.js';

/**
 * canvas-finl: `<!-- MERMAID: path -->` markers in Markdown documents get a generated section under
 * them (the diagram's portable Mermaid, or an image link to its SVG) and an end marker; later updates
 * replace only that section.
 */

const MMD = 'architecture/prod/diagrams/product-context/product-context.mmd';
const SVG = 'architecture/prod/diagrams/product-context/product-context.svg';
const DOC = 'architecture/hld/sample_hld.md';
const MERMAID = 'flowchart LR\n  A[Customer] --> B[Shop]\n';

const repo = (files: Record<string, EmbedSource>) => (path: string) => files[path];
const both = repo({ [MMD]: { kind: 'mermaid', text: MERMAID }, [SVG]: { kind: 'svg' } });

describe('updateEmbeds', () => {
  it('fills a bare marker with the Mermaid block and an end marker, leaving the rest of the document alone', () => {
    const doc = `# High Level Design\n\n### Product Context Diagram\n\n<!-- MERMAID: ${MMD} -->\n\n### More stuff\n`;
    const out = updateEmbeds(doc, DOC, both);
    expect(out.changed).toBe(true);
    expect(out.results).toEqual([{ target: MMD, path: MMD, line: 5, status: 'filled' }]);
    expect(out.markdown).toBe(
      `# High Level Design\n\n### Product Context Diagram\n\n<!-- MERMAID: ${MMD} -->\n\`\`\`mermaid\nflowchart LR\n  A[Customer] --> B[Shop]\n\`\`\`\n${EMBED_END_MARKER}\n\n### More stuff\n`,
    );
  });

  it('is idempotent: a filled section that matches is reported current and nothing changes', () => {
    const filled = updateEmbeds(`<!-- MERMAID: ${MMD} -->\n`, DOC, both).markdown;
    const again = updateEmbeds(filled, DOC, both);
    expect(again.changed).toBe(false);
    expect(again.markdown).toBe(filled);
    expect(again.results[0].status).toBe('current');
  });

  it('replaces only the section between the markers when the diagram changes', () => {
    const filled = `intro\n${updateEmbeds(`<!-- MERMAID: ${MMD} -->\n`, DOC, both).markdown}outro\n`;
    const changed = repo({ [MMD]: { kind: 'mermaid', text: 'flowchart TD\n  X --> Y\n' } });
    const out = updateEmbeds(filled, DOC, changed);
    expect(out.results[0].status).toBe('updated');
    expect(out.markdown).toBe(`intro\n<!-- MERMAID: ${MMD} -->\n\`\`\`mermaid\nflowchart TD\n  X --> Y\n\`\`\`\n${EMBED_END_MARKER}\noutro\n`);
  });

  it('an .svg marker gets an image link relative to the document', () => {
    const out = updateEmbeds(`<!-- MERMAID: ${SVG} -->\n`, DOC, both);
    expect(out.markdown).toContain('![product-context](../prod/diagrams/product-context/product-context.svg)');
    const sameFolder = updateEmbeds(`<!-- MERMAID: ${SVG} -->\n`, 'architecture/prod/diagrams/product-context/notes.md', both);
    expect(sameFolder.markdown).toContain('](./product-context.svg)');
    const atRoot = updateEmbeds(`<!-- MERMAID: ${SVG} -->\n`, 'README.md', both);
    expect(atRoot.markdown).toContain(`](./${SVG})`);
  });

  it('a marker pointing at a file that does not exist is reported missing and left as it was', () => {
    const doc = '<!-- MERMAID: architecture/prod/diagrams/product_context/product_context.mmd -->\n';
    const out = updateEmbeds(doc, DOC, both);
    expect(out.changed).toBe(false);
    expect(out.results[0].status).toBe('missing');
  });

  it('keeps an existing section when its diagram has gone missing (never deletes content)', () => {
    const filled = updateEmbeds(`<!-- MERMAID: ${MMD} -->\n`, DOC, both).markdown;
    const out = updateEmbeds(filled, DOC, repo({}));
    expect(out.markdown).toBe(filled);
    expect(out.results[0].status).toBe('missing');
  });

  it('reports unsupported paths (not .mmd/.svg, Canvas source, outside the repository) and leaves them', () => {
    const doc = ['<!-- MERMAID: a/b.png -->', '<!-- MERMAID: a/b.canvas.mmd -->', '<!-- MERMAID: ../other/b.mmd -->', ''].join('\n');
    const out = updateEmbeds(doc, DOC, both);
    expect(out.changed).toBe(false);
    expect(out.results.map((r) => r.status)).toEqual(['unsupported', 'unsupported', 'unsupported']);
  });

  it('ignores markers inside code blocks, so documentation can show the syntax', () => {
    const doc = `Write it like this:\n\n\`\`\`markdown\n<!-- MERMAID: ${MMD} -->\n\`\`\`\n\n~~~\n<!-- MERMAID: ${MMD} -->\n~~~\n`;
    const out = updateEmbeds(doc, DOC, both);
    expect(out.results).toEqual([]);
    expect(out.markdown).toBe(doc);
  });

  it('with `only`, touches and reports just the markers for those paths', () => {
    const doc = `<!-- MERMAID: ${MMD} -->\n\n<!-- MERMAID: other/x.mmd -->\n`;
    const out = updateEmbeds(doc, DOC, both, new Set([MMD]));
    expect(out.results.map((r) => r.path)).toEqual([MMD]);
    expect(out.markdown).toContain('<!-- MERMAID: other/x.mmd -->\n');
    expect(out.markdown.match(/\/MERMAID/g)).toHaveLength(1);
  });

  it('handles several markers, including the same diagram twice and both forms', () => {
    const doc = `<!-- MERMAID: ${MMD} -->\ntext\n<!-- MERMAID: ${SVG} -->\nmore\n<!-- MERMAID: ${MMD} -->\n`;
    const out = updateEmbeds(doc, DOC, both);
    expect(out.results.map((r) => r.status)).toEqual(['filled', 'filled', 'filled']);
    expect(out.markdown.match(/\/MERMAID/g)).toHaveLength(3);
    expect(updateEmbeds(out.markdown, DOC, both).changed).toBe(false);
  });

  it('uses a fence longer than any backtick run in the Mermaid text', () => {
    const out = updateEmbeds(`<!-- MERMAID: ${MMD} -->\n`, DOC, repo({ [MMD]: { kind: 'mermaid', text: 'flowchart LR\n  A["````"] --> B\n' } }));
    expect(out.markdown).toContain('`````mermaid\n');
    expect(updateEmbeds(out.markdown, DOC, repo({ [MMD]: { kind: 'mermaid', text: 'flowchart LR\n  A["````"] --> B\n' } })).changed).toBe(false);
  });

  it('keeps Windows line endings', () => {
    const doc = `# HLD\r\n<!-- MERMAID: ${MMD} -->\r\nafter\r\n`;
    const out = updateEmbeds(doc, DOC, both);
    expect(out.markdown).not.toMatch(/[^\r]\n/);
    expect(out.markdown).toContain(`${EMBED_END_MARKER}\r\nafter\r\n`);
  });

  it('accepts ./ and / prefixes and any case for the marker word', () => {
    const doc = `<!-- mermaid: ./${MMD} -->\n<!--MERMAID:/${MMD}-->\n`;
    const out = updateEmbeds(doc, DOC, both);
    expect(out.results.map((r) => [r.path, r.status])).toEqual([[MMD, 'filled'], [MMD, 'filled']]);
  });

  it('a second marker before the first one was closed starts its own section', () => {
    const markers = findEmbedMarkers(`<!-- MERMAID: ${MMD} -->\n<!-- MERMAID: ${SVG} -->\n![x](y)\n${EMBED_END_MARKER}\n`);
    expect(markers.map((m) => [m.index, m.endIndex])).toEqual([[0, null], [1, 3]]);
  });
});

describe('normaliseEmbedPath', () => {
  it.each([
    ['a/b.mmd', { path: 'a/b.mmd', kind: 'mermaid' }],
    ['./a/b.svg', { path: 'a/b.svg', kind: 'svg' }],
    ['/a/b.mmd', { path: 'a/b.mmd', kind: 'mermaid' }],
    ['a/../b.mmd', null],
    ['a//b.mmd', null],
    ['a\\b.mmd', null],
    ['a/b.canvas.mmd', null],
    ['a/b.md', null],
  ])('%s', (input, expected) => {
    expect(normaliseEmbedPath(input)).toEqual(expected);
  });
});
