import { Resvg } from '@resvg/resvg-js';
import { getDslFamily, renderToSvg, type DiagramModel, type IconResolver } from '@canvas/diagram-core';
import { resolveIconAssets } from '../libraries/library.service.js';

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

/** canvas-8n7: builds a resolveIcon backed by one batched DB lookup of the model's own distinct
 *  icon refs, so exported SVG/PNG actually draws real icon artwork instead of silently omitting
 *  it (the gap this bug's acceptance criteria assumed was already closed, but never was). */
async function buildIconResolver(model: DiagramModel): Promise<IconResolver | undefined> {
  const refs = model.nodes.flatMap((n) => (n.icon ? [n.icon] : []));
  if (refs.length === 0) return undefined;
  const assets = await resolveIconAssets(refs);
  return (icon) => assets.get(`${icon.libraryId}@${icon.libraryVersion}@${icon.iconId}`);
}

export async function exportSvg(dslFamilyId: string, dslContent: string): Promise<string> {
  const model = parseOrThrow(dslFamilyId, dslContent);
  const resolveIcon = await buildIconResolver(model);
  return renderToSvg(model, resolveIcon);
}

/**
 * Server-side PNG rasterization of the same SVG the editor/SVG-export path produces, so PNG
 * output is deterministic and independent of any particular browser/OS/font environment
 * (research.md §4).
 */
export async function exportPng(dslFamilyId: string, dslContent: string): Promise<Buffer> {
  const svg = await exportSvg(dslFamilyId, dslContent);
  const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
  const rendered = resvg.render();
  return rendered.asPng();
}
