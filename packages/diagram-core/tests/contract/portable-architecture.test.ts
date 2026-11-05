import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { toPortableMermaid } from '../../src/dsl/portable-mermaid.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * canvas-0t84: real Mermaid's architecture-beta refuses a connector without a side on both ends, a connector or
 * align row naming a missing service, and a second connector with the same source-target name. The export
 * rewrites such text; the saved diagram is unchanged.
 */

function dslWith(positions: Record<string, [number, number]>, body: string, containers = ''): string {
  const pos = Object.entries(positions)
    .map(([id, [x, y]]) => `    ${id}: {x: ${x}, y: ${y}}`)
    .join('\n');
  return `---\ncanvas:\n  positions:\n${pos}\n${containers}---\narchitecture-beta\n${body}`;
}

const TWO = 'service a(server)[A]\nservice b(server)[B]\n';

function exportOf(positions: Record<string, [number, number]>, edges: string, extra = ''): string {
  return toPortableMermaid(dslWith(positions, `${TWO}${extra}${edges}`), { stripFrontMatter: true });
}

describe('portable architecture export (canvas-0t84)', () => {
  it('returns the text unchanged, byte for byte, when every connector has both sides', () => {
    const dsl = dslWith({ a: [0, 0], b: [500, 0] }, `${TWO}a:R --> L:b\n`);
    expect(toPortableMermaid(dsl)).toBe(dsl);
  });

  it.each([
    ['right', [0, 0], [500, 40], 'a:R --> L:b'],
    ['left', [500, 0], [0, 40], 'a:L --> R:b'],
    ['below', [0, 0], [40, 500], 'a:B --> T:b'],
    ['above', [0, 500], [40, 0], 'a:T --> B:b'],
  ] as const)('gives a connector with no sides the ones facing the other end (%s)', (_name, a, b, expected) => {
    const out = exportOf({ a: [...a], b: [...b] }, 'a --> b\n');
    expect(out).toContain(expected);
  });

  it('breaks a tie between horizontal and vertical towards horizontal', () => {
    expect(exportOf({ a: [0, 0], b: [300, 300] }, 'a --> b\n')).toContain('a:R --> L:b');
    expect(exportOf({ a: [300, 300], b: [0, 0] }, 'a --> b\n')).toContain('a:L --> R:b');
  });

  it('uses right and left for two services at the same spot', () => {
    expect(exportOf({ a: [100, 100], b: [100, 100] }, 'a --> b\n')).toContain('a:R --> L:b');
  });

  it('keeps a side already given and fills only the missing one', () => {
    const out = exportOf({ a: [0, 0], b: [500, 0] }, 'a:T --> b\n');
    expect(out).toContain('a:T --> L:b');
    const out2 = exportOf({ a: [0, 0], b: [500, 0] }, 'a --> T:b\n');
    expect(out2).toContain('a:R --> T:b');
  });

  it('draws a loop out of the right and back in at the top', () => {
    const out = exportOf({ a: [0, 0], b: [500, 0] }, 'a --> a\n');
    expect(out).toContain('a:R --> T:a');
  });

  it('takes a {group} end from the group box, not the service', () => {
    const dsl = dslWith(
      { a: [500, 40], b: [700, 300] },
      'group g(cloud)[G]\nservice a(server)[A] in g\nservice b(server)[B]\na{group} --> b\n',
      '  containers:\n    g: {x: 0, y: 0, width: 600, height: 600}\n',
    );
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out).toContain('a{group}:R --> L:b');
    expect(out).not.toContain('a:B');
  });

  it('leaves out a connector to a service that does not exist', () => {
    const out = exportOf({ a: [0, 0], b: [500, 0] }, 'a --> b\na --> ghost\nghost --> b\n');
    expect(out).toContain('a:R --> L:b');
    expect(out).not.toContain('ghost');
  });

  it('keeps only the first connector per source-target, and keeps the reverse one', () => {
    const out = exportOf({ a: [0, 0], b: [500, 0] }, 'a --> b\na:B --> T:b\nb --> a\n');
    const lines = out.split('\n').filter((l) => l.includes('-->'));
    expect(lines).toEqual(['a:R --> L:b', 'b:L --> R:a']);
  });

  it('removes unknown ids from an align row and drops one left with fewer than two', () => {
    const out = exportOf(
      { a: [0, 0], b: [500, 0] },
      'a:R --> L:b\n',
      'align row a b ghost\nalign column a ghost\n',
    );
    expect(out).toContain('align row a b');
    expect(out).not.toContain('ghost');
    expect(out).not.toContain('align column');
  });

  it('does not change the saved diagram', () => {
    const dsl = dslWith({ a: [0, 0], b: [500, 0] }, `${TWO}a --> b\n`);
    toPortableMermaid(dsl);
    const parsed = parseArchitecture(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    const saved = serializeArchitecture(parsed.model);
    const again = parseArchitecture(saved);
    expect(isParseSuccess(again)).toBe(true);
    if (!isParseSuccess(again)) return;
    expect(again.model.edges[0].sourceAnchor).toBeUndefined();
    expect(again.model.edges[0].targetAnchor).toBeUndefined();
  });

  it('strips the canvas front matter from a rewritten export', () => {
    const out = exportOf({ a: [0, 0], b: [500, 0] }, 'a --> b\n');
    expect(out).not.toContain('canvas:');
    expect(out).toContain('architecture-beta');
  });
});
