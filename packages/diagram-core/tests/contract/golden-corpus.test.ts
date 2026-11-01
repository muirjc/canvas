import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectDslFamily } from '../../src/dsl/detect.js';
import { toPortableMermaid } from '../../src/dsl/portable-mermaid.js';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';
import type { StandardRules } from '../../src/standards/schema.js';
import { validate } from '../../src/standards/validator.js';

/**
 * canvas-1bty.5: the golden corpus (packages/diagram-core/corpus, see its README). Language-neutral
 * cases -- Mermaid in, every server-side output as files -- that the TypeScript diagram-core
 * generates and passes, and that the Python port must pass byte for byte (SVG as normalised XML)
 * before it replaces the bridge. Regenerate after an intended change with
 *   UPDATE_CORPUS=1 npx vitest run tests/contract/golden-corpus.test.ts
 * and review the diff: every changed file is a behaviour change both implementations must share.
 */

const CORPUS = fileURLToPath(new URL('../../corpus/', import.meta.url));
const UPDATE = process.env.UPDATE_CORPUS === '1';

/** JSON with keys sorted at every level, two-space indent, trailing newline: one canonical text. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

const standards = Object.fromEntries(
  readdirSync(join(CORPUS, 'standards'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(CORPUS, 'standards', f), 'utf8')) as StandardRules]),
);

/** Every output the server side produces for one input, by file name under expected/. */
function outputs(input: string, meta: { standards?: string[] }): Record<string, string> {
  const familyId = detectDslFamily(input);
  if (!familyId) return { 'errors.json': canonicalJson({ errors: [{ message: 'Unrecognized diagram header' }] }) };
  const family = getDslFamily(familyId)!;
  const parsed = family.parse(input);
  if (!isParseSuccess(parsed)) return { 'family.txt': `${familyId}\n`, 'errors.json': canonicalJson(parsed) };
  const files: Record<string, string> = {
    'family.txt': `${familyId}\n`,
    'model.json': canonicalJson(parsed.model),
    'serialized.mmd': family.serialize(parsed.model),
    'portable.mmd': toPortableMermaid(input, { stripFrontMatter: true }),
    'render.svg': `${renderToSvg(parsed.model)}\n`,
  };
  for (const id of meta.standards ?? []) {
    if (!standards[id]) throw new Error(`case names an unknown standard: ${id}`);
    files[`violations-${id}.json`] = canonicalJson(validate(parsed.model, standards[id]));
  }
  return files;
}

const cases = readdirSync(join(CORPUS, 'cases')).sort();

describe('golden corpus (canvas-1bty.5)', () => {
  it('has cases for every diagram family, and the standards they name', () => {
    const families = new Set(cases.map((c) => detectDslFamily(readFileSync(join(CORPUS, 'cases', c, 'input.mmd'), 'utf8'))));
    for (const f of ['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml']) expect(families.has(f), f).toBe(true);
  });

  it.each(cases)('%s', (name) => {
    const dir = join(CORPUS, 'cases', name);
    const input = readFileSync(join(dir, 'input.mmd'), 'utf8');
    const meta = existsSync(join(dir, 'case.json')) ? (JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as { standards?: string[] }) : {};
    const actual = outputs(input, meta);
    const expectedDir = join(dir, 'expected');

    if (UPDATE) {
      rmSync(expectedDir, { recursive: true, force: true });
      mkdirSync(expectedDir, { recursive: true });
      for (const [file, content] of Object.entries(actual)) writeFileSync(join(expectedDir, file), content);
    }

    expect(readdirSync(expectedDir).sort(), 'the expected files').toEqual(Object.keys(actual).sort());
    for (const [file, content] of Object.entries(actual)) {
      expect(content, `${name}/expected/${file}`).toBe(readFileSync(join(expectedDir, file), 'utf8'));
    }

    // Round trips keep every element, and settle: serializing the serialized output again changes
    // nothing. (The first round trip may reorder elements declared inside groups -- canvas-ra0g.)
    if ('serialized.mmd' in actual) {
      const family = getDslFamily(detectDslFamily(input)!)!;
      const once = family.parse(actual['serialized.mmd']);
      expect(isParseSuccess(once), `${name}: serialized output parses`).toBe(true);
      if (!isParseSuccess(once)) return;
      const original = family.parse(input);
      if (!isParseSuccess(original)) return;
      const byId = <T extends { id: string }>(items: T[]) => canonicalJson([...items].sort((a, b) => a.id.localeCompare(b.id)));
      expect(byId(once.model.nodes), `${name}: nodes`).toBe(byId(original.model.nodes));
      expect(byId(once.model.edges), `${name}: edges`).toBe(byId(original.model.edges));
      const second = family.serialize(once.model);
      const twice = family.parse(second);
      expect(isParseSuccess(twice) && family.serialize(twice.model), `${name}: settles after one round trip`).toBe(second);
    }
  });
});
