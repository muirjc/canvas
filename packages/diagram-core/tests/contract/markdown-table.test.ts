import { describe, expect, it } from 'vitest';
import { extractFirstTable, splitIntoSections } from '../../src/template/markdown-table.js';

describe('splitIntoSections', () => {
  it('splits multiple ## headings into separate sections, each with its own body', () => {
    const markdown = ['## Section A', 'body a line 1', 'body a line 2', '', '## Section B', 'body b', ''].join('\n');
    const sections = splitIntoSections(markdown);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ heading: 'Section A', level: 2 });
    expect(sections[0].body).toContain('body a line 1');
    expect(sections[0].body).toContain('body a line 2');
    expect(sections[0].body).not.toContain('body b');
    expect(sections[1]).toMatchObject({ heading: 'Section B', level: 2 });
    expect(sections[1].body).toContain('body b');
  });

  it('nests a ### subsection inside its parent ## section body rather than terminating it', () => {
    const markdown = [
      '## Parent',
      'intro text',
      '',
      '### Child',
      'child text',
      '',
      '## Next',
      'next text',
      '',
    ].join('\n');
    const sections = splitIntoSections(markdown);
    const parent = sections.find((s) => s.heading === 'Parent')!;
    const next = sections.find((s) => s.heading === 'Next')!;

    // The subsection heading and its own text are part of Parent's body, not excluded from it.
    expect(parent.body).toContain('intro text');
    expect(parent.body).toContain('### Child');
    expect(parent.body).toContain('child text');
    // Parent's body correctly terminates at the next heading of level <= 2 ("## Next"), so it
    // must not bleed into content that belongs to a later sibling section.
    expect(parent.body).not.toContain('next text');
    expect(next.body).toContain('next text');

    // The subsection is also discoverable as its own section entry (every heading gets one),
    // and its own body correctly stops at "## Next" (level 2 <= its own level 3).
    const child = sections.find((s) => s.heading === 'Child')!;
    expect(child.level).toBe(3);
    expect(child.body).toContain('child text');
    expect(child.body).not.toContain('next text');
  });

  it('returns an empty array when the document has no heading lines at all', () => {
    const markdown = ['Just some plain text.', 'No headings here.', ''].join('\n');
    expect(splitIntoSections(markdown)).toEqual([]);
  });

  it('discards content before the first heading', () => {
    const markdown = ['preamble text', '', '## Only Section', 'real body', ''].join('\n');
    const sections = splitIntoSections(markdown);
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toContain('real body');
    expect(sections[0].body).not.toContain('preamble text');
  });
});

describe('extractFirstTable', () => {
  it('parses a header + separator + multiple data rows into row-objects keyed by header name', () => {
    const text = ['| Name | Type |', '|---|---|', '| Customer | Person |', '| Payment Gateway | System |', ''].join(
      '\n',
    );
    const rows = extractFirstTable(text);
    expect(rows).toEqual([
      { Name: 'Customer', Type: 'Person' },
      { Name: 'Payment Gateway', Type: 'System' },
    ]);
  });

  it('drops a fully-blank data row (e.g. an unfilled template placeholder row)', () => {
    const text = ['| Name | Type |', '|---|---|', '| | |', '| Customer | Person |', ''].join('\n');
    const rows = extractFirstTable(text);
    expect(rows).toEqual([{ Name: 'Customer', Type: 'Person' }]);
  });

  it('returns [] when the section body has header+separator but zero non-blank data rows', () => {
    const text = ['| Name | Type |', '|---|---|', '| | |', ''].join('\n');
    expect(extractFirstTable(text)).toEqual([]);
  });

  it('returns [] when a section has no table at all', () => {
    const text = 'Just prose describing the section, no pipe table present.';
    expect(extractFirstTable(text)).toEqual([]);
  });

  it('extracts only the first table when a body contains multiple tables', () => {
    const text = [
      '| Name | Type |',
      '|---|---|',
      '| Customer | Person |',
      '',
      'Some text between tables.',
      '',
      '| Field | Value |',
      '|---|---|',
      '| Other | Table |',
      '',
    ].join('\n');
    const rows = extractFirstTable(text);
    expect(rows).toEqual([{ Name: 'Customer', Type: 'Person' }]);
  });
});
