import { describe, expect, it } from 'vitest';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

// canvas-tfr: `_Ext` macros set DiagramNode.external instead of collapsing onto the base kind.

function parse(dsl: string): DiagramModel {
  const result = parseC4(dsl);
  if (!isParseSuccess(result)) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
  return result.model;
}

describe('C4 _Ext round trip', () => {
  it.each([
    ['C4Context', 'System_Ext', 'system', 'rectangle'],
    ['C4Context', 'Person_Ext', 'person', 'person'],
    ['C4Context', 'SystemDb_Ext', 'system', 'cylinder'],
    ['C4Container', 'Container_Ext', 'container', 'rounded-rectangle'],
    ['C4Component', 'ComponentQueue_Ext', 'component', 'stadium'],
  ] as const)('%s %s -> external with role %s / shape %s', (header, keyword, role, shape) => {
    const node = parse(`${header}\n  ${keyword}(x, "X")\n`).nodes.find((n) => n.id === 'x')!;
    expect(node.external).toBe(true);
    expect(node.role).toBe(role);
    expect(node.shape).toBe(shape);
  });

  it.each([
    ['System', 'system'],
    ['Person', 'person'],
  ] as const)('non-_Ext %s leaves external falsy', (keyword, role) => {
    const node = parse(`C4Context\n  ${keyword}(x, "X")\n`).nodes.find((n) => n.id === 'x')!;
    expect(node.role).toBe(role);
    expect(node.external ?? false).toBe(false);
  });

  it.each(['System_Ext', 'Person_Ext', 'SystemDb_Ext'])('serializeC4 emits %s back', (keyword) => {
    const model = parse(`C4Context\n  ${keyword}(email, "Email")\n`);
    expect(serializeC4(model)).toContain(`${keyword}(email, `);
  });

  it('does not emit _Ext for an internal system', () => {
    const dsl = serializeC4(parse('C4Context\n  System(a, "A")\n'));
    expect(dsl).not.toContain('_Ext');
  });

  it('parse -> serialize -> parse is stable for a mixed diagram', () => {
    const first = parse(
      'C4Context\n  Person(u, "User")\n  Person_Ext(auditor, "Auditor")\n  System(core, "Core")\n  System_Ext(email, "Email")\n  Rel(u, core, "Uses")\n  Rel(core, email, "Sends")\n',
    );
    const second = parse(serializeC4(first));
    const pick = (m: DiagramModel) => m.nodes.map((n) => ({ id: n.id, role: n.role, shape: n.shape, ext: n.external ?? false }));
    expect(pick(second)).toEqual(pick(first));
    expect(pick(second).filter((n) => n.ext).map((n) => n.id)).toEqual(['auditor', 'email']);
  });
});
