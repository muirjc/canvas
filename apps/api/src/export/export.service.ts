import { Resvg } from '@resvg/resvg-js';
import { getDslFamily, renderToSvg, type DiagramModel } from '@canvas/diagram-core';

export class UnrenderableDiagramError extends Error {}

function parseOrThrow(dslFamilyId: string, dslContent: string): DiagramModel {
  const family = getDslFamily(dslFamilyId);
  if (!family) {
    throw new UnrenderableDiagramError(`No DSL family registered for: ${dslFamilyId}`);
  }
  const result = family.parse(dslContent);
  if ('errors' in result) {
    throw new UnrenderableDiagramError(
      `Diagram could not be rendered — DSL has parse errors: ${JSON.stringify(result.errors)}`,
    );
  }
  return result.model;
}

export function exportMermaid(dslContent: string): string {
  return dslContent;
}

export function exportSvg(dslFamilyId: string, dslContent: string): string {
  const model = parseOrThrow(dslFamilyId, dslContent);
  return renderToSvg(model);
}

/**
 * Server-side PNG rasterization of the same SVG the editor/SVG-export path produces, so PNG
 * output is deterministic and independent of any particular browser/OS/font environment
 * (research.md §4).
 */
export function exportPng(dslFamilyId: string, dslContent: string): Buffer {
  const svg = exportSvg(dslFamilyId, dslContent);
  const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
  const rendered = resvg.render();
  return rendered.asPng();
}
