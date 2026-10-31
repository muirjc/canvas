import { Resvg } from '@resvg/resvg-js';
import { withSpan } from '../telemetry/telemetry.js';
import { getDslFamily, renderToSvg, toPortableMermaid, type DiagramModel, type IconResolver } from '@canvas/diagram-core';
import { resolveIconAssets } from '../libraries/library.service.js';
import { getActiveStandard } from '../standards/standard.service.js';

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

/** canvas-jki: the saved DSL, plus plain `style`/`linkStyle` lines for a flowchart's colours so
 *  other Mermaid tools show them (toPortableMermaid). */
export function exportMermaid(dslContent: string): string {
  return toPortableMermaid(dslContent);
}

/** canvas-8n7: builds a resolveIcon backed by one batched DB lookup of the model's own distinct
 *  icon refs, so exported SVG/PNG actually draws real icon artwork instead of silently omitting
 *  it (the gap this bug's acceptance criteria assumed was already closed, but never was). */
async function buildIconResolver(model: DiagramModel): Promise<IconResolver | undefined> {
  // jmuir-dtu.31: architecture groups draw their icon too.
  const refs = [...model.nodes, ...model.containers].flatMap((element) => (element.icon ? [element.icon] : []));
  if (refs.length === 0) return undefined;
  const assets = await resolveIconAssets(refs);
  return (icon) => assets.get(`${icon.libraryId}@${icon.libraryVersion}@${icon.iconId}`);
}

/** `diagramTypeId` (canvas-ltk): its active standard supplies a visible legend's automatic entries.
 *  `background` (canvas-n85n): a solid hex colour behind the drawing; downloads stay transparent. */
export async function exportSvg(dslFamilyId: string, dslContent: string, diagramTypeId?: string, options: { background?: string } = {}): Promise<string> {
  return withSpan('render svg', { 'canvas.diagram.family': dslFamilyId }, async () => {
    const model = parseOrThrow(dslFamilyId, dslContent);
    const resolveIcon = await buildIconResolver(model);
    const standard = model.legend?.visible && diagramTypeId ? await getActiveStandard(diagramTypeId) : null;
    return renderToSvg(model, resolveIcon, { standardRules: standard?.rules, background: options.background });
  });
}

/**
 * Server-side PNG rasterization of the same SVG the editor/SVG-export path produces, so PNG
 * output is deterministic and independent of any particular browser/OS/font environment
 * (research.md §4).
 */
export async function exportPng(dslFamilyId: string, dslContent: string, diagramTypeId?: string): Promise<Buffer> {
  const svg = await exportSvg(dslFamilyId, dslContent, diagramTypeId);
  return withSpan('rasterize png', { 'canvas.diagram.family': dslFamilyId }, () => {
    const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
    return resvg.render().asPng();
  });
}
