// canvas-4h1j.2: the Wardley map edits, and what a save writes after each (round-tripped through
// serializeWardley / parseWardley).
import { describe, expect, it } from 'vitest';
import { parseWardley, serializeWardley } from '../../src/dsl/wardley.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import {
  addWardleyElement,
  addWardleyPipelineComponent,
  moveWardleyElement,
  removeWardleyElement,
  setWardleyLinkFlow,
  setWardleyMarkings,
  wardleyNameTaken,
} from '../../src/model/wardley-ops.js';

function parse(dsl: string): DiagramModel {
  const result = parseWardley(dsl);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const save = (m: DiagramModel) => serializeWardley(m);
/** Saves, reads back, and saves again: the text must be stable. */
function roundTrip(m: DiagramModel): { text: string; reread: DiagramModel } {
  const text = save(m);
  const reread = parse(text);
  expect(save(reread)).toBe(text);
  return { text, reread };
}
const lines = (text: string) => text.split('\n').map((l) => l.trim());
const byLabel = (m: DiagramModel, label: string) => m.nodes.find((n) => n.label === label)!;
const snapshot = (m: DiagramModel) => JSON.stringify(m);

const MAP = `wardley-beta
component A [0.8, 35.0]
component B [0.5, 0.5] (buy)
component C [0.30, 0.90]
A -> B
B -> C
`;

const PIPELINE_MAP = `wardley-beta
component Kettle [0.57, 0.45]
component Power [0.10, 0.70]
Kettle -> Power
pipeline Kettle {
  component Campfire [0.35]
  component Electric [0.53]
}
Campfire -> Kettle
`;

describe('moveWardleyElement', () => {
  it('writes a moved component at its new 0-1 two-decimal coordinates, leaving the others as written', () => {
    const m = parse(MAP);
    const moved = moveWardleyElement(m, 'A', { visibility: 0.7123, evolution: 0.4567 });
    const { text } = roundTrip(moved);
    expect(lines(text)).toContain('component A [0.71, 0.46]');
    expect(lines(save(m))).toContain('component A [0.8, 35.0]');
    expect(lines(text)).toContain('component B [0.5, 0.5] (buy)');
  });

  it('keeps an untouched component\'s written form, e.g. a percentage', () => {
    const m = parse(MAP);
    const text = save(moveWardleyElement(m, 'C', { visibility: 0.2, evolution: 0.8 }));
    expect(lines(text)).toContain('component A [0.8, 35.0]');
  });

  it('clamps a point outside the map', () => {
    const m = parse(MAP);
    const text = save(moveWardleyElement(m, 'B', { visibility: 1.6, evolution: -0.3 }));
    expect(lines(text)).toContain('component B [1.0, 0.0] (buy)');
  });

  it('moves a pipeline component along evolution only, keeping the parent\'s visibility', () => {
    const m = parse(PIPELINE_MAP);
    const moved = moveWardleyElement(m, 'Kettle_Campfire', { visibility: 0.9, evolution: 0.2 });
    const campfire = byLabel(moved, 'Campfire');
    expect(campfire.wardley!.visibility).toBe(0.57);
    expect(campfire.wardley!.evolution).toBe(0.2);
    const { text, reread } = roundTrip(moved);
    expect(lines(text)).toContain('component Campfire [0.2]');
    expect(byLabel(reread, 'Campfire').containerId).toBe(reread.containers.find((c) => c.role === 'pipeline')!.id);
    expect(reread.containers.filter((c) => c.role === 'pipeline')).toHaveLength(1);
  });

  it('carries a pipeline along when its parent moves', () => {
    const m = parse(PIPELINE_MAP);
    const moved = moveWardleyElement(m, 'Kettle', { visibility: 0.6, evolution: 0.55 });
    const { text } = roundTrip(moved);
    expect(lines(text)).toContain('component Kettle [0.6, 0.55]');
    // Both children shift by the parent's 0.10 evolution move; their visibility is the parent's.
    expect(lines(text)).toContain('component Campfire [0.45]');
    expect(lines(text)).toContain('component Electric [0.63]');
    expect(byLabel(moved, 'Campfire').wardley!.visibility).toBe(0.6);
  });

  it('throws for an unknown id', () => {
    expect(() => moveWardleyElement(parse(MAP), 'nope', { visibility: 0.5, evolution: 0.5 })).toThrow(/no element/);
  });

  it('does not change the model it was given', () => {
    const m = parse(PIPELINE_MAP);
    const before = snapshot(m);
    moveWardleyElement(m, 'Kettle', { visibility: 0.2, evolution: 0.2 });
    moveWardleyElement(m, 'Kettle_Campfire', { visibility: 0.2, evolution: 0.2 });
    expect(snapshot(m)).toBe(before);
  });
});

describe('addWardleyElement', () => {
  it('adds each kind and the text reads back with the same elements', () => {
    let m = parse('wardley-beta\n');
    for (const kind of ['anchor', 'component', 'note', 'annotation', 'accelerator', 'deaccelerator'] as const) {
      m = addWardleyElement(m, { kind });
    }
    expect(m.nodes.map((n) => n.role)).toEqual(['anchor', 'component', 'note', 'annotation', 'accelerator', 'deaccelerator']);
    const { reread } = roundTrip(m);
    expect(reread.nodes.map((n) => [n.role, n.label])).toEqual(m.nodes.map((n) => [n.role, n.label]));
  });

  it('writes a component at the given coordinates (clamped, two decimals)', () => {
    const m = addWardleyElement(parse('wardley-beta\n'), { kind: 'component', label: 'Tea', visibility: 0.456, evolution: 1.4 });
    expect(lines(save(m))).toContain('component Tea [0.46, 1.0]');
  });

  it('gives distinct default names to anchors and components', () => {
    let m = parse('wardley-beta\n');
    m = addWardleyElement(m, { kind: 'component' });
    m = addWardleyElement(m, { kind: 'component' });
    m = addWardleyElement(m, { kind: 'component' });
    expect(m.nodes.map((n) => n.label)).toEqual(['New Component', 'New Component 2', 'New Component 3']);
    // The names share one space with anchors.
    m = addWardleyElement(m, { kind: 'anchor', label: 'New Component' });
    expect(m.nodes[3].label).toBe('New Component 4');
    roundTrip(m);
  });

  it('puts new elements on different spots', () => {
    let m = parse('wardley-beta\n');
    m = addWardleyElement(m, { kind: 'component' });
    m = addWardleyElement(m, { kind: 'component' });
    expect(m.nodes[0].position).not.toEqual(m.nodes[1].position);
  });

  it('numbers annotations one past the highest', () => {
    let m = parse('wardley-beta\nannotation 3,[0.5, 0.5] "x"\n');
    m = addWardleyElement(m, { kind: 'annotation' });
    expect(m.nodes[m.nodes.length - 1].wardley!.number).toBe(4);
    expect(save(m)).toMatch(/annotation 4,\[/);
  });

  it('refuses an unknown kind and an empty name', () => {
    const m = parse('wardley-beta\n');
    expect(() => addWardleyElement(m, { kind: 'box' as never })).toThrow(/unknown kind/);
    expect(() => addWardleyElement(m, { kind: 'component', label: '  ' })).toThrow(/empty/);
  });

  it('does not change the model it was given', () => {
    const m = parse(MAP);
    const before = snapshot(m);
    addWardleyElement(m, { kind: 'component' });
    expect(snapshot(m)).toBe(before);
  });
});

describe('wardleyNameTaken', () => {
  it('is true for another anchor or component\'s name, false for its own', () => {
    const m = parse(MAP);
    expect(wardleyNameTaken(m, 'A', 'B')).toBe(true);
    expect(wardleyNameTaken(m, 'A', 'A')).toBe(false);
    expect(wardleyNameTaken(m, 'A', 'Fresh')).toBe(false);
  });

  it('is false for an unknown id and for notes', () => {
    const m = parse(`wardley-beta\ncomponent A [0.5, 0.5]\nnote "hi" [0.2, 0.2]\n`);
    expect(wardleyNameTaken(m, 'nope', 'A')).toBe(false);
    const note = m.nodes.find((n) => n.role === 'note')!;
    expect(wardleyNameTaken(m, note.id, 'A')).toBe(false);
  });

  it('is scoped to the pipeline for a pipeline component', () => {
    const m = parse(PIPELINE_MAP);
    expect(wardleyNameTaken(m, 'Kettle_Campfire', 'Electric')).toBe(true);
    // A map-level name does not clash with a pipeline component's name, as Mermaid keys it by its parent.
    expect(wardleyNameTaken(m, 'Kettle_Campfire', 'Power')).toBe(false);
    expect(wardleyNameTaken(m, 'Power', 'Campfire')).toBe(false);
  });
});

describe('setWardleyMarkings', () => {
  it('writes and clears strategy, inertia and evolve', () => {
    let m = parse(MAP);
    m = setWardleyMarkings(m, 'A', { strategy: 'buy', inertia: true, evolve: 0.8 });
    const { text, reread } = roundTrip(m);
    expect(lines(text)).toContain('component A [0.8, 35.0] (buy) (inertia)');
    expect(lines(text)).toContain('evolve A 0.8');
    expect(byLabel(reread, 'A').wardley).toMatchObject({ strategy: 'buy', inertia: true, evolve: 0.8 });

    m = setWardleyMarkings(m, 'A', { strategy: null, inertia: false, evolve: null });
    const cleared = save(m);
    expect(cleared).not.toMatch(/\(buy\)\s*\(inertia\)|evolve A/);
    expect(lines(cleared)).toContain('component A [0.8, 35.0]');
  });

  it('only changes the fields given', () => {
    const m = setWardleyMarkings(parse(MAP), 'B', { inertia: true });
    expect(lines(save(m))).toContain('component B [0.5, 0.5] (buy) (inertia)');
  });

  it('clamps evolve into the map', () => {
    const m = setWardleyMarkings(parse(MAP), 'A', { evolve: 1.7 });
    expect(lines(save(m))).toContain('evolve A 1.0');
  });

  it('throws for an unknown id, a non-component, an unknown strategy and a non-number evolve', () => {
    const m = parse(`wardley-beta\nanchor Cust [0.9, 0.5]\ncomponent A [0.5, 0.5]\n`);
    expect(() => setWardleyMarkings(m, 'nope', { inertia: true })).toThrow(/no element/);
    expect(() => setWardleyMarkings(m, 'Cust', { inertia: true })).toThrow(/only a component/);
    expect(() => setWardleyMarkings(m, 'A', { strategy: 'rent' as never })).toThrow(/unknown strategy/);
    expect(() => setWardleyMarkings(m, 'A', { evolve: Number.NaN })).toThrow(/number/);
  });

  it('does not change the model it was given', () => {
    const m = parse(MAP);
    const before = snapshot(m);
    setWardleyMarkings(m, 'A', { strategy: 'build', evolve: 0.9, inertia: true });
    expect(snapshot(m)).toBe(before);
  });
});

describe('addWardleyPipelineComponent', () => {
  it('creates the pipeline, and the saved text reparses to the same structure', () => {
    const m = addWardleyPipelineComponent(parse(MAP), 'B', { label: 'Kettle X', evolution: 0.62 });
    const { text, reread } = roundTrip(m);
    expect(text).toContain('pipeline B {');
    expect(lines(text)).toContain('component Kettle X [0.62]');
    const pipelines = reread.containers.filter((c) => c.role === 'pipeline');
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].attachedNodeIds).toEqual(['B']);
    const child = byLabel(reread, 'Kettle X');
    expect(child.containerId).toBe(pipelines[0].id);
    expect(child.role).toBe('pipeline-component');
    expect(child.wardley!.visibility).toBe(0.5);
  });

  it('puts the next component just right of the last, and gives it a distinct name', () => {
    let m = addWardleyPipelineComponent(parse(MAP), 'B', { evolution: 0.4 });
    m = addWardleyPipelineComponent(m, 'B');
    m = addWardleyPipelineComponent(m, 'B');
    const kids = m.nodes.filter((n) => n.role === 'pipeline-component');
    expect(kids.map((n) => n.label)).toEqual(['New Component', 'New Component 2', 'New Component 3']);
    expect(kids.map((n) => n.wardley!.evolution)).toEqual([0.4, 0.5, 0.6]);
    expect(m.containers.filter((c) => c.role === 'pipeline')).toHaveLength(1);
    roundTrip(m);
  });

  it('without an evolution on an empty pipeline, starts at the parent\'s', () => {
    const m = addWardleyPipelineComponent(parse(MAP), 'C');
    expect(m.nodes.find((n) => n.role === 'pipeline-component')!.wardley!.evolution).toBe(0.9);
  });

  it('refuses a duplicate name in the pipeline, an empty name, an unknown parent and a non-component parent', () => {
    const m = parse(PIPELINE_MAP);
    expect(() => addWardleyPipelineComponent(m, 'Kettle', { label: 'Campfire' })).toThrow(/already has/);
    expect(() => addWardleyPipelineComponent(m, 'Kettle', { label: ' ' })).toThrow(/empty/);
    expect(() => addWardleyPipelineComponent(m, 'nope')).toThrow(/no component/);
    expect(() => addWardleyPipelineComponent(m, 'Kettle_Campfire')).toThrow(/only a component/);
    const withAnchor = parse('wardley-beta\nanchor Cust [0.9, 0.5]\n');
    expect(() => addWardleyPipelineComponent(withAnchor, 'Cust')).toThrow(/only a component/);
  });

  it('does not change the model it was given', () => {
    const m = parse(PIPELINE_MAP);
    const before = snapshot(m);
    addWardleyPipelineComponent(m, 'Kettle');
    addWardleyPipelineComponent(m, 'Power');
    expect(snapshot(m)).toBe(before);
  });
});

describe('removeWardleyElement', () => {
  it('removes an element and its links', () => {
    const m = removeWardleyElement(parse(MAP), 'B');
    expect(m.nodes.map((n) => n.id)).toEqual(['A', 'C']);
    expect(m.edges).toEqual([]);
    const { text } = roundTrip(m);
    expect(text).not.toMatch(/->/);
  });

  it('removing a pipeline\'s parent removes the pipeline, its components and their links', () => {
    const m = removeWardleyElement(parse(PIPELINE_MAP), 'Kettle');
    expect(m.nodes.map((n) => n.id)).toEqual(['Power']);
    expect(m.containers).toEqual([]);
    expect(m.edges).toEqual([]);
    expect(save(m)).not.toMatch(/pipeline|Campfire/);
    roundTrip(m);
  });

  it('removing the only component of a pipeline removes the pipeline, but not with one left', () => {
    const one = removeWardleyElement(parse(PIPELINE_MAP), 'Kettle_Campfire');
    expect(one.containers.filter((c) => c.role === 'pipeline')).toHaveLength(1);
    const none = removeWardleyElement(one, 'Kettle_Electric');
    expect(none.containers).toEqual([]);
    expect(save(none)).not.toContain('pipeline');
  });

  it('returns the model as it is for an unknown id', () => {
    const m = parse(MAP);
    expect(removeWardleyElement(m, 'nope')).toBe(m);
  });

  it('does not change the model it was given', () => {
    const m = parse(PIPELINE_MAP);
    const before = snapshot(m);
    removeWardleyElement(m, 'Kettle');
    expect(snapshot(m)).toBe(before);
  });
});

describe('setWardleyLinkFlow', () => {
  const edgeBetween = (m: DiagramModel, a: string, b: string) => m.edges.find((e) => e.sourceId === a && e.targetId === b)!;

  it('writes each flow as `A +> B` and back to `A -> B` on null', () => {
    let m = parse(MAP);
    const id = edgeBetween(m, 'A', 'B').id;
    for (const [flow, token] of [['+>', '+>'], ['+<', '+<'], ['+<>', '+<>']] as const) {
      m = setWardleyLinkFlow(m, id, flow);
      const { text, reread } = roundTrip(m);
      expect(lines(text)).toContain(`A ${token} B`);
      expect(reread.edges).toHaveLength(2);
    }
    m = setWardleyLinkFlow(m, id, null);
    expect(lines(save(m))).toContain('A -> B');
  });

  it('keeps the label of a labelled flow arrow, changes its flow, and null makes it a plain link', () => {
    let m = parse(`wardley-beta\ncomponent A [0.8, 0.5]\ncomponent B [0.4, 0.5]\nA +'pay'> B\n`);
    const id = m.edges[0].id;
    m = setWardleyLinkFlow(m, id, '+<>');
    expect(lines(roundTrip(m).text)).toContain(`A +'pay'<> B`);
    m = setWardleyLinkFlow(m, id, null);
    expect(lines(save(m))).toContain('A -> B');
  });

  it('throws for an unknown link and an unknown flow', () => {
    const m = parse(MAP);
    expect(() => setWardleyLinkFlow(m, 'zz', '+>')).toThrow(/no link/);
    expect(() => setWardleyLinkFlow(m, m.edges[0].id, '=>' as never)).toThrow(/unknown flow/);
  });

  it('does not change the model it was given', () => {
    const m = parse(MAP);
    const before = snapshot(m);
    setWardleyLinkFlow(m, m.edges[0].id, '+>');
    expect(snapshot(m)).toBe(before);
  });
});
