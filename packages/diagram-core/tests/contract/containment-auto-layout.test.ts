import { describe, expect, it } from 'vitest';
import { parseC4 } from '../../src/dsl/c4.js';
import { serializeC4 } from '../../src/dsl/c4.js';
import { parseUml, serializeUml } from '../../src/dsl/uml.js';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * canvas-m0g: live-reported against the real bank-boundary C4 example — parentContainerId chains
 * parsed correctly, but nothing ever converted that hierarchy into geometry (one flat, shared,
 * auto-position counter with zero containment awareness). These exercise the actual parser wiring
 * end to end (real DSL text, no front-matter) for all three affected families, not just the
 * shared computeContainmentLayout() unit (containment-layout.test.ts) in isolation.
 */
function encloses(
  parentPos: { x: number; y: number },
  parentSize: { width: number; height: number },
  childPos: { x: number; y: number },
  childSize: { width: number; height: number },
): boolean {
  return (
    childPos.x >= parentPos.x &&
    childPos.y >= parentPos.y &&
    childPos.x + childSize.width <= parentPos.x + parentSize.width &&
    childPos.y + childSize.height <= parentPos.y + parentSize.height
  );
}

describe('canvas-m0g: C4 boundary nesting gets real containment-aware geometry', () => {
  // The bug's own reported reproduction, condensed: BankBoundary0 (outermost) > BankBoundary >
  // {BankBoundary2, BankBoundary3}.
  const dsl = [
    'C4Context',
    'Person(customer, "Customer")',
    'Enterprise_Boundary(b0, "BankBoundary0") {',
    '  System_Boundary(b1, "BankBoundary") {',
    '    System_Boundary(b2, "BankBoundary2") {',
    '      System(sysA, "System A")',
    '    }',
    '    System_Boundary(b3, "BankBoundary3") {',
    '      System(sysB, "System B")',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  function parseOk(): DiagramModel {
    const result = parseC4(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) throw new Error('unreachable');
    return result.model;
  }

  it('b1 is enclosed by b0, and b2/b3 are enclosed by b1', () => {
    const model = parseOk();
    const pos = (id: string) => model.containers.find((c) => c.id === id)!.position;
    const size = (id: string) => model.containers.find((c) => c.id === id)!.size!;
    expect(encloses(pos('b0'), size('b0'), pos('b1'), size('b1'))).toBe(true);
    expect(encloses(pos('b1'), size('b1'), pos('b2'), size('b2'))).toBe(true);
    expect(encloses(pos('b1'), size('b1'), pos('b3'), size('b3'))).toBe(true);
  });

  it('b2 and b3 are also transitively enclosed by the outermost b0, not just their direct parent', () => {
    const model = parseOk();
    const pos = (id: string) => model.containers.find((c) => c.id === id)!.position;
    const size = (id: string) => model.containers.find((c) => c.id === id)!.size!;
    expect(encloses(pos('b0'), size('b0'), pos('b2'), size('b2'))).toBe(true);
    expect(encloses(pos('b0'), size('b0'), pos('b3'), size('b3'))).toBe(true);
  });

  it('sysA/sysB are enclosed by their own direct boundary (b2/b3)', () => {
    const model = parseOk();
    const pos = (id: string) => model.containers.find((c) => c.id === id)!.position;
    const size = (id: string) => model.containers.find((c) => c.id === id)!.size!;
    const nodeSize = { width: 140, height: 60 };
    expect(encloses(pos('b2'), size('b2'), model.nodes.find((n) => n.id === 'sysA')!.position, nodeSize)).toBe(true);
    expect(encloses(pos('b3'), size('b3'), model.nodes.find((n) => n.id === 'sysB')!.position, nodeSize)).toBe(true);
  });

  it('the computed geometry survives a serialize -> reparse round-trip unchanged (idempotent)', () => {
    const model = parseOk();
    const reexported = serializeC4(model);
    const reparsedResult = parseC4(reexported);
    expect(isParseSuccess(reparsedResult)).toBe(true);
    if (!isParseSuccess(reparsedResult)) return;
    // Containers compare by value (their id-keyed identity is what canvas-m0g's own geometry
    // guarantee is about). Nodes compare by id-sorted value, NOT array order: serializeC4's own
    // recursive per-boundary emission order (a pre-existing characteristic, unrelated to this fix)
    // doesn't preserve strict original top-level-vs-nested declaration order, so nodesById's own
    // insertion order legitimately differs between the two parses even though every node's own
    // computed position is identical either way.
    expect(reparsedResult.model.containers).toEqual(model.containers);
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...reparsedResult.model.nodes].sort(byId)).toEqual([...model.nodes].sort(byId));
    // A second round of serialize -> reparse must be a true fixed point relative to ITS OWN first
    // serialization, not merely "changed once then stabilized" — this compares generation 2 against
    // generation 3, sidestepping the (pre-existing, unrelated) generation-1-vs-2 ordering artifact
    // above entirely.
    const secondReexported = serializeC4(reparsedResult.model);
    const secondReparsed = parseC4(secondReexported);
    expect(isParseSuccess(secondReparsed)).toBe(true);
    if (!isParseSuccess(secondReparsed)) return;
    expect(serializeC4(secondReparsed.model)).toBe(secondReexported);
  });

  it('a diagram WITH existing front-matter positions is left alone (only a fresh import gets the new layout)', () => {
    const model = parseOk();
    const alreadyPositioned = serializeC4(model);
    // Re-parsing already-positioned output must not silently recompute anything different.
    const reparsed = parseC4(alreadyPositioned);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.containers).toEqual(model.containers);
  });
});

describe('canvas-m0g: UML namespace nesting gets real containment-aware geometry', () => {
  const dsl = ['classDiagram', 'namespace Outer {', '  class A', '  namespace Inner {', '    class B', '  }', '}', ''].join('\n');

  it('a namespace nested inside another is enclosed by its parent', () => {
    const result = parseUml(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const model = result.model;
    const outer = model.containers.find((c) => c.id === 'Outer')!;
    const inner = model.containers.find((c) => c.id === 'Outer.Inner')!;
    expect(encloses(outer.position, outer.size!, inner.position, inner.size!)).toBe(true);
  });

  it('the computed geometry survives a serialize -> reparse round-trip unchanged', () => {
    const result = parseUml(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const reexported = serializeUml(result.model);
    const reparsed = parseUml(reexported);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.containers).toEqual(result.model.containers);
    expect(serializeUml(reparsed.model)).toBe(reexported);
  });
});

describe('canvas-m0g: flowchart nested subgraphs get real containment-aware geometry', () => {
  const dsl = ['flowchart TD', 'subgraph Outer', '  A[Node A]', '  subgraph Inner', '    B[Node B]', '  end', 'end', ''].join('\n');

  it('a subgraph nested inside another is enclosed by its parent, and its own node is enclosed by it', () => {
    const result = parseFlowchart(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const model = result.model;
    const outer = model.containers.find((c) => c.id === 'Outer')!;
    const inner = model.containers.find((c) => c.id === 'Inner')!;
    const nodeB = model.nodes.find((n) => n.id === 'B')!;
    expect(encloses(outer.position, outer.size!, inner.position, inner.size!)).toBe(true);
    expect(encloses(inner.position, inner.size!, nodeB.position, { width: 140, height: 60 })).toBe(true);
  });

  it('the computed geometry survives a serialize -> reparse round-trip unchanged', () => {
    const result = parseFlowchart(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const reexported = serializeFlowchart(result.model);
    const reparsed = parseFlowchart(reexported);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.containers).toEqual(result.model.containers);
    expect(serializeFlowchart(reparsed.model)).toBe(reexported);
  });
});
