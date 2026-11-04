// canvas-3vcj: Canvas documented as Canvas diagrams (docs/architecture/*.mmd). Each must be one Canvas reads:
// a known family, no parse errors, a save that reads back, and a drawing after Auto Layout.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectDslFamily } from '../../src/dsl/detect.js';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { autoLayout, supportsAutoLayout } from '../../src/model/auto-layout.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';

const DIR = fileURLToPath(new URL('../../../../docs/architecture/', import.meta.url));
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.mmd')).sort();

describe('docs/architecture diagrams', () => {
  it('cover every family Canvas reads', () => {
    const families = new Set(FILES.map((f) => detectDslFamily(readFileSync(join(DIR, f), 'utf8'))));
    expect([...families].sort()).toEqual(['c4', 'erd', 'flowchart', 'sequence', 'state', 'uml']);
  });

  it.each(FILES)('%s parses, saves and draws', (file) => {
    const dsl = readFileSync(join(DIR, file), 'utf8');
    const familyId = detectDslFamily(dsl);
    expect(familyId, 'a known header').toBeDefined();
    const family = getDslFamily(familyId!)!;
    const parsed = family.parse(dsl);
    expect(isParseSuccess(parsed) ? [] : parsed.errors).toEqual([]);
    if (!isParseSuccess(parsed)) return;
    expect(parsed.model.nodes.length).toBeGreaterThan(0);
    const again = family.parse(family.serialize(parsed.model));
    expect(isParseSuccess(again) ? [] : again.errors).toEqual([]);
    const model = supportsAutoLayout(familyId!) ? autoLayout(parsed.model, undefined, familyId!) : parsed.model;
    expect(renderToSvg(model)).toMatch(/^<svg /);
  });
});
