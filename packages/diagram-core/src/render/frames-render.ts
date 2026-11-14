// canvas-8uh1.6: frames -- other diagrams drawn over a diagram (docs/composite-diagrams-design.md). The overlay is the
// same for every family: the diagram's own drawing is made first, then grown to fit its frames, and each frame is
// drawn on top with a header (the inner diagram's title) and the inner diagram's own drawing scaled to fit. The
// inner drawing is handed in already made (`FrameContent.svg`), rendered without frames of its own, so frames go one
// level deep and a cycle can't recurse: a frame with no content shows a titled placeholder.
import { isAllowedLinkHref, type DiagramFrame, type DiagramModel } from '../model/diagram-model.js';

/** What a frame shows: the inner diagram's title and state, and its drawing when it can be shown. */
export interface FrameContent {
  name?: string;
  status: 'available' | 'unavailable' | 'deleted' | 'missing';
  /** The inner diagram's SVG (from renderToSvg, no frames of its own). */
  svg?: string;
}

/** The header bar's height; the inner drawing fills the rest of the frame. */
export const FRAME_HEADER_HEIGHT = 24;
/** Space left around the frames when the drawing grows to fit them. */
const FRAME_MARGIN = 20;
/** Roughly how wide a header character is, to shorten a long title. */
const TITLE_CHAR_WIDTH = 7;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** What a frame says when it can't show the diagram (also the editor's placeholder text). */
export function frameStatusText(content: FrameContent | undefined): string {
  switch (content?.status) {
    case 'unavailable':
      return 'Not available';
    case 'deleted':
      return 'Deleted (in the bin)';
    case 'missing':
      return 'Diagram no longer exists';
    case 'available':
      return content.svg === undefined ? 'Embedded diagram' : '';
    default:
      return 'Embedded diagram';
  }
}

/** The header title, shortened with an ellipsis to fit the frame's width. */
export function frameTitle(content: FrameContent | undefined, width: number): string {
  const title = content?.name ?? 'Embedded diagram';
  const room = Math.max(1, Math.floor((width - 16) / TITLE_CHAR_WIDTH));
  return title.length > room ? `${title.slice(0, Math.max(0, room - 1))}…` : title;
}

const ROOT = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="([^"]*)" height="([^"]*)" viewBox="0 0 ([^" ]*) ([^"]*)">/;

/** An inner diagram's drawing placed in a box: its own content in a nested <svg> with its viewBox, scaled to fit
 *  and centred. Undefined when it isn't a drawing from renderToSvg. */
export function frameBody(svg: string, x: number, y: number, width: number, height: number): string | undefined {
  const root = svg.match(ROOT);
  if (!root || !svg.endsWith('</svg>')) return undefined;
  const inner = svg.slice(root[0].length, svg.length - '</svg>'.length);
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${root[3]} ${root[4]}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${inner}</svg>`;
}

function renderFrame(frame: DiagramFrame, content: FrameContent | undefined, linkBase: string | undefined): string {
  const { x, y } = frame.position;
  const { width, height } = frame.size;
  const bodyHeight = Math.max(0, height - FRAME_HEADER_HEIGHT);
  const parts = [
    `<g class="diagram-frame" data-frame-id="${escapeXml(frame.id)}">`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff" stroke="#64748b" stroke-width="1.5" rx="6" ry="6" />`,
    `<rect x="${x}" y="${y}" width="${width}" height="${Math.min(height, FRAME_HEADER_HEIGHT)}" fill="#e2e8f0" stroke="#64748b" stroke-width="1.5" rx="6" ry="6" />`,
    `<text x="${x + 8}" y="${y + 16}" font-family="sans-serif" font-size="12" font-weight="bold" fill="#1e293b">${escapeXml(frameTitle(content, width))}</text>`,
  ];
  const body = content?.status === 'available' && content.svg !== undefined ? frameBody(content.svg, x, y + FRAME_HEADER_HEIGHT, width, bodyHeight) : undefined;
  if (body !== undefined) {
    parts.push(body);
  } else {
    const text = frameStatusText(content) || 'Embedded diagram';
    parts.push(
      `<text x="${x + width / 2}" y="${y + FRAME_HEADER_HEIGHT + bodyHeight / 2}" font-family="sans-serif" font-size="12" fill="#64748b" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>`,
    );
  }
  parts.push('</g>');
  const markup = parts.join('');
  const href = linkBase ? `${linkBase}${encodeURIComponent(frame.diagramId)}` : undefined;
  return href && isAllowedLinkHref(href) ? `<a href="${escapeXml(href)}">${markup}</a>` : markup;
}

/**
 * The drawing with the model's frames on top, grown to fit them (with a margin). `contents` maps a framed diagram's
 * id to what to show; a frame whose diagram isn't in it shows a placeholder. `linkBase` (as RenderOptions'
 * diagramLinkBase) makes each frame open its diagram. A drawing that doesn't start with renderToSvg's root is left
 * as it is.
 */
export function withFrameOverlay(svg: string, model: Pick<DiagramModel, 'frames'>, contents: Record<string, FrameContent> = {}, linkBase?: string): string {
  const frames = model.frames ?? [];
  if (frames.length === 0) return svg;
  const root = svg.match(ROOT);
  if (!root || !svg.endsWith('</svg>')) return svg;
  let width = Number(root[1]);
  let height = Number(root[2]);
  for (const frame of frames) {
    width = Math.max(width, frame.position.x + frame.size.width + FRAME_MARGIN);
    height = Math.max(height, frame.position.y + frame.size.height + FRAME_MARGIN);
  }
  const content = (id: string) => (Object.hasOwn(contents, id) ? contents[id] : undefined);
  const overlay = frames.map((frame) => renderFrame(frame, content(frame.diagramId), linkBase)).join('');
  const body = svg.slice(root[0].length, svg.length - '</svg>'.length);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}${overlay}</svg>`;
}
