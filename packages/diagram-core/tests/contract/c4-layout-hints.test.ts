// canvas-rqm6: C4's side hints (Rel_U/D/L/R and their long forms, Lay_U/D/L/R) are kept in the
// model, saved back, and followed by Auto Layout.
import { describe, expect, it } from 'vitest';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { autoLayout } from '../../src/model/auto-layout.js';
import type { DiagramModel, FlowchartDirection } from '../../src/model/diagram-model.js';

function parse(dsl: string): DiagramModel {
  const result = parseC4(dsl);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}

/** Each shape's centre after Auto Layout in `direction`. */
function centres(model: DiagramModel, direction: FlowchartDirection): Record<string, { x: number; y: number }> {
  const laid = autoLayout(model, direction, 'c4');
  return Object.fromEntries(
    laid.nodes.map((n) => {
      const width = n.size?.width ?? 0;
      const height = n.size?.height ?? 0;
      return [n.id, { x: n.position.x + width / 2, y: n.position.y + height / 2 }];
    }),
  );
}

const sized = (model: DiagramModel): DiagramModel => ({
  ...model,
  nodes: model.nodes.map((n) => ({ ...n, size: { width: 160, height: 80 } })),
});

describe('C4 side hints: parse and save', () => {
  it('keeps every Rel_* side, short or long form, and every Lay_*', () => {
    const model = parse(`C4Context
  System(a, "A")
  System(b, "B")
  Rel_U(a, b, "1")
  Rel_Down(a, b, "2")
  Rel_L(a, b, "3")
  Rel_Right(a, b, "4")
  Rel(a, b, "5")
  Rel_Back(a, b, "6")
  Lay_R(a, b)
  Lay_U(b, a)
`);
    expect(model.edges.map((e) => e.layoutHint)).toEqual(['up', 'down', 'left', 'right', undefined, undefined]);
    expect(model.edges[5]).toMatchObject({ sourceId: 'b', targetId: 'a' });
    expect(model.layoutHints).toEqual([
      { from: 'a', to: 'b', direction: 'right' },
      { from: 'b', to: 'a', direction: 'up' },
    ]);
  });

  it('saves the hints back (short forms) instead of dropping them', () => {
    const dsl = `C4Context
  System(a, "A")
  System(b, "B")
  Rel_Up(a, b, "calls", "HTTPS")
  BiRel(a, b, "syncs")
  Lay_L(a, b)
`;
    const saved = serializeC4(parse(dsl));
    expect(saved).toContain('Rel_U(a, b, "calls", "HTTPS")');
    expect(saved).toContain('BiRel(a, b, "syncs")');
    expect(saved).toContain('Lay_L(a, b)');
    expect(serializeC4(parse(saved))).toBe(saved);
  });

  it('a diagram without hints has no layoutHints field', () => {
    expect('layoutHints' in parse('C4Context\n  System(a, "A")\n')).toBe(false);
  });
});

describe('C4 side hints: Auto Layout', () => {
  const model = sized(
    parse(`C4Context
  Person(u, "User")
  System(api, "API")
  SystemDb(db, "DB")
  System_Ext(pay, "Pay")
  Rel(u, api, "uses")
  Rel_R(api, db, "reads")
  Rel_L(api, pay, "charges")
`),
  );

  it('top-down: Rel_R/Rel_L put shapes beside each other in one row, in order', () => {
    const c = centres(model, 'TD');
    expect(c.pay.y).toBe(c.api.y);
    expect(c.db.y).toBe(c.api.y);
    expect(c.pay.x).toBeLessThan(c.api.x);
    expect(c.api.x).toBeLessThan(c.db.x);
    expect(c.u.y).toBeLessThan(c.api.y);
  });

  it('left-to-right: Rel_R/Rel_L run along the layout instead', () => {
    const c = centres(model, 'LR');
    expect(c.pay.x).toBeLessThan(c.api.x);
    expect(c.api.x).toBeLessThan(c.db.x);
  });

  it('Rel_U puts the target above, even though the connector points down the ranks', () => {
    const up = sized(parse('C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel_U(a, b, "x")\n'));
    const plain = sized(parse('C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "x")\n'));
    expect(centres(up, 'TD').b.y).toBeLessThan(centres(up, 'TD').a.y);
    expect(centres(plain, 'TD').b.y).toBeGreaterThan(centres(plain, 'TD').a.y);
    // Bottom-up flips which way "up" ranks, not where it ends up.
    expect(centres(up, 'BT').b.y).toBeLessThan(centres(up, 'BT').a.y);
  });

  it('Lay_* places without a connector', () => {
    const m = sized(parse('C4Context\n  System(a, "A")\n  System(b, "B")\n  System(c, "C")\n  Lay_D(a, b)\n  Lay_L(b, c)\n'));
    const c = centres(m, 'TD');
    expect(c.b.y).toBeGreaterThan(c.a.y);
    expect(c.c.y).toBe(c.b.y);
    expect(c.c.x).toBeLessThan(c.b.x);
  });

  it('shapes in a row never overlap, whatever their sizes', () => {
    const m = parse('C4Context\n  System(a, "A")\n  System(b, "A much longer label for B")\n  System(c, "C")\n  Rel_R(a, b, "")\n  Rel_R(b, c, "")\n');
    const laid = autoLayout(
      { ...m, nodes: m.nodes.map((n, i) => ({ ...n, size: { width: [100, 300, 50][i], height: [40, 90, 60][i] } })) },
      'TD',
      'c4',
    );
    const [a, b, c] = laid.nodes;
    expect(b.position.x).toBe(a.position.x + 100 + 50);
    expect(c.position.x).toBe(b.position.x + 300 + 50);
    // Centred across the row.
    expect(a.position.y + 20).toBe(b.position.y + 45);
  });

  it('contradicting hints are skipped, not looped on', () => {
    const m = sized(parse('C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel_R(a, b, "")\n  Rel_R(b, a, "")\n  Lay_L(a, b)\n'));
    const c = centres(m, 'TD');
    expect(c.a.y).toBe(c.b.y);
    expect(c.a.x).toBeLessThan(c.b.x);
  });

  it('a hint between shapes in different groups places the groups', () => {
    const m = sized(
      parse(`C4Container
  System_Boundary(left, "Left") {
    Container(a, "A")
  }
  System_Boundary(right, "Right") {
    Container(b, "B")
  }
  Rel_R(a, b, "")
`),
    );
    const laid = autoLayout(m, 'TD', 'c4');
    const [left, right] = laid.containers;
    expect(left.position.y).toBe(right.position.y);
    expect(left.position.x + left.size!.width).toBeLessThan(right.position.x);
  });

  it('hints to unknown ids change nothing', () => {
    const base = sized(parse('C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "")\n'));
    const hinted = { ...base, layoutHints: [{ from: 'a', to: 'ghost', direction: 'right' as const }] };
    expect(autoLayout(hinted, 'TD', 'c4').nodes).toEqual(autoLayout(base, 'TD', 'c4').nodes);
  });
});
