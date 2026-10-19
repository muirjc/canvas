import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { mermaidArchitectureIconsManifest } from '../../src/libraries/mermaid-architecture-icons.js';

/**
 * jmuir-dtu.30: parseArchitecture captured a group's (icon) token but discarded it, and
 * serializeArchitecture hardcoded `group <id>(cloud)[<label>]`, so `group vpc(server)[VPC]`
 * silently became `group vpc(cloud)[VPC]` after one save.
 */

function parseOk(dsl: string): DiagramModel {
  const result = parseArchitecture(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

const roundTrip = (dsl: string) => serializeArchitecture(parseOk(dsl));

describe('jmuir-dtu.30: a group icon survives save', () => {
  it.each(['server', 'database', 'disk', 'internet', 'cloud'])('built-in icon %s round-trips', (icon) => {
    const out = roundTrip(`architecture-beta\n    group g(${icon})[G]\n`);
    expect(out).toContain(`group g(${icon})[G]`);
  });

  // jmuir-dtu.31: (cloud) is also the serializer's default for a group with no icon. Pasted Mermaid
  // (no front-matter) means a real cloud icon; a diagram this app saved (front-matter present)
  // without an icons entry for the group means none -- so both kinds of model stay stable.
  it('(cloud) in pasted Mermaid (no front-matter) is a real cloud icon', () => {
    expect(parseOk('architecture-beta\n    group g(cloud)[G]\n').containers[0].icon?.iconId).toBe('cloud');
  });

  it('(cloud) in a diagram this app saved, with no icons entry for the group, means no icon', () => {
    const saved = '---\ncanvas:\n  positions: {}\n  containers:\n    g: { x: 0, y: 0, width: 200, height: 100 }\n---\narchitecture-beta\n    group g(cloud)[G]\n';
    expect(parseOk(saved).containers[0].icon).toBeUndefined();
  });

  it('an imported cloud group keeps its cloud icon through save', () => {
    const once = roundTrip('architecture-beta\n    group g(cloud)[G]\n');
    expect(parseOk(once).containers[0].icon?.iconId).toBe('cloud');
  });

  it('a built-in group icon resolves to the mermaid-architecture library', () => {
    const group = parseOk('architecture-beta\n    group vpc(server)[VPC]\n').containers[0];
    expect(group.icon).toEqual({
      libraryId: mermaidArchitectureIconsManifest.id,
      libraryVersion: mermaidArchitectureIconsManifest.version,
      iconId: 'server',
    });
  });

  it('an iconify group icon round-trips', () => {
    expect(roundTrip('architecture-beta\n    group a(logos:aws)[AWS]\n')).toContain('group a(logos:aws)[AWS]');
  });

  it('an unknown bare group icon round-trips unchanged', () => {
    expect(roundTrip('architecture-beta\n    group a(mystery)[A]\n')).toContain('group a(mystery)[A]');
  });

  it('a nested group keeps both its icon and its parent', () => {
    expect(roundTrip('architecture-beta\n    group outer(cloud)[Outer]\n    group inner(database)[Inner] in outer\n')).toContain(
      'group inner(database)[Inner] in outer',
    );
  });

  it('a group with no icon (or one built in code) still emits the (cloud) default', () => {
    expect(roundTrip('architecture-beta\n    group a()[A]\n')).toContain('group a(cloud)[A]');
    const model = parseOk('architecture-beta\n');
    model.containers.push({ id: 'g', label: 'G', position: { x: 0, y: 0 }, size: { width: 200, height: 100 } });
    expect(serializeArchitecture(model)).toContain('group g(cloud)[G]');
  });

  it('parse -> serialize -> parse is idempotent, and the icon is kept through front-matter', () => {
    const once = roundTrip('architecture-beta\n    group vpc(server)[VPC]\n    service a(database)[A] in vpc\n');
    const reparsed = parseOk(once);
    expect(reparsed.containers[0].icon?.iconId).toBe('server');
    expect(serializeArchitecture(reparsed)).toBe(once);
  });
});
