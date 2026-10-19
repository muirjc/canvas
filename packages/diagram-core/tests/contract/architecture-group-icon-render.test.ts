import { describe, expect, it } from 'vitest';
import { parseArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramContainer, DiagramModel } from '../../src/model/diagram-model.js';
import { loadLibrary } from '../../src/libraries/library-loader.js';
import { mermaidArchitectureIconsManifest } from '../../src/libraries/mermaid-architecture-icons.js';
import { containerHeaderLayout, renderToSvg } from '../../src/render/svg-renderer.js';

/**
 * jmuir-dtu.31: an architecture group's icon (DiagramContainer.icon, kept through save since
 * jmuir-dtu.30) was never drawn -- groups rendered as a plain box and label. It's now drawn in the
 * header beside the label, using one shared geometry helper so the canvas and export agree.
 */

const library = loadLibrary(mermaidArchitectureIconsManifest);
const resolve = (ref: { libraryId: string; libraryVersion: string; iconId: string }) =>
  ref.libraryId === library.id && ref.libraryVersion === library.version ? library.icons.find((i) => i.id === ref.iconId)?.assetRef : undefined;

function parseOk(dsl: string): DiagramModel {
  const result = parseArchitecture(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

/** The markup of one container's <g> in a rendered SVG. */
function containerGroup(svg: string, id: string): string {
  const start = svg.indexOf(`<g data-container-id="${id}">`);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < svg.length; i += 1) {
    if (svg.startsWith('<g', i)) depth += 1;
    if (svg.startsWith('</g>', i)) {
      depth -= 1;
      if (depth === 0) return svg.slice(start, i + 4);
    }
  }
  throw new Error('unterminated group');
}

describe('jmuir-dtu.31: a group draws its icon in its header', () => {
  it('draws the resolved icon inside the group, with the label moved right of it', () => {
    const model = parseOk('architecture-beta\n    group vpc(server)[VPC]\n    service a(database)[A] in vpc\n');
    const markup = containerGroup(renderToSvg(model, resolve), 'vpc');
    expect(markup).toContain(library.icons.find((i) => i.id === 'server')!.assetRef);
    const group = model.containers[0];
    const layout = containerHeaderLayout(group, { headerBand: false, hasIcon: true });
    expect(layout.labelX).toBeGreaterThan(layout.iconX + layout.iconSize - 1);
    expect(markup).toContain(`<text x="${layout.labelX}"`);
  });

  it('a pasted (cloud) group draws the cloud', () => {
    const markup = containerGroup(renderToSvg(parseOk('architecture-beta\n    group api(cloud)[API]\n'), resolve), 'api');
    expect(markup).toContain(library.icons.find((i) => i.id === 'cloud')!.assetRef);
  });

  it('a group with no icon, or an unresolvable one, renders exactly as before', () => {
    const plain: DiagramContainer = { id: 'g', label: 'G', position: { x: 10, y: 10 }, size: { width: 200, height: 100 } };
    const model: DiagramModel = { diagramTypeId: 'cloud-infrastructure', nodes: [], edges: [], containers: [plain] };
    const before = containerGroup(renderToSvg(model), 'g');
    expect(before).toContain('<text x="18"');
    const unresolved = { ...model, containers: [{ ...plain, icon: { libraryId: 'nope', libraryVersion: '1', iconId: 'x' } }] };
    expect(containerGroup(renderToSvg(unresolved, resolve), 'g')).toBe(before);
  });

  it('the header layout keeps the icon inside the group box', () => {
    const group: DiagramContainer = { id: 'g', label: 'G', position: { x: 100, y: 50 }, size: { width: 200, height: 120 } };
    for (const headerBand of [false, true]) {
      const layout = containerHeaderLayout(group, { headerBand, hasIcon: true });
      expect(layout.iconX).toBeGreaterThanOrEqual(100);
      expect(layout.iconY).toBeGreaterThanOrEqual(50);
      expect(layout.iconY + layout.iconSize).toBeLessThanOrEqual(50 + 30);
    }
  });
});
