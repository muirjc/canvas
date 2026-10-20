import { describe, expect, it } from 'vitest';
import { parseArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { awsIconsManifest } from '../../src/libraries/aws-icons.js';
import { architectureTemplateCompiler } from '../../src/template/architecture-template-compiler.js';
import { getTemplateCompiler } from '../../src/template/template-registry.js';
import type { TemplateCompileResult } from '../../src/template/types.js';
import { dslLines, exampleDsl, exampleTables, fillTemplate, readTemplateDoc } from '../fixtures/template-fill.js';

/** canvas-73s.4: docs/architecture-template.md -> Mermaid architecture-beta. */

const doc = readTemplateDoc('architecture-template.md');

function dslOf(result: TemplateCompileResult): string {
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.dsl;
}
const errorsOf = (result: TemplateCompileResult) => ('errors' in result ? result.errors.map((e) => e.message) : []);
const compile = (rows: Record<string, string[][] | null>) => architectureTemplateCompiler.compile(fillTemplate(doc, rows));

describe('architecture template compiler', () => {
  it('is registered for all three architecture-family diagram types', () => {
    for (const id of ['network', 'deployment', 'cloud-infrastructure']) expect(getTemplateCompiler(id)).toBe(architectureTemplateCompiler);
  });

  it("compiles the doc's own worked example to the DSL the doc shows, and the model is right", () => {
    const [groups, services, connections] = exampleTables(doc);
    const dsl = dslOf(compile({ groups, services, connections }));
    expect(dslLines(dsl)).toEqual(dslLines(exampleDsl(doc)));

    const parsed = parseArchitecture(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    expect(parsed.model.containers.map((c) => [c.id, c.label, c.icon?.iconId])).toEqual([['publicCloud', 'Public Cloud', 'cloud']]);
    expect(parsed.model.nodes.find((n) => n.id === 'webServer')).toMatchObject({ label: 'Web Server', containerId: 'publicCloud' });
    expect(parsed.model.edges).toHaveLength(2);
  });

  it('nested groups come out parents first, and junctions take part in connections', () => {
    const dsl = dslOf(
      compile({
        groups: [
          ['Subnet', '', 'VPC'],
          ['VPC', '', ''],
        ],
        services: [
          ['API', '', 'Subnet'],
          ['Cache', 'disk', 'Subnet'],
        ],
        junctions: [['Split', 'Subnet']],
        connections: [
          ['API', '', 'Split', '', 'No'],
          ['Split', 'Bottom', 'Cache', 'Top', ''],
        ],
      }),
    );
    expect(dslLines(dsl)).toEqual([
      'architecture-beta',
      'group vpc(cloud)[VPC]',
      'group subnet(cloud)[Subnet] in vpc',
      'service api(server)[API] in subnet',
      'service cache(disk)[Cache] in subnet',
      'junction split in subnet',
      'api:R -- L:split',
      'split:B --> T:cache',
    ]);
    const parsed = parseArchitecture(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (isParseSuccess(parsed)) expect(parsed.model.containers.find((c) => c.id === 'subnet')!.parentContainerId).toBe('vpc');
  });

  it('aws:/azure: icons are written to the front matter (with every other icon), and resolve on parse', () => {
    const dsl = dslOf(
      compile({
        groups: [['Region', '', '']],
        services: [
          ['Function', 'aws:lambda', 'Region'],
          ['Storage', 'azure:storage-accounts', ''],
          ['Pods', 'logos:kubernetes', ''],
        ],
        connections: [['Function', '', 'Storage', '', '']],
      }),
    );
    expect(dsl.startsWith('---\ncanvas:\n  icons:\n')).toBe(true);
    expect(dsl).toContain('service function(lambda)[Function] in region');
    expect(dsl).toContain('service pods(logos:kubernetes)[Pods]');
    const parsed = parseArchitecture(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    const icon = (id: string) => parsed.model.nodes.find((n) => n.id === id)!.icon;
    expect(icon('function')).toEqual({ libraryId: 'aws-icons', libraryVersion: awsIconsManifest.version, iconId: 'lambda' });
    expect(icon('storage')).toMatchObject({ libraryId: 'azure-icons', iconId: 'storage-accounts' });
    expect(icon('pods')).toMatchObject({ libraryId: 'logos', libraryVersion: 'iconify', iconId: 'kubernetes' });
    // The group keeps its default cloud icon even though the file now has front matter.
    expect(parsed.model.containers[0].icon).toMatchObject({ iconId: 'cloud' });
  });

  it('reports unknown icons, unknown groups, connections to groups, and group cycles', () => {
    expect(errorsOf(compile({ services: [['A', 'spaceship', '']] }))[0]).toContain('unrecognized Icon "spaceship"');
    expect(errorsOf(compile({ services: [['A', 'azure:not-an-icon', '']] }))[0]).toContain('"not-an-icon" is not an icon in Canvas\'s azure library');
    expect(errorsOf(compile({ services: [['A', '', 'Nowhere']] }))[0]).toContain('group "Nowhere" is not listed');
    expect(errorsOf(compile({ groups: [['G', '', '']], services: [['A', '', '']], connections: [['A', '', 'G', '', '']] }))[0]).toContain('"G" is a group');
    expect(errorsOf(compile({ groups: [['A', '', 'B'], ['B', '', 'A']], services: [['S', '', '']] }))[0]).toContain('are inside each other');
  });

  it('the blank template reports what is missing', () => {
    expect(errorsOf(architectureTemplateCompiler.compile(doc))).toEqual(['Section 3: list at least one service.']);
  });
});
