import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { loadLibrary } from '../../src/libraries/library-loader.js';
import { mermaidArchitectureIconsManifest } from '../../src/libraries/mermaid-architecture-icons.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';

/**
 * jmuir-dtu.27: Mermaid ships five built-in architecture icons (cloud, database, disk, internet,
 * server) and nearly every architecture-beta example uses them. resolveIconFromName mapped any
 * bare name to the 'generic' library, which only holds shape-alias sentinels, so these resolved
 * to nothing and services drew with no artwork.
 */

const BUILT_INS = ['cloud', 'database', 'disk', 'internet', 'server'] as const;

function parseOk(dsl: string): DiagramModel {
  const result = parseArchitecture(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

const dslWith = (icon: string) => `architecture-beta\n    service s(${icon})[S]\n`;

describe('jmuir-dtu.27: the built-in icon library', () => {
  it('has real markup for all five Mermaid built-in icons and loads cleanly', () => {
    const library = loadLibrary(mermaidArchitectureIconsManifest);
    for (const id of BUILT_INS) {
      const icon = library.icons.find((i) => i.id === id);
      expect(icon, id).toBeDefined();
      expect(icon!.assetRef.trimStart().startsWith('<'), `${id} is inline SVG markup`).toBe(true);
    }
  });
});

describe('jmuir-dtu.27: built-in icon names resolve to that library', () => {
  for (const name of BUILT_INS) {
    it(`service s(${name}) resolves to mermaid-architecture/${name}`, () => {
      const node = parseOk(dslWith(name)).nodes[0];
      expect(node.icon).toEqual({
        libraryId: mermaidArchitectureIconsManifest.id,
        libraryVersion: mermaidArchitectureIconsManifest.version,
        iconId: name,
      });
    });
  }

  it('each built-in draws its artwork in an SVG render', () => {
    const library = loadLibrary(mermaidArchitectureIconsManifest);
    const resolve = (ref: { libraryId: string; libraryVersion: string; iconId: string }) =>
      library.icons.find((i) => ref.libraryId === library.id && ref.libraryVersion === library.version && i.id === ref.iconId)?.assetRef;
    for (const name of BUILT_INS) {
      const svg = renderToSvg(parseOk(dslWith(name)), resolve);
      const markup = library.icons.find((i) => i.id === name)!.assetRef;
      // Rendered as an <image> data URI or inline markup depending on the renderer path; either
      // way the icon's own markup must be present in some form.
      const present = svg.includes(markup) || svg.includes(encodeURIComponent(markup)) || svg.includes(Buffer.from(markup).toString('base64'));
      expect(present, `${name} artwork drawn`).toBe(true);
    }
  });

  it('an unknown bare icon name still round-trips unchanged', () => {
    const model = parseOk(dslWith('mystery'));
    expect(model.nodes[0].icon?.iconId).toBe('mystery');
    expect(model.nodes[0].icon?.libraryId).not.toBe(mermaidArchitectureIconsManifest.id);
    expect(serializeArchitecture(model)).toContain('service s(mystery)[S]');
  });

  it('a built-in name round-trips: parse -> serialize -> parse is idempotent', () => {
    const model = parseOk(dslWith('database'));
    const once = serializeArchitecture(model);
    expect(once).toContain('service s(database)[S]');
    const again = parseOk(once);
    expect(again.nodes[0].icon).toEqual(model.nodes[0].icon);
    expect(serializeArchitecture(again)).toBe(once);
  });

  it('a diagram saved before this fix (front-matter pointing at generic/database) now resolves to the built-in', () => {
    const saved = [
      '---',
      'canvas:',
      '  positions:',
      '    s: { x: 40, y: 40 }',
      '  icons:',
      '    s: { libraryId: generic, libraryVersion: 1.0.0, iconId: database }',
      '---',
      dslWith('database'),
    ].join('\n');
    expect(parseOk(saved).nodes[0].icon).toEqual({
      libraryId: mermaidArchitectureIconsManifest.id,
      libraryVersion: mermaidArchitectureIconsManifest.version,
      iconId: 'database',
    });
  });

  it('a front-matter icon from another library is left alone', () => {
    const saved = [
      '---',
      'canvas:',
      '  positions:',
      '    s: { x: 40, y: 40 }',
      '  icons:',
      '    s: { libraryId: azure-icons, libraryVersion: "2024.1", iconId: storage-accounts }',
      '---',
      dslWith('storage-accounts'),
    ].join('\n');
    expect(parseOk(saved).nodes[0].icon).toEqual({ libraryId: 'azure-icons', libraryVersion: '2024.1', iconId: 'storage-accounts' });
  });
});
