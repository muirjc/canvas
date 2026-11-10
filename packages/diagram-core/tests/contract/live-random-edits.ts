// canvas-vvi: random edits to a diagram model as plain JSON, for the live-editing tests and the Python vectors
// (apps/api-py/tests/data/make_live_patch_vectors.ts). Not diagram-core ops: anything a patch must carry --
// a moved shape, a new or removed field, an added/removed/reordered element, a top-level field.
import type { DiagramModel } from '../../src/model/diagram-model.js';

type Json = Record<string, unknown>;

/** A small seeded random number generator (mulberry32). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLLECTIONS = ['nodes', 'edges', 'containers'] as const;
const WORDS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Order service', 'Ünïcode', ''];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function randomValue(random: () => number): unknown {
  const roll = random();
  if (roll < 0.25) return Math.floor(random() * 1000) - 200;
  if (roll < 0.45) return pick(WORDS, random);
  if (roll < 0.55) return null;
  if (roll < 0.65) return random() < 0.5;
  if (roll < 0.85) return { x: Math.round(random() * 800), y: Math.round(random() * 600) };
  return [pick(WORDS, random), Math.floor(random() * 10)];
}

/** One random edit; the input is left as it was. */
export function randomEdit(model: DiagramModel, random: () => number): DiagramModel {
  const next = JSON.parse(JSON.stringify(model)) as Json;
  const roll = random();
  if (roll < 0.1) {
    if (random() < 0.7) next.title = pick(WORDS, random);
    else delete next.title;
    return next as unknown as DiagramModel;
  }
  const collection = pick(COLLECTIONS, random);
  const elements = next[collection] as Json[];
  if (elements.length === 0 || roll < 0.25) {
    const template = elements.length > 0 ? pick(elements, random) : { label: 'New' };
    const element = { ...template, id: `x${Math.floor(random() * 1e9).toString(36)}` };
    elements.splice(Math.floor(random() * (elements.length + 1)), 0, element);
    return next as unknown as DiagramModel;
  }
  const index = Math.floor(random() * elements.length);
  const element = elements[index];
  if (roll < 0.35) {
    elements.splice(index, 1);
  } else if (roll < 0.45) {
    const other = Math.floor(random() * elements.length);
    [elements[index], elements[other]] = [elements[other], elements[index]];
  } else if (roll < 0.65) {
    element.position = { x: Math.round(random() * 900), y: Math.round(random() * 700) };
  } else if (roll < 0.75) {
    element.label = pick(WORDS, random);
  } else if (roll < 0.88) {
    element[pick(['extra', 'style', 'label', 'size', 'note'], random)] = randomValue(random);
  } else {
    const keys = Object.keys(element).filter((key) => key !== 'id');
    if (keys.length > 0) delete element[pick(keys, random)];
  }
  return next as unknown as DiagramModel;
}
