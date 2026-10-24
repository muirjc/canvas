import { describe, expect, it } from 'vitest';
import { assertSafeRepoPath, InvalidRepoPathError, normalizeFolder, slugify } from '../../src/github/folder-path.js';

/** canvas-3s5.1: every path Canvas commits passes these checks, so a name can never reach .git, workflows or another folder. */
describe('normalizeFolder', () => {
  it('trims, unifies separators and strips leading/trailing/duplicate slashes', () => {
    expect(normalizeFolder('  /architecture//diagrams/ ')).toBe('architecture/diagrams');
    expect(normalizeFolder('a\\b\\c')).toBe('a/b/c');
    expect(normalizeFolder('docs')).toBe('docs');
    expect(normalizeFolder('v1.2/my_docs-x')).toBe('v1.2/my_docs-x');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['root', '/'],
    ['dot-dot', '..'],
    ['embedded dot-dot', 'a/../b'],
    ['backslash dot-dot', 'a\\..\\b'],
    ['dot', 'a/./b'],
    ['.github', '.github'],
    ['.github case-insensitive', 'docs/.GitHub/workflows'],
    ['.git', '.git'],
    ['.git nested', 'a/.git/b'],
    ['.canvas', '.canvas/standards'],
    ['.gitmodules', '.gitmodules'],
    ['hidden folder', 'docs/.hidden'],
    ['space', 'my docs'],
    ['control character', 'a/\u0000b'],
    ['newline', 'a\nb'],
    ['semicolon', 'a;b'],
    ['unicode', 'diagrammes/é'],
    ['leading dash', '-rf'],
    ['too deep', Array.from({ length: 11 }, (_, i) => `d${i}`).join('/')],
    ['too long', 'x'.repeat(201)],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeFolder(input)).toThrow(InvalidRepoPathError);
  });

  it('allows ten levels and 200 characters', () => {
    expect(normalizeFolder(Array.from({ length: 10 }, (_, i) => `d${i}`).join('/'))).toContain('d9');
    expect(normalizeFolder('x'.repeat(200))).toHaveLength(200);
  });
});

describe('slugify', () => {
  it('makes a kebab-case slug', () => {
    expect(slugify('Order Flow')).toBe('order-flow');
    expect(slugify('  Payments -- v2 (draft)!  ')).toBe('payments-v2-draft');
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
  });
  it('falls back to "diagram" when nothing usable is left', () => {
    expect(slugify('')).toBe('diagram');
    expect(slugify('!!!')).toBe('diagram');
    expect(slugify('日本語')).toBe('diagram');
  });
  it('is at most 60 characters with no trailing dash', () => {
    const slug = slugify(`${'a'.repeat(59)} bbb`);
    expect(slug).toHaveLength(59);
    expect(slug.endsWith('-')).toBe(false);
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });
  it('can never produce a path that assertSafeRepoPath rejects', () => {
    for (const name of ['../../etc/passwd', '.github', '.git', '..', 'a/b', 'C:\\x', '%2e%2e', 'con.']) {
      expect(() => assertSafeRepoPath(`docs/${slugify(name)}/README.md`), name).not.toThrow();
    }
  });
});

describe('assertSafeRepoPath', () => {
  it('accepts diagram files and Canvas standards', () => {
    expect(assertSafeRepoPath('architecture/order-flow/README.md')).toBe('architecture/order-flow/README.md');
    expect(assertSafeRepoPath('architecture/order-flow/order-flow.canvas.mmd')).toBeTruthy();
    expect(assertSafeRepoPath('.canvas/standards/flowchart/v1.json')).toBeTruthy();
  });
  it.each([
    '.github/workflows/x.yml',
    'a/.github/workflows/x.yml',
    '.git/config',
    'a/../b',
    '/abs/path',
    'a//b',
    'a/',
    '',
    '.canvas/../x.json',
    '.canvas/.github/x',
    '.canvas//x',
    '.canvasx/x',
    'a/\u0000/b',
    `${'x/'.repeat(5)}${'y'.repeat(330)}`,
  ])('rejects %j', (path) => {
    expect(() => assertSafeRepoPath(path)).toThrow(InvalidRepoPathError);
  });
});
