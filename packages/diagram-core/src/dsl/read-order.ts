import type { DiagramModel } from '../model/diagram-model.js';
import { isParseSuccess, type ParseResult } from './types.js';

/**
 * canvas-ra0g: the model with its shapes and groups in the order reading the written text back gives. A writer
 * groups elements (a boundary's shapes go inside its block, a state's declaration before the transitions), so the
 * text's order isn't the model's, and the front matter (written in model order) came out reordered on the next
 * save: a save that changed nothing showed a diff in the version history and in GitHub pull requests. Each
 * serializer writes once, reads that back, and writes the model in that order, so the first save is already the
 * text every later save gives. Text that doesn't read back leaves the model as it is.
 */
export function inReadOrder(
  model: DiagramModel,
  parse: (dsl: string) => ParseResult,
  write: (model: DiagramModel) => string,
): DiagramModel {
  const read = parse(write(model));
  if (!isParseSuccess(read)) return model;
  return { ...model, nodes: byOrder(model.nodes, read.model.nodes), containers: byOrder(model.containers, read.model.containers) };
}

/** `items` sorted by where their id first comes in `order`; ids it lacks go last, in their own order. */
function byOrder<T extends { id: string }>(items: T[], order: { id: string }[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((element, i) => {
    if (!rank.has(element.id)) rank.set(element.id, i);
  });
  return items
    .map((item, i) => ({ item, i, rank: rank.get(item.id) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ item }) => item);
}
