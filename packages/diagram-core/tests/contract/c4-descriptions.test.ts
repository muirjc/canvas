import { describe, expect, it } from 'vitest';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * canvas-1u2: c4.ts kept only an element's alias and label and a Rel's endpoints and label; every
 * further argument was discarded and serializeC4 wrote back only (alias, "label"). So the first
 * save of any imported C4 diagram silently dropped its descriptions and technology strings.
 *
 * Mermaid's signatures (mermaid.js.org/syntax/c4.html):
 *   Person/System(alias, label, ?descr, ?sprite, ?tags, $link)
 *   Container/Component(alias, label, ?techn, ?descr, ?sprite, ?tags, $link)
 *   Rel(from, to, label, ?techn, ?descr, ?sprite, ?tags, $link)
 */

function parseOk(dsl: string): DiagramModel {
  const result = parseC4(dsl);
  expect(isParseSuccess(result), JSON.stringify((result as { errors?: unknown }).errors)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}
const roundTrip = (dsl: string) => serializeC4(parseOk(dsl));
const node = (model: DiagramModel, id: string) => model.nodes.find((n) => n.id === id)!;

describe('canvas-1u2: element descriptions and technology are kept', () => {
  it('Person/System: the third argument is the description', () => {
    const model = parseOk('C4Context\nPerson(p, "Customer", "A bank customer")\nSystem_Ext(s, "Mail", "Sends e-mail")\n');
    expect(node(model, 'p').description).toBe('A bank customer');
    expect(node(model, 'p').technology).toBeUndefined();
    expect(node(model, 's').description).toBe('Sends e-mail');
  });

  it('Container/Component: technology, then description', () => {
    const model = parseOk(
      'C4Container\nContainer(api, "API", "Java, Spring", "Handles requests")\nComponentDb(db, "Store", "PostgreSQL")\n',
    );
    expect(node(model, 'api').technology).toBe('Java, Spring');
    expect(node(model, 'api').description).toBe('Handles requests');
    expect(node(model, 'db').technology).toBe('PostgreSQL');
    expect(node(model, 'db').description).toBeUndefined();
  });

  it('named $descr / $techn work too, alongside $tags', () => {
    const model = parseOk('C4Container\nContainer(api, "API", $techn="Go", $descr="Edge", $tags="new_system")\n');
    expect(node(model, 'api').technology).toBe('Go');
    expect(node(model, 'api').description).toBe('Edge');
    expect(node(model, 'api').tags).toEqual(['new_system']);
  });

  it('a positional tags argument (after sprite) is kept as tags', () => {
    const model = parseOk('C4Context\nSystem(s, "S", "desc", "sprite-name", "v1")\n');
    expect(node(model, 's').description).toBe('desc');
    expect(node(model, 's').tags).toEqual(['v1']);
  });

  it('round-trips each family unchanged', () => {
    for (const line of [
      'Person(p, "Customer", "A bank customer")',
      'System_Ext(s, "Mail", "Sends e-mail")',
      'Container(api, "API", "Java, Spring", "Handles requests")',
      'ComponentDb(db, "Store", "PostgreSQL")',
      'System(a, "A", "desc", $tags="new_system")',
      'Person(q, "Plain")',
    ]) {
      const out = roundTrip(`C4Container\n${line}\n`);
      expect(out, line).toContain(line);
    }
  });

  it('a Container with a description but no technology writes an empty technology slot', () => {
    const model = parseOk('C4Container\nContainer(api, "API", $descr="Only a description")\n');
    const out = serializeC4(model);
    expect(out).toContain('Container(api, "API", "", "Only a description")');
    expect(node(parseOk(out), 'api').description).toBe('Only a description');
    expect(node(parseOk(out), 'api').technology).toBeUndefined();
  });

  it('parse -> serialize -> parse is idempotent with descriptions, technology and tags', () => {
    const once = roundTrip(
      'C4Container\nPerson(p, "Customer", "A bank customer")\nContainer(api, "API", "Java", "Handles requests", $tags="v1")\nRel(p, api, "Uses", "HTTPS", "Browses")\n',
    );
    expect(roundTrip(once)).toBe(once);
  });
});

describe('canvas-1u2: relationship technology and description are kept', () => {
  it('Rel: technology, then description; BiRel and Rel_Back too', () => {
    const model = parseOk(
      'C4Context\nPerson(a, "A")\nSystem(b, "B")\nRel(a, b, "Uses", "HTTPS", "Reads balances")\nBiRel(a, b, "Syncs", "gRPC")\nRel_Back(a, b, "Notifies", $techn="SMTP")\n',
    );
    const [uses, syncs, notifies] = model.edges;
    expect(uses.technology).toBe('HTTPS');
    expect(uses.description).toBe('Reads balances');
    expect(syncs.technology).toBe('gRPC');
    expect(syncs.arrow).toBe('both');
    expect(notifies.technology).toBe('SMTP');
    expect(notifies.sourceId).toBe('b');
  });

  it('round-trips a Rel with technology and description', () => {
    const out = roundTrip('C4Context\nPerson(a, "A")\nSystem(b, "B")\nRel(a, b, "Uses", "HTTPS", "Reads balances")\n');
    expect(out).toContain('Rel(a, b, "Uses", "HTTPS", "Reads balances")');
  });

  it('a Rel with a description but no technology writes an empty technology slot', () => {
    const out = roundTrip('C4Context\nPerson(a, "A")\nSystem(b, "B")\nRel(a, b, "Uses", $descr="Only description")\n');
    expect(out).toContain('Rel(a, b, "Uses", "", "Only description")');
  });

  it('a plain Rel still serializes exactly as before', () => {
    expect(roundTrip('C4Context\nPerson(a, "A")\nSystem(b, "B")\nRel(a, b, "Uses")\n')).toContain('Rel(a, b, "Uses")');
  });
});
