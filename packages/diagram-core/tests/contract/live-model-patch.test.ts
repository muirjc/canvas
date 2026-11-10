import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectDslFamily } from '../../src/dsl/detect.js';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { applyPatch, applyPatches, diffModels, type ModelPatch } from '../../src/live/model-patch.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { addEdge, addNode, removeNode, updateNodeLabel } from '../../src/model/diagram-ops.js';
import { randomEdit, prng } from './live-random-edits.js';

/** canvas-vvi: live co-editing's change format. */

const CORPUS = fileURLToPath(new URL('../../corpus/cases/', import.meta.url));
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const moveNode = (model: DiagramModel, id: string, position: { x: number; y: number }): DiagramModel => ({
  ...model,
  nodes: model.nodes.map((node) => (node.id === id ? { ...node, position } : node)),
});

function corpusModels(): [string, DiagramModel][] {
  const models: [string, DiagramModel][] = [];
  for (const name of readdirSync(CORPUS).sort()) {
    if (name.startsWith('error-')) continue;
    const dsl = readFileSync(join(CORPUS, name, 'input.mmd'), 'utf-8');
    const family = detectDslFamily(dsl);
    if (!family) continue;
    const result = getDslFamily(family).parse(dsl);
    if (isParseSuccess(result)) models.push([name, json(result.model)]);
  }
  return models;
}

const base = (): DiagramModel => ({
  diagramTypeId: 'flowchart',
  nodes: [
    { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
    { id: 'b', label: 'B', shape: 'rectangle', position: { x: 100, y: 0 } },
  ],
  edges: [{ id: 'e1', sourceId: 'a', targetId: 'b', arrow: 'target' }],
  containers: [],
});

describe('diffModels / applyPatch', () => {
  it('finds nothing between equal models', () => {
    expect(diffModels(base(), base())).toBeNull();
  });

  it('carries only the fields that changed', () => {
    const moved = moveNode(base(), 'a', { x: 5, y: 7 });
    expect(diffModels(base(), moved)).toEqual({ nodes: { changed: [{ id: 'a', set: { position: { x: 5, y: 7 } } }] } });
  });

  it('carries new and removed elements, and top-level fields', () => {
    let next = removeNode(base(), 'b');
    next = { ...next, title: 'Hello' };
    const patch = diffModels(base(), next)!;
    expect(patch.set).toEqual({ title: 'Hello' });
    expect(patch.nodes?.removed).toEqual(['b']);
    expect(patch.edges?.removed).toEqual(['e1']);
    expect(applyPatch(base(), patch)).toEqual(next);
  });

  it('treats an undefined field as absent', () => {
    const withUndefined = { ...base(), title: undefined };
    expect(diffModels(base(), withUndefined)).toBeNull();
    const titled = { ...base(), title: 'T' };
    expect(diffModels(titled, withUndefined)).toEqual({ unset: ['title'] });
  });

  it('keeps a changed order', () => {
    const swapped = { ...base(), nodes: [...base().nodes].reverse() };
    const patch = diffModels(base(), swapped)!;
    expect(patch.nodes?.order).toEqual(['b', 'a']);
    expect(applyPatch(base(), patch).nodes.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('drops a change to an element someone else removed (the delete wins)', () => {
    const renamed = diffModels(base(), updateNodeLabel(base(), 'b', 'Bee'))!;
    const removed = removeNode(base(), 'b');
    expect(applyPatch(removed, renamed)).toEqual(removed);
  });

  it('keeps two people changing different fields of one element', () => {
    const label = diffModels(base(), updateNodeLabel(base(), 'a', 'Ay'))!;
    const position = diffModels(base(), moveNode(base(), 'a', { x: 9, y: 9 }))!;
    const node = applyPatches(base(), [label, position]).nodes[0];
    expect(node.label).toBe('Ay');
    expect(node.position).toEqual({ x: 9, y: 9 });
  });

  it('leaves its input alone', () => {
    const model = base();
    const before = JSON.stringify(model);
    applyPatch(model, diffModels(model, addEdge(addNode(model, { shape: 'circle', label: 'C' }), { sourceId: 'a', targetId: 'b' }))!);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('turns any model into any other, for every corpus diagram and random edits', () => {
    const random = prng(7);
    for (const [name, model] of corpusModels()) {
      let current = model;
      for (let step = 0; step < 12; step++) {
        const next = randomEdit(current, random);
        const patch = diffModels(current, next);
        const applied = patch ? applyPatch(current, json(patch)) : current;
        expect(json(applied), `${name} step ${step}`).toEqual(json(next));
        current = next;
      }
    }
  });
});

describe('server-ordered editing', () => {
  /** Each client shows its confirmed model with its own unacknowledged patches on top; the server applies
   *  patches in arrival order and sends each to everyone (the sender's own copy is its acknowledgement). */
  class Client {
    confirmed: DiagramModel;
    pending: { id: number; patch: ModelPatch }[] = [];
    constructor(model: DiagramModel) {
      this.confirmed = model;
    }
    view(): DiagramModel {
      return applyPatches(this.confirmed, this.pending.map((p) => p.patch));
    }
    edit(next: DiagramModel, id: number): ModelPatch | null {
      const patch = diffModels(this.view(), next);
      if (patch) this.pending.push({ id, patch: json(patch) });
      return patch;
    }
    receive(patch: ModelPatch, id: number | null): void {
      this.confirmed = applyPatch(this.confirmed, patch);
      if (id !== null) this.pending = this.pending.filter((p) => p.id !== id);
    }
  }

  it('ends with every client on the server model, however edits interleave', () => {
    const random = prng(42);
    for (const [name, model] of corpusModels().filter((_, i) => i % 3 === 0)) {
      let server = model;
      const clients = [new Client(model), new Client(model), new Client(model)];
      const inFlight: { from: number; id: number; patch: ModelPatch }[] = [];
      let nextId = 1;
      for (let step = 0; step < 40; step++) {
        const roll = random();
        if (roll < 0.55 || inFlight.length === 0) {
          const who = Math.floor(random() * clients.length);
          const id = nextId++;
          const patch = clients[who].edit(randomEdit(clients[who].view(), random), id);
          if (patch) inFlight.push({ from: who, id, patch: json(patch) });
        } else {
          // The server takes some client's oldest patch: each client's own arrive in the order it sent them.
          const senders = [...new Set(inFlight.map((m) => m.from))];
          const sender = senders[Math.floor(random() * senders.length)];
          const taken = inFlight.splice(inFlight.findIndex((m) => m.from === sender), 1)[0];
          server = applyPatch(server, taken.patch);
          clients.forEach((client, i) => client.receive(taken.patch, i === taken.from ? taken.id : null));
        }
      }
      for (const message of inFlight.sort((x, y) => x.id - y.id)) {
        server = applyPatch(server, message.patch);
        clients.forEach((client, i) => client.receive(message.patch, i === message.from ? message.id : null));
      }
      for (const client of clients) {
        expect(client.pending, name).toEqual([]);
        expect(json(client.view()), name).toEqual(json(server));
      }
    }
  });
});
