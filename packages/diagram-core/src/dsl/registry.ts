import type { DiagramModel } from '../model/diagram-model.js';
import { parseFlowchart } from './flowchart-parser.js';
import { serializeFlowchart } from './flowchart-serializer.js';
import { parseC4, serializeC4 } from './c4.js';
import { parseArchitecture, serializeArchitecture } from './architecture.js';
import { parseSequence, serializeSequence } from './sequence.js';
import { parseErd, serializeErd } from './erd.js';
import { parseUml, serializeUml } from './uml.js';
import type { ParseResult } from './types.js';

export interface DslFamily {
  parse(dsl: string): ParseResult;
  serialize(model: DiagramModel): string;
}

/**
 * Registry of DSL families by id (matches DiagramType.dslFamily in data-model.md). Adding a new
 * family (C4, sequence, ERD, UML, architecture — User Story 3) is one new entry here, not a
 * change to any consumer of this registry (API layer, editor).
 */
export const dslFamilies: Record<string, DslFamily> = {
  flowchart: { parse: parseFlowchart, serialize: serializeFlowchart },
  c4: { parse: parseC4, serialize: serializeC4 },
  architecture: { parse: parseArchitecture, serialize: serializeArchitecture },
  sequence: { parse: parseSequence, serialize: serializeSequence },
  erd: { parse: parseErd, serialize: serializeErd },
  uml: { parse: parseUml, serialize: serializeUml },
};

export function getDslFamily(id: string): DslFamily | undefined {
  return dslFamilies[id];
}
