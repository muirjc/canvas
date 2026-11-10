// canvas-vvi: live co-editing. A ModelPatch is one person's change to a diagram, element by element: the
// fields of the shapes, connectors and groups it touched. Two people's patches to different elements, or to
// different fields of one element, both survive; the same field changed by both ends as the later one.
// The API applies patches in the order it receives them (apps/api-py diagram_core/live_patch.py, held to this
// file by vectors) and sends them to everyone, so every browser ends on the same model.
import type { DiagramModel } from '../model/diagram-model.js';

export type JsonObject = Record<string, unknown>;

/** Fields of one element set or removed. */
export interface ElementChange {
  id: string;
  set?: JsonObject;
  unset?: string[];
}

export interface CollectionPatch {
  /** Whole elements, new or replacing the element with that id. */
  added?: JsonObject[];
  removed?: string[];
  changed?: ElementChange[];
  /** The collection's ids in their new order, when the order changed (sequence participants, front-matter order). */
  order?: string[];
}

export interface ModelPatch {
  /** Top-level fields (title, direction, legend, pinned, ...). */
  set?: JsonObject;
  unset?: string[];
  nodes?: CollectionPatch;
  edges?: CollectionPatch;
  containers?: CollectionPatch;
}

export const PATCH_COLLECTIONS = ['nodes', 'edges', 'containers'] as const;
type Collection = (typeof PATCH_COLLECTIONS)[number];
const COLLECTION_KEYS: ReadonlySet<string> = new Set(PATCH_COLLECTIONS);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A field is there when it has a value: `undefined` counts as absent, as JSON drops it. */
function presentKeys(value: JsonObject): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

function diffFields(a: JsonObject, b: JsonObject, skip: ReadonlySet<string>): { set?: JsonObject; unset?: string[] } {
  const set: JsonObject = {};
  const unset: string[] = [];
  for (const key of presentKeys(b)) {
    if (skip.has(key)) continue;
    if (a[key] === undefined || !same(a[key], b[key])) set[key] = b[key];
  }
  for (const key of presentKeys(a)) {
    if (!skip.has(key) && b[key] === undefined) unset.push(key);
  }
  return {
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
  };
}

function withFields(value: JsonObject, set: JsonObject | undefined, unset: string[] | undefined): JsonObject {
  const result: JsonObject = { ...value, ...(set ?? {}) };
  for (const key of unset ?? []) delete result[key];
  return result;
}

const ID_ONLY: ReadonlySet<string> = new Set(['id']);

function applyCollection(elements: readonly JsonObject[], patch: CollectionPatch): JsonObject[] {
  const removed = new Set(patch.removed ?? []);
  let result = removed.size > 0 ? elements.filter((element) => !removed.has(element.id as string)) : [...elements];
  for (const change of patch.changed ?? []) {
    const index = result.findIndex((element) => element.id === change.id);
    // A change to something already deleted is dropped: the delete wins.
    if (index >= 0) result[index] = withFields(result[index], change.set, change.unset?.filter((key) => key !== 'id'));
  }
  for (const element of patch.added ?? []) {
    const index = result.findIndex((existing) => existing.id === element.id);
    if (index >= 0) result[index] = element;
    else result.push(element);
  }
  if (patch.order) result = reordered(result, patch.order);
  return result;
}

/** The elements `order` names take the places those elements already hold, in `order`'s order; the rest stay put. */
function reordered(elements: JsonObject[], order: string[]): JsonObject[] {
  const rank = new Map<string, number>();
  for (const id of order) if (!rank.has(id)) rank.set(id, rank.size);
  const places: number[] = [];
  const moving: JsonObject[] = [];
  elements.forEach((element, index) => {
    if (rank.has(element.id as string)) {
      places.push(index);
      moving.push(element);
    }
  });
  moving.sort((x, y) => rank.get(x.id as string)! - rank.get(y.id as string)!);
  const result = [...elements];
  places.forEach((place, i) => (result[place] = moving[i]));
  return result;
}

function diffCollection(a: readonly JsonObject[], b: readonly JsonObject[]): CollectionPatch | undefined {
  const before = new Map(a.map((element) => [element.id as string, element]));
  const after = new Map(b.map((element) => [element.id as string, element]));
  const added: JsonObject[] = [];
  const changed: ElementChange[] = [];
  const removed = [...before.keys()].filter((id) => !after.has(id));
  for (const [id, element] of after) {
    const old = before.get(id);
    if (!old) {
      added.push(element);
      continue;
    }
    const fields = diffFields(old, element, ID_ONLY);
    if (fields.set || fields.unset) changed.push({ id, ...fields });
  }
  const patch: CollectionPatch = {
    ...(added.length > 0 ? { added } : {}),
    ...(removed.length > 0 ? { removed } : {}),
    ...(changed.length > 0 ? { changed } : {}),
  };
  const ids = b.map((element) => element.id as string);
  if (!same(applyCollection(a, patch).map((element) => element.id), ids)) patch.order = ids;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

const asJson = (model: DiagramModel): JsonObject => model as unknown as JsonObject;
const elementsOf = (model: JsonObject, collection: Collection): JsonObject[] => (model[collection] as JsonObject[] | undefined) ?? [];

/** What changed from `a` to `b`, or null when nothing did. */
export function diffModels(a: DiagramModel, b: DiagramModel): ModelPatch | null {
  const before = asJson(a);
  const after = asJson(b);
  const patch: ModelPatch = diffFields(before, after, COLLECTION_KEYS);
  for (const collection of PATCH_COLLECTIONS) {
    const change = diffCollection(elementsOf(before, collection), elementsOf(after, collection));
    if (change) patch[collection] = change;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** `model` with `patch` applied; `model` itself is left as it was. */
export function applyPatch(model: DiagramModel, patch: ModelPatch): DiagramModel {
  const source = asJson(model);
  const result = withFields(
    source,
    patch.set,
    patch.unset?.filter((key) => !COLLECTION_KEYS.has(key)),
  );
  for (const collection of PATCH_COLLECTIONS) {
    const change = patch[collection];
    result[collection] = change ? applyCollection(elementsOf(source, collection), change) : elementsOf(source, collection);
  }
  return result as unknown as DiagramModel;
}

/** `patches` applied one after another. */
export function applyPatches(model: DiagramModel, patches: readonly ModelPatch[]): DiagramModel {
  return patches.reduce(applyPatch, model);
}
