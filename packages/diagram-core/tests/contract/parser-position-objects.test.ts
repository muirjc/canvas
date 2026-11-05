// canvas-0t84: every parser gives each element its own position object. A shared placeholder made the
// front matter's YAML use anchors (`&a1` / `*a1`) and meant moving one element in place moved the others.
import { describe, expect, it } from 'vitest';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { parseC4 } from '../../src/dsl/c4.js';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { parseSequence } from '../../src/dsl/sequence.js';
import { parseState } from '../../src/dsl/state.js';
import { parseUml } from '../../src/dsl/uml.js';
import { serializeC4 } from '../../src/dsl/c4.js';
import { isParseSuccess, type ParseResult } from '../../src/dsl/types.js';

function model(result: ParseResult): DiagramModel {
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}

function sharedPositions(m: DiagramModel): string[] {
  const seen = new Map<object, string>();
  const shared: string[] = [];
  for (const el of [...m.nodes, ...m.containers]) {
    const owner = seen.get(el.position);
    if (owner) shared.push(`${owner} and ${el.id}`);
    else seen.set(el.position, el.id);
  }
  return shared;
}

// A C4 diagram where two boundaries share an id: the layout skips their contents, which keep the placeholder.
const C4 = "C4Context\nRel_Left(c, q1, \"\u00e9moji \ud83c\udfa8\", \"it's\", $sprite=\"\u00e9moji \ud83c\udfa8\", \"50%\",$tags=\"a, b\")\nContainer_Boundary(B2, \"Label\")  {\n  Rel_R(_x, api, \"Label\")\n  Container(b, \"50%\", $sprite=\"a, b\", \"it's\")\n  Rel_Up(constructor, N2, \"Label\")\n  System_Boundary(B2, \"\u00e9moji \ud83c\udfa8\",$tags=\"\", $sprite=\"\u00e9moji \ud83c\udfa8\", $x=\"\")  {\n    Container_Ext(_x, \"a, b\", $type=\"\", \"it's\")\n    Rel_Up(b, __proto__, \"a, b\", \"  spaced  \", \"two words\", \"two words\", \"two words\")\n    %%{init: {'theme': 'dark'}}%%\n    \n    Container_Boundary(B1, \"\u00e9moji \ud83c\udfa8\")  {\n    }\n    UpdateElementStyle(b, x)\n    Rel_D(q1, api, \"two words\", \"Label\" , $techn=\"  spaced  \",$sprite=\"  spaced  \",$type=\"two words\")\n    Rel_Right(q1, c, \"50%\")\n}\n}\n";

describe('parsers give each element its own position object', () => {
  it('C4, including elements the layout leaves at the placeholder', () => {
    const m = model(parseC4(C4));
    expect(sharedPositions(m)).toEqual([]);
    expect(serializeC4(m)).not.toMatch(/[&*]a\d/);
  });
  it('sequence', () => {
    expect(sharedPositions(model(parseSequence('sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hi\nNote over A,B: n\n')))).toEqual([]);
  });
  it('class (fresh import)', () => {
    expect(sharedPositions(model(parseUml('classDiagram\nclass A\nclass B\nnote "n"\nnamespace N {\n  class C\n}\n')))).toEqual([]);
  });
  it('state', () => {
    expect(sharedPositions(model(parseState('stateDiagram-v2\n[*] --> A\nA --> B\nB --> [*]\nstate C {\n  [*] --> D\n}\n')))).toEqual([]);
  });
  it('flowchart', () => {
    expect(sharedPositions(model(parseFlowchart('flowchart TD\nA --> B\nsubgraph S\n  C\nend\n')))).toEqual([]);
  });
});
