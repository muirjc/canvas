import type { Violation } from '@canvas/diagram-core';
import { describe, expect, it } from 'vitest';
import { InvalidRepoPathError } from '../../src/github/folder-path.js';
import {
  buildCommitMessage,
  buildPrBody,
  buildPrTitle,
  buildSubmissionFiles,
  escapeMarkdown,
  oneLine,
  submissionFingerprint,
  type SubmissionInput,
} from '../../src/github/submission-files.js';

/** canvas-3s5.1: the pure builders -- files, Markdown escaping, PR text, commit message. */
const ZWSP = '​';

function input(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    diagramId: '11111111-2222-4333-8444-555555555555',
    name: 'Order Flow',
    description: null,
    diagramTypeId: 'flowchart',
    diagramTypeName: 'Generic Flowchart',
    dslFamily: 'flowchart',
    dslContent: '---\ncanvas:\n  positions: {}\n---\nflowchart TD\n  A --> B\n',
    portableMermaid: 'flowchart TD\n  A --> B\n',
    svg: '<svg/>',
    versionSequence: 3,
    standard: null,
    path: 'architecture/order-flow',
    slug: 'order-flow',
    canvasUrl: 'http://canvas.test/?diagramId=1',
    ...overrides,
  };
}
const violation = (message: string, severity = 'warning'): Violation => ({ elementId: 'A', rule: 'r', message, severity, elementType: 'node' }) as Violation;

describe('escapeMarkdown', () => {
  it('neutralises @mentions with a zero-width space', () => {
    const out = escapeMarkdown('hi @everyone and @octocat/team');
    expect(out).not.toContain('@e');
    expect(out).not.toContain('@o');
    expect(out).toContain(`@${ZWSP}everyone`);
  });
  it('escapes formatting, links, HTML and headings, and flattens line breaks', () => {
    const out = escapeMarkdown('**bold** [x](http://evil) <img src=x> # h\n- item\r\n`code` ![i](u) a|b ~~s~~');
    expect(out).not.toMatch(/(^|[^\\])[*[\]()<>`|~#]/);
    expect(out).not.toContain('\n');
    expect(out).toContain('\\*\\*bold\\*\\*');
    expect(out).toContain('\\[x\\]\\(http://evil\\)');
  });
  it('escapes backslashes first, so an escape cannot be cancelled', () => {
    expect(escapeMarkdown('\\*')).toBe('\\\\\\*');
  });
  it('leaves plain text alone', () => {
    expect(escapeMarkdown('Order flow v2')).toBe('Order flow v2');
  });
});

describe('oneLine', () => {
  it('collapses whitespace and line breaks, trims, and bounds the length', () => {
    expect(oneLine('  a\r\n\tb   c  ')).toBe('a b c');
    expect(oneLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(oneLine('x'.repeat(10), 10)).toBe('x'.repeat(10));
  });
});

describe('buildSubmissionFiles', () => {
  it('writes the five diagram files, with the source byte for byte', () => {
    const files = buildSubmissionFiles(input());
    expect(files.map((f) => f.path)).toEqual([
      'architecture/order-flow/README.md',
      'architecture/order-flow/order-flow.svg',
      'architecture/order-flow/order-flow.mmd',
      'architecture/order-flow/order-flow.canvas.mmd',
      'architecture/order-flow/canvas.json',
    ]);
    expect(files.find((f) => f.path.endsWith('.canvas.mmd'))!.content).toBe(input().dslContent);
    expect(files.find((f) => f.path.endsWith('.mmd') && !f.path.endsWith('canvas.mmd'))!.content).toBe(input().portableMermaid);
  });

  it('adds the standard under .canvas/standards/<type>/v<version>.json and names it in the manifest', () => {
    const standard = { id: 's1', version: 4, name: 'Rules', description: 'd', rules: { allowedShapeIds: ['rectangle'] } };
    const files = buildSubmissionFiles(input({ standard }));
    const file = files.find((f) => f.path === '.canvas/standards/flowchart/v4.json')!;
    expect(JSON.parse(file.content)).toEqual({ id: 's1', diagramTypeId: 'flowchart', version: 4, name: 'Rules', description: 'd', rules: { allowedShapeIds: ['rectangle'] } });
    const manifest = JSON.parse(files.find((f) => f.path.endsWith('canvas.json'))!.content);
    expect(manifest.standard).toEqual({ path: '.canvas/standards/flowchart/v4.json', id: 's1', version: 4, name: 'Rules' });
  });

  it('is deterministic: the same input gives the same files', () => {
    expect(buildSubmissionFiles(input())).toEqual(buildSubmissionFiles(input()));
  });

  it('refuses a path or type id that would escape (every generated path is re-validated)', () => {
    expect(() => buildSubmissionFiles(input({ path: '.github/workflows' }))).toThrow(InvalidRepoPathError);
    expect(() => buildSubmissionFiles(input({ path: 'a/../b' }))).toThrow(InvalidRepoPathError);
    expect(() => buildSubmissionFiles(input({ standard: { id: 's', version: 1, name: null, description: null, rules: {} }, diagramTypeId: '../../.github' }))).toThrow(InvalidRepoPathError);
  });

  it('escapes the diagram name, type and description in the README', () => {
    const readme = buildSubmissionFiles(input({ name: '@everyone **x**', diagramTypeName: '[T](u)', description: '@here <b>hi</b>' }))[0].content;
    expect(readme).not.toContain('@everyone');
    expect(readme).not.toContain('@here');
    expect(readme).not.toContain('<b>');
    expect(readme).toContain('# @' + ZWSP + 'everyone \\*\\*x\\*\\*');
  });

  it('says the picture is the layout from Canvas and GitHub lays out the Mermaid view itself (canvas-n85n)', () => {
    const readme = buildSubmissionFiles(input())[0].content;
    const picture = readme.indexOf('.svg)');
    const note = readme.indexOf('_Layout as drawn in Canvas._');
    expect(note).toBeGreaterThan(picture);
    const details = readme.indexOf('<summary>Mermaid source</summary>');
    const autoLayout = readme.indexOf('GitHub arranges this view automatically');
    expect(autoLayout).toBeGreaterThan(details);
    expect(autoLayout).toBeLessThan(readme.indexOf('mermaid\n'));
  });

  it('puts the Mermaid in a fence longer than any backtick run inside it', () => {
    for (const run of [3, 4, 7]) {
      const mermaid = `flowchart TD\n  A["${'`'.repeat(run)}"] --> B\n`;
      const readme = buildSubmissionFiles(input({ portableMermaid: mermaid }))[0].content;
      const open = readme.match(/^(`+)mermaid$/m)!;
      expect(open[1].length).toBe(run + 1);
      expect(readme).toContain(`\n${'`'.repeat(run + 1)}\n`);
    }
    // No backticks at all: the usual three.
    expect(buildSubmissionFiles(input())[0].content).toMatch(/^```mermaid$/m);
  });
});

describe('buildPrBody and buildPrTitle', () => {
  it('names the diagram, links to Canvas and the README, and carries the diagram marker', () => {
    const body = buildPrBody(input(), [], 'Olivia');
    expect(body).toContain('**Order Flow** submitted from Canvas for approval by Olivia');
    expect(body).toContain('(http://canvas.test/?diagramId=1)');
    expect(body).toContain('[README.md](architecture/order-flow/README.md)');
    expect(body).toContain('<!-- canvas:diagram=11111111-2222-4333-8444-555555555555 -->');
    expect(body).not.toContain('Standard findings');
  });

  it('escapes the submitter and warning text', () => {
    const body = buildPrBody(input(), [violation('Node @everyone is **bad**')], '@admin <x>');
    expect(body).not.toContain('@everyone');
    expect(body).not.toContain('@admin');
    expect(body).toContain('Warning: Node @' + ZWSP + 'everyone is \\*\\*bad\\*\\*');
  });

  it('lists at most 50 findings and says how many more there are', () => {
    const warnings = Array.from({ length: 63 }, (_, i) => violation(`finding ${i}`));
    const body = buildPrBody(input(), warnings, 'x');
    expect(body).toContain('### Standard findings (63)');
    expect(body.match(/^- Warning: finding/gm)).toHaveLength(50);
    expect(body).toContain('…and 13 more');
    expect(body).not.toContain('finding 50');
  });

  it('truncates a body over 60,000 characters, says so, and keeps the diagram marker', () => {
    const warnings = Array.from({ length: 50 }, (_, i) => violation(`${i}:${'x'.repeat(2500)}`));
    const body = buildPrBody(input(), warnings, 'x');
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain('…(truncated)');
    expect(body.endsWith('<!-- canvas:diagram=11111111-2222-4333-8444-555555555555 -->')).toBe(true);
  });

  it('a title is one line with the version, whatever the name contains', () => {
    expect(buildPrTitle({ name: 'Order\nFlow\r\n@x', versionSequence: 7 })).toBe('Canvas: Order Flow @x (version 7)');
    expect(buildPrTitle({ name: 'n'.repeat(300), versionSequence: 1 }).length).toBeLessThan(140);
  });
});

describe('buildCommitMessage', () => {
  const base = { name: 'Order Flow', versionSequence: 3, canvasUrl: 'http://canvas.test/?diagramId=1' };

  it('credits the Canvas user with a single Co-authored-by trailer', () => {
    const message = buildCommitMessage(base, { name: 'Olivia Owner', email: 'owner@example.com' }, false);
    expect(message.split('\n')[0]).toBe('Submit "Order Flow" (version 3) from Canvas');
    expect(message).toContain('\nCo-authored-by: Olivia Owner <owner@example.com>\n');
    expect(message.match(/Co-authored-by/g)).toHaveLength(1);
    expect(buildCommitMessage(base, { name: 'O', email: 'o@x.io' }, true).split('\n')[0]).toBe('Update "Order Flow" (version 3) from Canvas');
  });

  it('strips <>, and line breaks from the author, so a name cannot forge another trailer or identity', () => {
    const message = buildCommitMessage(base, { name: 'Eve <evil@x.io>\nCo-authored-by: Mallory <m@x.io>', email: 'eve@x.io>\nSigned-off-by: Z <z@x.io' }, false);
    const trailers = message.split('\n').filter((l) => /^[A-Za-z-]+: /.test(l) && !l.startsWith('Canvas:'));
    expect(trailers).toHaveLength(1);
    expect(trailers[0]).toMatch(/^Co-authored-by: [^<>]+ <[^<>\s]+>$/);
    expect(message).not.toContain('Signed-off-by:\n');
    expect(message.split('\n').filter((l) => l.startsWith('Signed-off-by'))).toEqual([]);
  });

  it('falls back to the email when the name is only brackets', () => {
    expect(buildCommitMessage(base, { name: '<>', email: 'a@b.io' }, false)).toContain('Co-authored-by: a@b.io <a@b.io>');
  });

  it('keeps a diagram name with line breaks to the one subject line', () => {
    const message = buildCommitMessage({ ...base, name: 'A\n\nCo-authored-by: Mallory <m@x.io>' }, { name: 'O', email: 'o@x.io' }, false);
    expect(message.split('\n').filter((l) => l.startsWith('Co-authored-by'))).toEqual(['Co-authored-by: O <o@x.io>']);
  });
});

describe('submissionFingerprint', () => {
  it('changes with the source, the name or the description, and not otherwise', () => {
    const base = submissionFingerprint('dsl', 'name', null);
    expect(submissionFingerprint('dsl', 'name', null)).toBe(base);
    expect(submissionFingerprint('dsl', 'name', '')).toBe(base);
    expect(submissionFingerprint('dsl2', 'name', null)).not.toBe(base);
    expect(submissionFingerprint('dsl', 'name2', null)).not.toBe(base);
    expect(submissionFingerprint('dsl', 'name', 'about')).not.toBe(base);
    // No ambiguity between fields.
    expect(submissionFingerprint('a', 'bc', null)).not.toBe(submissionFingerprint('ab', 'c', null));
  });
});
