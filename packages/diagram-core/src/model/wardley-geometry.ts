// canvas-4h1j: where a Wardley map element is drawn. Mermaid's wardley-beta frame: the map is `size [w, h]`
// (default 900 x 600) with a 48px margin; evolution runs left to right, visibility bottom to top. A coordinate of
// 0-1 is a fraction, above 1 a percentage (Mermaid's toPercent). Shared by the parser (positions from the
// coordinates), the serializer (coordinates from a moved position) and the renderers.
import type { DiagramModel, Position } from './diagram-model.js';

export const WARDLEY_DEFAULT_WIDTH = 900;
export const WARDLEY_DEFAULT_HEIGHT = 600;
export const WARDLEY_PADDING = 48;

export interface WardleyFrame {
  width: number;
  height: number;
  padding: number;
  chartWidth: number;
  chartHeight: number;
}

export function wardleyFrame(model: Pick<DiagramModel, 'wardley'>): WardleyFrame {
  const width = model.wardley?.size?.width ?? WARDLEY_DEFAULT_WIDTH;
  const height = model.wardley?.size?.height ?? WARDLEY_DEFAULT_HEIGHT;
  const padding = WARDLEY_PADDING;
  return { width, height, padding, chartWidth: width - padding * 2, chartHeight: height - padding * 2 };
}

/** Mermaid's toPercent: 0-1 is a fraction, anything above 1 is already a percentage. */
export function wardleyPercent(value: number): number {
  return value <= 1 ? value * 100 : value;
}

export function wardleyX(frame: WardleyFrame, evolution: number): number {
  return frame.padding + (wardleyPercent(evolution) / 100) * frame.chartWidth;
}

export function wardleyY(frame: WardleyFrame, visibility: number): number {
  return frame.height - frame.padding - (wardleyPercent(visibility) / 100) * frame.chartHeight;
}

/** The drawn centre of a point written as [visibility, evolution]. */
export function wardleyPoint(frame: WardleyFrame, point: { visibility: number; evolution: number }): Position {
  return { x: wardleyX(frame, point.evolution), y: wardleyY(frame, point.visibility) };
}

/** The [visibility, evolution] (0-1, two decimals, kept inside the map) of a drawn point: what a save writes for an
 *  element that was moved. */
export function wardleyCoordinatesAt(frame: WardleyFrame, position: Position): { visibility: number; evolution: number } {
  const fraction = (value: number) => Math.min(1, Math.max(0, Math.round(value * 100) / 100));
  return {
    visibility: fraction((frame.height - frame.padding - position.y) / frame.chartHeight),
    evolution: fraction((position.x - frame.padding) / frame.chartWidth),
  };
}
