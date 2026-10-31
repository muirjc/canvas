import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { formatGitHub, formatSummary } from '../src/report.js';
import { findManifests, validateRepository, type ValidationReport } from '../src/validate-repo.js';
import { BUNDLE, MIN_STEPS_RULES, SAMPLES, runBundle, sha, tempDir, write, writeDiagram } from './helpers.js';

/** Rules under which node B (class "mystery") is an unknown kind at the given severity. */
const unknownKindRules = (severity: 'error' | 'warning' | 'info') => ({
  requireKnownKinds: true,
  elementKinds: [{ id: 'step', label: 'Step', shapes: [], approvedFills: [] }],
  severityOverrides: { 'unknown-kind': severity },
});
const MYSTERY_DSL = 'flowchart TD\n  A[Alpha]:::step --> B[Beta]:::mystery\n';

let root: string;
beforeEach(() => {
  root = tempDir();
});

describe('the bundled validator (node dist/validator.mjs)', () => {
  it('exits 0 for a clean repository with a diagram in every family', async () => {
    for (const family of Object.keys(SAMPLES)) writeDiagram(root, { folder: `docs/${family}`, slug: family, family, name: family });
    const res = await runBundle(['--root', root, '--format', 'text']);
    expect(res.stdout).toContain('6 diagrams checked: 0 errors, 0 warnings.');
    expect(res.code).toBe(0);
  });

  it('a syntax error exits 1 with an annotation on the source file and line', async () => {
    writeDiagram(root, { dsl: 'flowchart TD\n  A[Ok] --> B[Fine]\n  this is not valid ((\n' });
    const res = await runBundle(['--root', root, '--format', 'github']);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/^::error file=architecture\/order-flow\/order-flow\.canvas\.mmd,line=3,title=Syntax error/m);
  });

  it('a Must fix violation exits 1 with the element line; warnings and info do not fail', async () => {
    writeDiagram(root, { dsl: MYSTERY_DSL, rules: unknownKindRules('error') });
    const failing = await runBundle(['--root', root, '--format', 'github']);
    expect(failing.code).toBe(1);
    expect(failing.stdout).toMatch(/^::error file=architecture\/order-flow\/order-flow\.canvas\.mmd,line=2,title=Must fix/m);

    writeDiagram(root, { dsl: MYSTERY_DSL, rules: unknownKindRules('warning') });
    const warned = await runBundle(['--root', root, '--format', 'github']);
    expect(warned.code).toBe(0);
    expect(warned.stdout).toMatch(/^::warning file=.*line=2,title=Warning/m);

    writeDiagram(root, { dsl: MYSTERY_DSL, rules: unknownKindRules('info') });
    const info = await runBundle(['--root', root, '--format', 'github']);
    expect(info.code).toBe(0);
    expect(info.stdout).toMatch(/^::notice file=.*line=2,title=Info/m);
  });

  it('is self-contained: runs from an empty directory outside the repository', async () => {
    writeDiagram(root, { dsl: MYSTERY_DSL, rules: unknownKindRules('error') });
    const lonely = tempDir('canvas-validator-bundle-');
    const copy = join(lonely, 'validator.mjs');
    copyFileSync(BUNDLE, copy);
    const res = await runBundle(['--root', root, '--format', 'github'], { cwd: lonely, bundle: copy });
    expect(res.stderr).toBe('');
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('::error file=');
  });

  it('stays small and leaves the icon libraries out', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    expect(statSync(BUNDLE).size).toBeLessThan(400 * 1024);
    expect(text).not.toContain('azure-icons');
  });

  it('--help and --version exit 0; unknown options and bad values exit 2', async () => {
    const help = await runBundle(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: node .canvas/validator.mjs');
    const version = await runBundle(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version);

    const unknown = await runBundle(['--nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown option --nope');
    expect((await runBundle(['--format', 'xml'])).code).toBe(2);
    expect((await runBundle(['--root'])).code).toBe(2);
  });

  it('defaults --format to github when GITHUB_ACTIONS=true, text otherwise', async () => {
    writeDiagram(root, { dsl: MYSTERY_DSL, rules: unknownKindRules('warning') });
    const gh = await runBundle(['--root', root], { env: { GITHUB_ACTIONS: 'true' } });
    expect(gh.stdout).toContain('::warning ');
    const plain = await runBundle(['--root', root]);
    expect(plain.stdout).not.toContain('::warning');
    expect(plain.stdout).toContain('ok  Order Flow');
  });

  it('appends a markdown summary to GITHUB_STEP_SUMMARY', async () => {
    writeDiagram(root, { dsl: MYSTERY_DSL, rules: unknownKindRules('error') });
    const summary = join(root, 'summary.md');
    writeFileSync(summary, 'earlier step\n');
    await runBundle(['--root', root], { env: { GITHUB_STEP_SUMMARY: summary } });
    const text = readFileSync(summary, 'utf8');
    expect(text.startsWith('earlier step\n')).toBe(true);
    expect(text).toContain('## Canvas diagrams');
    expect(text).toContain('Fails');
  });
});

describe('validateRepository', () => {
  const findings = (report: ValidationReport) => report.diagrams.flatMap((d) => d.findings);

  it('finds nothing and reports it when there are no manifests', () => {
    const report = validateRepository({ root });
    expect(report.diagrams).toEqual([]);
    expect(runCli(['--root', root], {}).stdout).toContain('No Canvas diagrams found');
    expect(runCli(['--root', root], {}).exitCode).toBe(0);
  });

  it('a source edited after submission warns (hash mismatch) but passes', () => {
    writeDiagram(root, { hash: sha('something else') });
    const report = validateRepository({ root });
    expect(findings(report)).toEqual([expect.objectContaining({ level: 'warning', title: 'Edited outside Canvas', file: 'architecture/order-flow/order-flow.canvas.mmd' })]);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(1);
  });

  it('a missing portable or svg file is a warning', () => {
    writeDiagram(root, { companions: false });
    expect(findings(validateRepository({ root })).map((f) => [f.level, f.title])).toEqual([
      ['warning', 'Missing file'],
      ['warning', 'Missing file'],
    ]);
  });

  it('a standard with only some fields still applies (merged over empty rules)', () => {
    writeDiagram(root, { dsl: 'flowchart TD\n  A[Only]:::step\n', rules: MIN_STEPS_RULES });
    const report = validateRepository({ root });
    expect(report.errorCount).toBeGreaterThan(0);
    expect(findings(report)[0]).toMatchObject({ level: 'error', title: 'Must fix' });
  });

  describe('errors', () => {
    it('unreadable manifest', () => {
      write(root, 'x/canvas.json', '{not json');
      expect(findings(validateRepository({ root }))).toEqual([expect.objectContaining({ level: 'error', title: 'Unreadable manifest', file: 'x/canvas.json' })]);
    });

    it('unknown schema or missing fields', () => {
      writeDiagram(root, { manifest: { schema: 2 } });
      expect(findings(validateRepository({ root }))[0]).toMatchObject({ level: 'error', title: 'Unsupported manifest' });
      writeDiagram(root, { manifest: { dslFamily: undefined } });
      expect(findings(validateRepository({ root }))[0]).toMatchObject({ level: 'error', title: 'Unsupported manifest' });
    });

    it('unknown family', () => {
      writeDiagram(root, { manifest: { dslFamily: 'timeline' } });
      expect(findings(validateRepository({ root }))).toEqual([expect.objectContaining({ level: 'error', title: 'Unknown diagram family' })]);
    });

    it('missing source', () => {
      writeDiagram(root, { manifest: { source: 'gone.canvas.mmd' } });
      expect(findings(validateRepository({ root }))).toEqual([expect.objectContaining({ level: 'error', title: 'Missing source' })]);
    });

    it('missing standard file, and a standard that is not valid JSON or has no rules', () => {
      writeDiagram(root, { manifest: { standard: { path: '.canvas/standards/x/v1.json', version: 1, name: 'X' } } });
      expect(findings(validateRepository({ root }))).toEqual([expect.objectContaining({ level: 'error', title: 'Missing standard' })]);

      write(root, '.canvas/standards/x/v1.json', 'nope');
      expect(findings(validateRepository({ root }))).toEqual([expect.objectContaining({ level: 'error', title: 'Unreadable standard', file: '.canvas/standards/x/v1.json' })]);

      write(root, '.canvas/standards/x/v1.json', '{"id":"s"}');
      expect(findings(validateRepository({ root }))).toEqual([expect.objectContaining({ level: 'error', title: 'Unreadable standard' })]);
    });
  });

  describe('paths stay confined', () => {
    it('rejects a source that escapes the diagram folder, relative or absolute', () => {
      write(root, 'secret.txt', 'flowchart TD\n  A --> B\n');
      for (const source of ['../../secret.txt', '../order-flow/../../secret.txt', join(root, 'secret.txt'), '/etc/passwd']) {
        writeDiagram(root, { manifest: { source } });
        expect(findings(validateRepository({ root })), source).toEqual([expect.objectContaining({ level: 'error', title: 'Missing source' })]);
      }
    });

    it('a source in a sibling folder of the same repository is also rejected (confined to its own folder)', () => {
      write(root, 'other/x.canvas.mmd', SAMPLES.flowchart);
      writeDiagram(root, { manifest: { source: '../../other/x.canvas.mmd' } });
      expect(findings(validateRepository({ root }))[0]).toMatchObject({ title: 'Missing source' });
    });

    it('rejects a standard outside the repository, relative or absolute', () => {
      write(tempDir('outside-'), 'x', '');
      for (const path of ['../../../etc/passwd', '/etc/passwd', '../outside/v1.json']) {
        writeDiagram(root, { manifest: { standard: { path, version: 1, name: 'X' } } });
        expect(findings(validateRepository({ root })), path).toEqual([expect.objectContaining({ level: 'error', title: 'Missing standard' })]);
      }
    });

    it('does not read a companion outside the folder (reported missing, not followed)', () => {
      writeDiagram(root, { manifest: { svg: '../../README.md' } });
      write(root, 'README.md', '# hi');
      expect(findings(validateRepository({ root })).map((f) => f.title)).toEqual(['Missing file']);
    });
  });

  describe('discovery', () => {
    it('skips node_modules, .git and dot-folders', () => {
      writeDiagram(root, { folder: 'real', slug: 'real' });
      for (const folder of ['node_modules/pkg', '.git/x', '.hidden/diagrams', 'real/.cache']) writeDiagram(root, { folder, slug: 'd' });
      expect(findManifests(root).map((m) => m.slice(root.length + 1))).toEqual(['real/canvas.json']);
    });

    it('finds nested diagrams and narrows to positional paths (folders or a manifest)', () => {
      writeDiagram(root, { folder: 'a/one', slug: 'one', name: 'One' });
      writeDiagram(root, { folder: 'b/two', slug: 'two', name: 'Two', dsl: 'flowchart TD\n  A[x\n' });
      expect(validateRepository({ root }).diagrams.map((d) => d.name)).toEqual(['One', 'Two']);
      expect(validateRepository({ root, paths: ['a'] }).diagrams.map((d) => d.name)).toEqual(['One']);
      expect(validateRepository({ root, paths: ['b/two/canvas.json'] }).diagrams.map((d) => d.name)).toEqual(['Two']);
      expect(validateRepository({ root, paths: ['nope'] }).diagrams).toEqual([]);
      expect(runCli(['--root', root, 'a'], {}).exitCode).toBe(0);
    });
  });

  describe('--render-dir', () => {
    it('writes one SVG per diagram, mirroring its folder', () => {
      writeDiagram(root, { folder: 'a/one', slug: 'one' });
      writeDiagram(root, { folder: 'b/c4', slug: 'c4', family: 'c4', name: 'C4' });
      const out = join(tempDir('rendered-'), 'svg');
      const report = validateRepository({ root, renderDir: out });
      expect(report.diagrams.every((d) => d.rendered)).toBe(true);
      expect(existsSync(join(out, 'a/one/one.svg'))).toBe(true);
      expect(existsSync(join(out, 'b/c4/c4.svg'))).toBe(true);
      expect(readFileSync(join(out, 'a/one/one.svg'), 'utf8')).toContain('<svg');
    });

    it('does not render a diagram that failed to parse', () => {
      writeDiagram(root, { dsl: 'flowchart TD\n  A[x\n' });
      const out = join(tempDir('rendered-'), 'svg');
      validateRepository({ root, renderDir: out });
      expect(existsSync(out)).toBe(false);
    });

    it('via the CLI flag', () => {
      writeDiagram(root);
      const out = join(tempDir('rendered-'), 'svg');
      expect(runCli(['--root', root, '--render-dir', out], {}).exitCode).toBe(0);
      expect(readdirSync(join(out, 'architecture/order-flow'))).toEqual(['order-flow.svg']);
    });
  });
});

// canvas-finl: Markdown documents that embed a diagram (<!-- MERMAID: path -->).
describe('documents that embed a diagram', () => {
  let root: string;
  const MMD = 'architecture/order-flow/order-flow.mmd';
  const SVG = 'architecture/order-flow/order-flow.svg';
  beforeEach(() => {
    root = tempDir();
    writeDiagram(root);
  });
  const doc = () => readFileSync(join(root, 'docs/hld.md'), 'utf8');
  const docResult = (report: ValidationReport) => report.documents.find((d) => d.file === 'docs/hld.md')!;

  it('a filled, current copy passes; documents without markers are not reported', () => {
    write(root, 'docs/hld.md', `# HLD\n<!-- MERMAID: ${MMD} -->\n`);
    write(root, 'docs/plain.md', '# Nothing\n');
    validateRepository({ root, fixDocs: true });
    const report = validateRepository({ root });
    expect(report.errorCount).toBe(0);
    expect(report.documents).toEqual([{ file: 'docs/hld.md', findings: [], fixed: false }]);
  });

  it('an out-of-date copy fails the check with a line number, and --fix-docs repairs it', () => {
    write(root, 'docs/hld.md', `# HLD\n<!-- MERMAID: ${MMD} -->\n\`\`\`mermaid\nflowchart TD\n  Old --> Stuff\n\`\`\`\n<!-- /MERMAID -->\n`);
    const before = validateRepository({ root });
    expect(before.errorCount).toBe(1);
    expect(docResult(before).findings[0]).toMatchObject({ level: 'error', file: 'docs/hld.md', line: 2, title: 'Embedded diagram out of date' });
    expect(runCli(['--root', root, '--format', 'text'], {}).exitCode).toBe(1);

    const fixed = runCli(['--root', root, '--fix-docs', '--format', 'text'], {});
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stdout).toContain('Embedded diagram updated');
    expect(doc()).not.toContain('Old --> Stuff');
    expect(doc()).toContain(readFileSync(join(root, MMD), 'utf8').trimEnd());
    expect(validateRepository({ root }).errorCount).toBe(0);
  });

  it('a marker with nothing under it is a warning (not a failure) until filled', () => {
    write(root, 'docs/hld.md', `<!-- MERMAID: ${SVG} -->\n`);
    const report = validateRepository({ root });
    expect(report.errorCount).toBe(0);
    expect(docResult(report).findings[0]).toMatchObject({ level: 'warning', line: 1, title: 'Embedded diagram not filled in' });
    validateRepository({ root, fixDocs: true });
    expect(doc()).toBe(`<!-- MERMAID: ${SVG} -->\n![order-flow](../architecture/order-flow/order-flow.svg)\n<!-- /MERMAID -->\n`);
  });

  it('a marker pointing at a missing file, or at something it cannot embed, is a warning', () => {
    write(root, 'docs/hld.md', '<!-- MERMAID: architecture/order_flow/order_flow.mmd -->\n<!-- MERMAID: architecture/order-flow/order-flow.canvas.mmd -->\n');
    const report = validateRepository({ root, fixDocs: true });
    expect(report.errorCount).toBe(0);
    expect(docResult(report).findings.map((f) => [f.level, f.line, f.title])).toEqual([
      ['warning', 1, 'Embedded diagram not found'],
      ['warning', 2, 'Embedded diagram path not supported'],
    ]);
    expect(doc()).toBe('<!-- MERMAID: architecture/order_flow/order_flow.mmd -->\n<!-- MERMAID: architecture/order-flow/order-flow.canvas.mmd -->\n');
  });

  it('marks out-of-date documents on the pull request and in the step summary', () => {
    write(root, 'docs/hld.md', `<!-- MERMAID: ${MMD} -->\n\`\`\`mermaid\nstale\n\`\`\`\n<!-- /MERMAID -->\n`);
    const report = validateRepository({ root });
    expect(formatGitHub(report)).toContain('::error file=docs/hld.md,line=1,title=Embedded diagram out of date::');
    expect(formatSummary(report)).toContain('| `docs/hld.md` | ❌ Out of date |');
    expect(formatGitHub(report)).toContain('1 diagram and 1 document embedding diagrams checked: 1 error');
  });
});

describe('report formatting', () => {
  const report = (over: { name?: string; file?: string; message: string; title?: string }): ValidationReport => ({
    documents: [],
    diagrams: [
      {
        manifest: 'm/canvas.json',
        name: over.name ?? 'D',
        diagramType: null,
        standard: null,
        findings: [{ level: 'error', file: over.file ?? 'f.mmd', line: 3, title: over.title ?? 'T', message: over.message }],
      },
    ],
    errorCount: 1,
    warningCount: 0,
  });

  it('escapes %, newlines and carriage returns in the message', () => {
    const out = formatGitHub(report({ message: '100% bad\nsecond\rthird: kept, as is' }));
    expect(out).toContain('::100%25 bad%0Asecond%0Dthird: kept, as is\n');
  });

  it("escapes ':' and ',' (as well as % and newlines) in properties", () => {
    const out = formatGitHub(report({ file: 'a,b:c%d\ne.mmd', name: 'x:y,z', message: 'm' }));
    expect(out).toContain('file=a%2Cb%3Ac%25d%0Ae.mmd,line=3,');
    expect(out).toContain('title=T (x%3Ay%2Cz)::m');
  });

  it('a workflow-command cannot be injected through a message', () => {
    const out = formatGitHub(report({ message: 'x\n::error::injected' }));
    expect(out.split('\n').filter((l) => l.startsWith('::'))).toHaveLength(1);
  });

  it('summary escapes table pipes, newlines and html', () => {
    const md = formatSummary(report({ name: 'a|b', message: 'x\ny <script>' }));
    expect(md).toContain('a\\|b');
    expect(md).toContain('x y &lt;script>');
    expect(md).toContain('Fails');
  });
});
