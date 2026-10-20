import { describe, expect, it } from 'vitest';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * canvas-aoa: BOUNDARY_START captured only a boundary's alias and label, so its type, description
 * and tags were dropped on the first save, and a boundary line with a named argument ($tags=...)
 * failed to parse. Mermaid's signatures (mermaid.js.org/syntax/c4.html):
 *   Boundary(alias, label, ?type, ?tags, $link)
 *   Enterprise_Boundary / System_Boundary / Container_Boundary(alias, label, ?tags, $link)
 *   Deployment_Node / Node / Node_L / Node_R(alias, label, ?type, ?descr, ?sprite, ?tags, $link)
 */

function parseOk(dsl: string): DiagramModel {
  const result = parseC4(dsl);
  expect(isParseSuccess(result), JSON.stringify((result as { errors?: unknown }).errors)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}
const roundTrip = (dsl: string) => serializeC4(parseOk(dsl));
const container = (model: DiagramModel, id: string) => model.containers.find((c) => c.id === id)!;

describe('canvas-aoa: boundary arguments are kept', () => {
  it('Boundary: the third argument is its type', () => {
    const model = parseOk('C4Context\nBoundary(b1, "Bank", "Company") {\n  System(s, "S")\n}\n');
    expect(container(model, 'b1').boundaryType).toBe('Company');
  });

  it('Deployment_Node and its shortcuts: type, then description', () => {
    const model = parseOk(
      'C4Deployment\nDeployment_Node(live, "Live", "Azure", "Production region") {\n  Node(web, "Web", "Ubuntu 22.04") {\n    Container(api, "API")\n  }\n}\n',
    );
    expect(container(model, 'live').boundaryType).toBe('Azure');
    expect(container(model, 'live').description).toBe('Production region');
    expect(container(model, 'web').boundaryType).toBe('Ubuntu 22.04');
    expect(container(model, 'web').description).toBeUndefined();
  });

  it('Enterprise/System/Container_Boundary: the third argument is tags', () => {
    const model = parseOk('C4Context\nEnterprise_Boundary(e, "Corp", "v1") {\n  System_Boundary(s, "Sys", $tags="core,v2") {\n  }\n}\n');
    expect(container(model, 'e').tags).toEqual(['v1']);
    expect(container(model, 's').tags).toEqual(['core', 'v2']);
    expect(container(model, 'e').boundaryType).toBeUndefined();
  });

  it('named $type / $descr / $tags work, and other named args ($link, $sprite) are accepted', () => {
    const model = parseOk(
      'C4Deployment\nDeployment_Node(live, "Live", $type="AWS", $descr="Prod", $tags="t1", $link="https://x", $sprite="cloud") {\n}\n',
    );
    expect(container(model, 'live')).toMatchObject({ boundaryType: 'AWS', description: 'Prod', tags: ['t1'] });
  });

  it('round-trips every boundary family unchanged', () => {
    for (const [header, line] of [
      ['C4Context', 'Boundary(b1, "Bank", "Company") {'],
      ['C4Context', 'Boundary(b2, "Bank", "Company", $tags="t1") {'],
      ['C4Context', 'Enterprise_Boundary(e, "Corp", $tags="v1") {'],
      ['C4Context', 'System_Boundary(s, "Sys") {'],
      ['C4Container', 'Container_Boundary(c, "Box", $tags="a,b") {'],
      ['C4Deployment', 'Deployment_Node(live, "Live", "Azure", "Production region") {'],
      ['C4Deployment', 'Deployment_Node(dn, "DN", "", "Only a description") {'],
    ]) {
      const out = roundTrip(`${header}\n${line}\n}\n`);
      expect(out, line).toContain(line);
    }
  });

  it('a boundary with no extra arguments serializes exactly as before', () => {
    expect(roundTrip('C4Context\nSystem_Boundary(s, "Sys") {\n  System(a, "A")\n}\n')).toContain('System_Boundary(s, "Sys") {');
  });

  it('parse -> serialize -> parse is idempotent with nested boundaries and their arguments', () => {
    const once = roundTrip(
      'C4Deployment\nDeployment_Node(live, "Live", "Azure", "Prod", $tags="eu") {\n  Node(web, "Web", "Ubuntu") {\n    Container(api, "API", "Node.js", "Serves requests")\n  }\n}\n',
    );
    expect(roundTrip(once)).toBe(once);
  });
});
