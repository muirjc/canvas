import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { getDslFamily, type DiagramModel } from '@canvas/diagram-core';
import { Canvas } from '../../src/canvas/Canvas';

/** canvas-4h1j.2: the Wardley map's editor tools (WardleyToolbar) and map layer (WardleyLayer) inside Canvas. */

const MAP = `wardley-beta
anchor Customer [0.95, 0.5]
component Kettle [0.6, 0.45]
component Power [0.2, 0.8]
Customer -> Kettle
Kettle -> Power
`;

const family = getDslFamily('wardley')!;

function parse(text: string): DiagramModel {
  const result = family.parse(text);
  if (!('model' in result)) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
  return result.model;
}

let latest: DiagramModel;
function Harness({ initial }: { initial: DiagramModel }) {
  const [model, setModel] = useState(initial);
  latest = model;
  return <Canvas model={model} onChange={setModel} dslFamily="wardley" />;
}

/** The text a save would write for the current model. */
const dsl = () => family.serialize(latest);
const lines = () => dsl().split('\n').map((l) => l.trim());
const select = (id: string) => fireEvent.pointerDown(screen.getByTestId(`wardley-element-${id}`), { button: 0 });
const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
function type(testId: string, value: string) {
  fireEvent.change(input(testId), { target: { value } });
  fireEvent.blur(input(testId));
}

describe('Wardley map in the editor', () => {
  afterEach(cleanup);

  it('draws the map layer, with an element per anchor and component and a link per connector', () => {
    render(<Harness initial={parse(MAP)} />);
    expect(screen.getByTestId('wardley-map')).toBeTruthy();
    for (const id of ['Customer', 'Kettle', 'Power']) expect(screen.getByTestId(`wardley-element-${id}`)).toBeTruthy();
    expect(screen.getAllByTestId(/^wardley-link-/).length).toBe(2);
    // Not the generic node drawing.
    expect(screen.queryByTestId('node-Kettle')).toBeNull();
  });

  it('draws evolve arrows, inertia marks and pipelines', () => {
    const text = `wardley-beta
component Kettle [0.6, 0.45] (inertia)
component Power [0.2, 0.8]
evolve Power 0.9
pipeline Kettle {
  component Campfire [0.3]
  component Electric [0.5]
}
`;
    render(<Harness initial={parse(text)} />);
    expect(screen.getByTestId('wardley-inertia-Kettle')).toBeTruthy();
    expect(screen.getByTestId('wardley-evolve-Power')).toBeTruthy();
    expect(screen.getByTestId('wardley-pipeline-~pipeline:Kettle')).toBeTruthy();
    expect(screen.getByTestId('wardley-element-Kettle_Campfire')).toBeTruthy();
  });

  it('has no Shapes section, Add Container, Auto Layout or Legend controls', () => {
    render(<Harness initial={parse(MAP)} />);
    expect(screen.getByTestId('wardley-toolbar')).toBeTruthy();
    expect(screen.queryByTestId(/^add-shape-/)).toBeNull();
    expect(screen.queryByTestId('add-container')).toBeNull();
    expect(screen.queryByTestId('auto-layout')).toBeNull();
    expect(screen.queryByTestId('auto-layout-direction')).toBeNull();
    expect(screen.queryByTestId('legend-toggle')).toBeNull();
  });

  it('adds each kind of element', () => {
    render(<Harness initial={parse('wardley-beta\n')} />);
    const roles: string[] = [];
    for (const kind of ['anchor', 'component', 'note', 'annotation', 'accelerator', 'deaccelerator']) {
      fireEvent.click(screen.getByTestId(`add-wardley-${kind}`));
      const added = latest.nodes[latest.nodes.length - 1];
      expect(added.role).toBe(kind);
      roles.push(added.role!);
      // The new element is selected and drawn.
      expect(screen.getByTestId(`wardley-element-${added.id}`)).toBeTruthy();
    }
    expect(latest.nodes).toHaveLength(6);
    const reread = parse(dsl());
    expect(reread.nodes.map((n) => n.role)).toEqual(roles);
  });

  it('gives a second new component a different name', () => {
    render(<Harness initial={parse('wardley-beta\n')} />);
    fireEvent.click(screen.getByTestId('add-wardley-component'));
    fireEvent.click(screen.getByTestId('add-wardley-component'));
    expect(latest.nodes.map((n) => n.label)).toEqual(['New Component', 'New Component 2']);
  });

  it('renames the selected element, and refuses a name another component has, with a notice', () => {
    render(<Harness initial={parse(MAP)} />);
    select('Kettle');
    expect(input('wardley-name').value).toBe('Kettle');
    type('wardley-name', 'Power');
    expect(screen.getByTestId('wardley-notice').textContent).toMatch(/already a component named "Power"/);
    expect(latest.nodes.find((n) => n.id === 'Kettle')!.label).toBe('Kettle');
    type('wardley-name', 'Teapot');
    expect(screen.queryByTestId('wardley-notice')).toBeNull();
    expect(latest.nodes.find((n) => n.id === 'Kettle')!.label).toBe('Teapot');
    expect(lines().some((l) => l.startsWith('component Teapot ['))).toBe(true);
  });

  it('shows the selected element\'s coordinates', () => {
    render(<Harness initial={parse(MAP)} />);
    select('Kettle');
    expect(screen.getByTestId('wardley-coordinates').textContent).toBe('Visibility 0.60 · Evolution 0.45');
  });

  it('sets and clears strategy and inertia', () => {
    render(<Harness initial={parse(MAP)} />);
    select('Kettle');
    fireEvent.change(screen.getByTestId('wardley-strategy'), { target: { value: 'buy' } });
    fireEvent.click(screen.getByTestId('wardley-inertia'));
    expect(lines()).toContain('component Kettle [0.6, 0.45] (buy) (inertia)');
    fireEvent.change(screen.getByTestId('wardley-strategy'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('wardley-inertia'));
    expect(lines()).toContain('component Kettle [0.6, 0.45]');
  });

  it('offers no strategy, inertia or evolve for an anchor', () => {
    render(<Harness initial={parse(MAP)} />);
    select('Customer');
    expect(screen.getByTestId('wardley-name')).toBeTruthy();
    expect(screen.queryByTestId('wardley-strategy')).toBeNull();
    expect(screen.queryByTestId('wardley-evolve')).toBeNull();
    expect(screen.queryByTestId('wardley-add-pipeline-component')).toBeNull();
  });

  it('sets an evolve target, rejects one out of range, and clears it', () => {
    render(<Harness initial={parse(MAP)} />);
    select('Kettle');
    type('wardley-evolve', '0.8');
    expect(lines()).toContain('evolve Kettle 0.8');
    type('wardley-evolve', '1.5');
    expect(screen.getByTestId('wardley-notice').textContent).toMatch(/from 0 to 1/);
    expect(latest.nodes.find((n) => n.id === 'Kettle')!.wardley!.evolve).toBe(0.8);
    type('wardley-evolve', 'soon');
    expect(screen.getByTestId('wardley-notice')).toBeTruthy();
    expect(latest.nodes.find((n) => n.id === 'Kettle')!.wardley!.evolve).toBe(0.8);
    type('wardley-evolve', '');
    expect(dsl()).not.toContain('evolve Kettle');
  });

  it('adds a component to the selected component\'s pipeline and selects it', () => {
    render(<Harness initial={parse(MAP)} />);
    select('Kettle');
    fireEvent.click(screen.getByTestId('wardley-add-pipeline-component'));
    const added = latest.nodes[latest.nodes.length - 1];
    expect(added.role).toBe('pipeline-component');
    expect(dsl()).toContain('pipeline Kettle {');
    expect(screen.getByTestId(`wardley-element-${added.id}`)).toBeTruthy();
    // The pipeline component's panel shows its evolution only, and no pipeline button.
    expect(screen.getByTestId('wardley-coordinates').textContent).toMatch(/^Evolution /);
    expect(screen.queryByTestId('wardley-add-pipeline-component')).toBeNull();
    const reread = parse(dsl());
    expect(reread.containers.filter((c) => c.role === 'pipeline')).toHaveLength(1);
  });

  it('edits the selected link: flow, dotted line and label', () => {
    render(<Harness initial={parse(MAP)} />);
    const edgeId = latest.edges.find((e) => e.sourceId === 'Customer')!.id;
    fireEvent.pointerDown(screen.getByTestId(`wardley-link-${edgeId}`), { button: 0 });
    fireEvent.change(screen.getByTestId('wardley-link-flow'), { target: { value: '+>' } });
    expect(lines()).toContain('Customer +> Kettle');
    fireEvent.change(screen.getByTestId('wardley-link-flow'), { target: { value: '' } });
    expect(lines()).toContain('Customer -> Kettle');
    fireEvent.click(screen.getByTestId('wardley-link-dotted'));
    expect(lines()).toContain('Customer -.-> Kettle');
    fireEvent.click(screen.getByTestId('wardley-link-dotted'));
    expect(lines()).toContain('Customer -> Kettle');
    type('wardley-link-label', 'needs');
    expect(lines().some((l) => l.startsWith('Customer -> Kettle;') && l.includes('needs'))).toBe(true);
  });
});
