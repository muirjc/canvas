import { describe, expect, it } from 'vitest';
import { parseC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import {
  c4ComponentTemplateCompiler,
  c4ContainerTemplateCompiler,
  c4DeploymentTemplateCompiler,
} from '../../src/template/c4-levels-template-compiler.js';
import { getTemplateCompiler } from '../../src/template/template-registry.js';
import type { TemplateCompileResult } from '../../src/template/types.js';
import { dslLines, exampleDsl, exampleTables, fillTemplate, readTemplateDoc } from '../fixtures/template-fill.js';

/** canvas-73s.5: docs/c4-levels-template.md -> C4Container / C4Component / C4Deployment. */

const doc = readTemplateDoc('c4-levels-template.md');

function dslOf(result: TemplateCompileResult): string {
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.dsl;
}
const errorsOf = (result: TemplateCompileResult) => ('errors' in result ? result.errors.map((e) => e.message) : []);

describe('C4 Container / Component / Deployment template compilers', () => {
  it('are registered for their diagram types', () => {
    expect(getTemplateCompiler('c4-container')).toBe(c4ContainerTemplateCompiler);
    expect(getTemplateCompiler('c4-component')).toBe(c4ComponentTemplateCompiler);
    expect(getTemplateCompiler('c4-deployment')).toBe(c4DeploymentTemplateCompiler);
  });

  it("compiles the doc's own worked example to the DSL the doc shows, and the model is right", () => {
    const [boundaries, elements, relationships] = exampleTables(doc);
    const dsl = dslOf(c4ContainerTemplateCompiler.compile(fillTemplate(doc, { boundaries, elements, relationships })));
    expect(dslLines(dsl)).toEqual(dslLines(exampleDsl(doc)));

    const parsed = parseC4(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    expect(parsed.model.diagramTypeId).toBe('c4-container');
    expect(parsed.model.nodes.find((n) => n.id === 'webApp')).toMatchObject({
      role: 'container',
      technology: 'Java, Spring MVC',
      description: 'Delivers the web front end',
      containerId: 'internetBanking',
    });
    expect(parsed.model.nodes.find((n) => n.id === 'mailSystem')).toMatchObject({ role: 'system', external: true });
    expect(parsed.model.edges.map((e) => e.technology)).toEqual(['HTTPS', 'JDBC', 'SMTP']);
  });

  it('deployment: nested nodes with type and description, containers inside', () => {
    const dsl = dslOf(
      c4DeploymentTemplateCompiler.compile(
        fillTemplate(doc, {
          boundaries: [
            ['Server', 'Node', 'Region', 'Ubuntu 22.04', ''],
            ['Region', '', '', 'Azure', 'Production'],
          ],
          elements: [['API', 'Container', '', 'Node.js', 'Serves requests', 'Server']],
          relationships: [],
        }),
      ),
    );
    expect(dslLines(dsl)).toEqual([
      'C4Deployment',
      'Deployment_Node(region, "Region", "Azure", "Production") {',
      'Deployment_Node(server, "Server", "Ubuntu 22.04") {',
      'Container(api, "API", "Node.js", "Serves requests")',
      '}',
      '}',
    ]);
    const parsed = parseC4(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    expect(parsed.model.containers.find((c) => c.id === 'region')).toMatchObject({ boundaryType: 'Azure', description: 'Production' });
    expect(parsed.model.containers.find((c) => c.id === 'server')).toMatchObject({ boundaryType: 'Ubuntu 22.04', parentContainerId: 'region' });
  });

  it('component level allows components; container level does not', () => {
    const fill = fillTemplate(doc, { elements: [['Sign In', 'Component', '', 'Spring', 'Signs users in', '']], relationships: [] });
    expect(dslOf(c4ComponentTemplateCompiler.compile(fill))).toContain('Component(signIn, "Sign In", "Spring", "Signs users in")');
    expect(errorsOf(c4ContainerTemplateCompiler.compile(fill))[0]).toContain('Type "Component" isn\'t allowed on a C4Container diagram');
  });

  it('reports a technology on a person, a relationship to a boundary, a Node on a container diagram, and boundary cycles', () => {
    const errs = (rows: Record<string, string[][]>) => errorsOf(c4ContainerTemplateCompiler.compile(fillTemplate(doc, { relationships: [], ...rows })));
    expect(errs({ elements: [['Bob', 'Person', '', 'Java', '', '']] })[0]).toContain('only containers and components have a Technology');
    expect(errs({ boundaries: [['Sys', 'System', '', '', '']], elements: [['Bob', 'Person', '', '', '', '']], relationships: [['Bob', 'Sys', 'Uses', '']] })[0]).toContain(
      '"Sys" is a boundary',
    );
    expect(errs({ boundaries: [['Box', 'Node', '', '', '']], elements: [['Bob', 'Person', '', '', '', '']] })[0]).toContain('Type "Node" isn\'t allowed');
    expect(errs({ boundaries: [['A', 'System', 'B', '', ''], ['B', 'System', 'A', '', '']], elements: [['Bob', 'Person', '', '', '', '']] })[0]).toContain(
      'ends up inside itself',
    );
  });

  it('the blank template reports what is missing', () => {
    expect(errorsOf(c4ContainerTemplateCompiler.compile(doc))).toEqual(['Section 3: list at least one element.']);
  });
});
