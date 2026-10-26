import { describe, expect, it } from 'vitest';
import {
  computeBounds,
  computeLegendEntries,
  getDslFamily,
  legendLayout,
  renderToSvg,
  type DiagramModel,
  type StandardRules,
} from '../../src/index.js';
import { emptyStandardRules } from '../../src/standards/schema.js';

/**
 * canvas-ltk: a diagram legend. Mermaid has no legend syntax, so it lives in the Canvas
 * front-matter (canvas.legend) and round-trips through every family except sequence (computed
 * layout). Its automatic entries come from the diagram's standard -- one per element kind and
 * connector rule the diagram actually uses -- and the author can hide, rename or add entries.
 */
function parse(family: string, dsl: string): DiagramModel {
  const result = getDslFamily(family)!.parse(dsl);
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const roundTrip = (family: string, dsl: string) => {
  const model = parse(family, dsl);
  return parse(family, getDslFamily(family)!.serialize(model));
};

const LEGEND_FM = [
  '  legend:',
  '    visible: true',
  '    title: Key',
  '    position:',
  '      x: 600',
  '      y: 40',
  '    hidden:',
  '      - kind:external_system',
  '    labels:',
  '      kind:person: Customer',
  '    extra:',
  '      - id: note',
  '        label: Planned',
  '        sample:',
  '          kind: shape',
  '          shape: rectangle',
  '          fill: "#ffffff"',
  '          stroke: "#999999"',
].join('\n');

const BODIES: Record<string, string> = {
  flowchart: 'flowchart TD\n  A[Start] --> B[End]\n',
  c4: 'C4Context\n  Person(user, "User")\n  System(sys, "Shop")\n  Rel(user, sys, "Uses")\n',
  architecture: 'architecture-beta\n  service db(database)[Database]\n  service api(server)[API]\n  db:L -- R:api\n',
  erd: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n',
  uml: 'classDiagram\n  class Animal\n  class Dog\n  Animal <|-- Dog\n',
};

describe('legend front-matter round-trip', () => {
  for (const [family, body] of Object.entries(BODIES)) {
    it(`${family}: canvas.legend is read into model.legend and written back unchanged`, () => {
      const dsl = `---\ncanvas:\n${LEGEND_FM}\n---\n${body}`;
      const model = parse(family, dsl);
      expect(model.legend).toEqual({
        visible: true,
        title: 'Key',
        position: { x: 600, y: 40 },
        hidden: ['kind:external_system'],
        labels: { 'kind:person': 'Customer' },
        extra: [{ id: 'note', label: 'Planned', sample: { kind: 'shape', shape: 'rectangle', fill: '#ffffff', stroke: '#999999' } }],
      });
      expect(roundTrip(family, dsl).legend).toEqual(model.legend);
    });

    it(`${family}: no legend in, no legend out`, () => {
      const model = parse(family, body);
      expect(model.legend).toBeUndefined();
      expect(getDslFamily(family)!.serialize(model)).not.toContain('legend');
    });
  }

  it('sequence diagrams ignore a legend (their layout is computed)', () => {
    const model = parse('sequence', `---\ncanvas:\n${LEGEND_FM}\n---\nsequenceDiagram\n  A->>B: hi\n`);
    expect(model.legend).toBeUndefined();
    expect(getDslFamily('sequence')!.serialize(model)).not.toContain('legend');
  });

  it('a malformed legend is dropped rather than failing the parse', () => {
    const model = parse('flowchart', '---\ncanvas:\n  legend: nonsense\n---\nflowchart TD\n  A[x]\n');
    expect(model.legend).toBeUndefined();
  });
});

const C4_RULES: StandardRules = {
  ...emptyStandardRules(),
  elementKinds: [
    { id: 'person', label: 'Person', shapes: ['person'], approvedFills: ['#08427b'], match: { role: 'person', external: false } },
    { id: 'software_system', label: 'Software System', shapes: ['rectangle'], approvedFills: ['#1168bd'], match: { role: 'system', external: false } },
    { id: 'external_system', label: 'External System', shapes: ['rectangle'], approvedFills: ['#999999'], match: { role: 'system', external: true } },
  ],
  connectorRules: [{ id: 'relationship', label: 'Relationship', from: '*', to: '*' }],
};

describe('computeLegendEntries', () => {
  const model = parse('c4', BODIES.c4);

  it('one entry per element kind and connector rule the diagram uses, in standard order', () => {
    const entries = computeLegendEntries({ ...model, legend: { visible: true } }, C4_RULES);
    expect(entries.map((e) => e.key)).toEqual(['kind:person', 'kind:software_system', 'connector:relationship']);
    expect(entries[0]).toMatchObject({ label: 'Person', automatic: true, sample: { kind: 'shape', shape: 'person' } });
    expect(entries[1].sample).toMatchObject({ kind: 'shape', shape: 'rectangle' });
    expect(entries[2]).toMatchObject({ label: 'Relationship', sample: { kind: 'line' } });
  });

  it('applies hidden keys and renamed labels, then appends the extra entries', () => {
    const entries = computeLegendEntries(
      {
        ...model,
        legend: {
          visible: true,
          hidden: ['connector:relationship'],
          labels: { 'kind:person': 'Customer' },
          extra: [{ id: 'x', label: 'Planned', sample: { kind: 'line', lineStyle: 'dotted' } }],
        },
      },
      C4_RULES,
    );
    expect(entries.map((e) => [e.key, e.label])).toEqual([
      ['kind:person', 'Customer'],
      ['kind:software_system', 'Software System'],
      ['extra:x', 'Planned'],
    ]);
    expect(entries[2].automatic).toBe(false);
  });

  it('without a standard there are no automatic entries -- only the extra ones', () => {
    const entries = computeLegendEntries(
      { ...model, legend: { visible: true, extra: [{ id: 'a', label: 'Mine', sample: { kind: 'shape', shape: 'circle' } }] } },
      undefined,
    );
    expect(entries.map((e) => e.key)).toEqual(['extra:a']);
  });
});

describe('legend layout and rendering', () => {
  const model = parse('c4', BODIES.c4);
  const withLegend: DiagramModel = { ...model, legend: { visible: true, title: 'Key' } };

  it('defaults to the right of the content, one row per entry, and grows the diagram bounds', () => {
    const entries = computeLegendEntries(withLegend, C4_RULES);
    const plain = computeBounds(model);
    const layout = legendLayout(withLegend, entries, plain)!;
    expect(layout.x).toBeGreaterThanOrEqual(plain.width - 40);
    expect(layout.rows).toHaveLength(3);
    expect(layout.rows[1].y).toBeGreaterThan(layout.rows[0].y);
    const grown = computeBounds(withLegend, entries);
    expect(grown.width).toBeGreaterThanOrEqual(layout.x + layout.width);
    expect(grown.height).toBeGreaterThanOrEqual(layout.y + layout.height);
  });

  it('uses a saved position, and is absent when hidden or empty', () => {
    const entries = computeLegendEntries(withLegend, C4_RULES);
    const plain = computeBounds(model);
    expect(legendLayout({ ...withLegend, legend: { visible: true, position: { x: 12, y: 34 } } }, entries, plain)).toMatchObject({ x: 12, y: 34 });
    expect(legendLayout({ ...withLegend, legend: { visible: false } }, entries, plain)).toBeNull();
    expect(legendLayout(withLegend, [], plain)).toBeNull();
  });

  it('renderToSvg draws the legend (title, entries) when given the standard, and not otherwise', () => {
    const svg = renderToSvg(withLegend, undefined, { standardRules: C4_RULES });
    expect(svg).toContain('class="legend"');
    for (const text of ['Key', 'Person', 'Software System', 'Relationship']) expect(svg).toContain(`>${text}<`);
    expect(renderToSvg({ ...withLegend, legend: { visible: false } }, undefined, { standardRules: C4_RULES })).not.toContain('class="legend"');
    expect(renderToSvg(model, undefined, { standardRules: C4_RULES })).not.toContain('class="legend"');
  });

  it('escapes legend text', () => {
    const svg = renderToSvg(
      { ...model, legend: { visible: true, title: '<b>Key</b>', extra: [{ id: 'a', label: 'A & <B>', sample: { kind: 'shape', shape: 'rectangle' } }] } },
      undefined,
      {},
    );
    expect(svg).toContain('&lt;b&gt;Key&lt;/b&gt;');
    expect(svg).toContain('A &amp; &lt;B&gt;');
  });
});
