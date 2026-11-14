// canvas-8uh1.5: an element kind can say its elements should link to a diagram of given types (`linkTo`), flagged
// as `kind-link` (Warning). Validation is told each linked diagram's type; a link it isn't told about is not judged.
import { describe, expect, it } from 'vitest';
import { checkStandardDefinition } from '../../src/standards/definition-check.js';
import { validate } from '../../src/standards/validator.js';
import { emptyStandardRules, type StandardRules } from '../../src/standards/schema.js';
import { parseC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { setDiagramLink } from '../../src/model/diagram-ops.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

const RULES: StandardRules = {
  ...emptyStandardRules(),
  elementKinds: [
    { id: 'system', label: 'Software System', shapes: [], approvedFills: [], match: { role: 'system', external: false }, linkTo: ['c4-container'] },
    { id: 'person', label: 'Person', shapes: [], approvedFills: [], match: { role: 'person' } },
  ],
};

function model(): DiagramModel {
  const result = parseC4('C4Context\n  Person(user, "Customer")\n  System(pay, "Payments")\n');
  if (!isParseSuccess(result)) throw new Error('parse');
  return result.model;
}
const kindLink = (m: DiagramModel, types?: Record<string, string>) => validate(m, RULES, { linkTargetTypes: types }).filter((v) => v.rule === 'kind-link');

describe('kind-link', () => {
  it('flags an element of the kind with no link, as a warning, and only that kind', () => {
    expect(kindLink(model())).toEqual([
      { elementId: 'pay', elementType: 'node', kindId: 'system', rule: 'kind-link', message: 'Software System "Payments" should link to a diagram (c4-container).', severity: 'warning' },
    ]);
  });

  it('accepts a link to a diagram of a listed type, or one whose type it is not told', () => {
    const linked = setDiagramLink(model(), 'pay', 'd-1');
    expect(kindLink(linked, { 'd-1': 'c4-container' })).toEqual([]);
    expect(kindLink(linked)).toEqual([]);
    expect(kindLink(linked, { other: 'flowchart' })).toEqual([]);
  });

  it('flags a link to a diagram of another type', () => {
    const linked = setDiagramLink(model(), 'pay', 'd-1');
    expect(kindLink(linked, { 'd-1': 'flowchart' }).map((v) => v.message)).toEqual([
      'Software System "Payments" links to a flowchart diagram; it should link to c4-container.',
    ]);
  });

  it('follows severity overrides', () => {
    expect(validate(model(), { ...RULES, severityOverrides: { 'kind-link': 'error' } }).find((v) => v.rule === 'kind-link')?.severity).toBe('error');
  });

  it("a standard's linkTo must name diagram types, once each", () => {
    const issues = checkStandardDefinition({ ...RULES, elementKinds: [{ ...RULES.elementKinds![0], linkTo: ['c4-container', 'Not A Type', 'c4-container'] }] }, 'c4');
    expect(issues.filter((i) => i.path.endsWith('linkTo')).map((i) => i.message)).toEqual(['"Not A Type" isn\'t a diagram type id.', '"c4-container" is listed twice.']);
  });
});
