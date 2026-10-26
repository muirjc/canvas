import type { DiagramModel, LegendSample } from '../model/diagram-model.js';
import { classifyNode, resolveConnectorRule } from '../standards/kinds.js';
import type { StandardRules } from '../standards/schema.js';

/**
 * canvas-ltk: a diagram legend -- which entries it shows, and where. Pure functions shared by the
 * export renderer (svg-renderer.ts) and the interactive canvas, so the two can't disagree.
 *
 * Automatic entries come from the diagram's standard: one per element kind and one per connector
 * rule the diagram actually uses, in the standard's order. The author's choices
 * (`model.legend`) hide or rename those and add entries of their own. Sequence diagrams have no
 * legend (their layout is computed).
 */
export interface LegendEntry {
  /** `kind:<id>`, `connector:<id>` (automatic) or `extra:<id>` (the author's). */
  key: string;
  label: string;
  sample: LegendSample;
  automatic: boolean;
}

export function computeLegendEntries(model: DiagramModel, rules: StandardRules | undefined): LegendEntry[] {
  if (model.diagramTypeId === 'sequence') return [];
  const legend = model.legend;
  const hidden = new Set(legend?.hidden ?? []);
  const rename = (key: string, label: string) => legend?.labels?.[key] ?? label;
  const entries: LegendEntry[] = [];

  if (rules) {
    const kindOf = new Map<string, string>();
    const firstNodeOfKind = new Map<string, DiagramModel['nodes'][number]>();
    for (const node of model.nodes) {
      const kind = classifyNode(node, rules);
      if (!kind) continue;
      kindOf.set(node.id, kind.id);
      if (!firstNodeOfKind.has(kind.id)) firstNodeOfKind.set(kind.id, node);
    }
    for (const kind of rules.elementKinds ?? []) {
      const node = firstNodeOfKind.get(kind.id);
      const key = `kind:${kind.id}`;
      if (!node || hidden.has(key)) continue;
      const fill = node.style?.fillColor ?? kind.approvedFills?.[0];
      const stroke = node.style?.strokeColor ?? kind.approvedStrokes?.[0];
      entries.push({
        key,
        label: rename(key, kind.label),
        sample: { kind: 'shape', shape: node.shape, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}) },
        automatic: true,
      });
    }

    const firstEdgeOfRule = new Map<string, DiagramModel['edges'][number]>();
    for (const edge of model.edges) {
      const rule = resolveConnectorRule(rules, kindOf.get(edge.sourceId), kindOf.get(edge.targetId));
      if (rule && !firstEdgeOfRule.has(rule.id)) firstEdgeOfRule.set(rule.id, edge);
    }
    for (const rule of rules.connectorRules ?? []) {
      const edge = firstEdgeOfRule.get(rule.id);
      const key = `connector:${rule.id}`;
      if (!edge || hidden.has(key)) continue;
      const lineStyle = edge.lineStyle ?? rule.lineStyles?.[0];
      const arrow = edge.arrow ?? rule.arrows?.[0] ?? 'target';
      const stroke = edge.style?.strokeColor ?? rule.approvedStrokes?.[0];
      entries.push({
        key,
        label: rename(key, rule.label),
        sample: { kind: 'line', arrow, ...(lineStyle ? { lineStyle } : {}), ...(stroke ? { stroke } : {}) },
        automatic: true,
      });
    }
  }

  for (const extra of legend?.extra ?? []) {
    entries.push({ key: `extra:${extra.id}`, label: extra.label, sample: extra.sample, automatic: false });
  }
  return entries;
}

export const LEGEND_METRICS = {
  padding: 12,
  titleHeight: 22,
  rowHeight: 30,
  sampleWidth: 36,
  sampleHeight: 22,
  gap: 10,
  fontSize: 12,
  /** Rough width per character for sizing the box (no font metrics in a pure function). */
  charWidth: 7,
  minWidth: 140,
  /** Space between the content and a legend placed beside it. */
  offset: 24,
};

export interface LegendRow {
  entry: LegendEntry;
  /** Top of the row. */
  y: number;
  sampleX: number;
  labelX: number;
}

export interface LegendLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  title?: { text: string; x: number; y: number };
  rows: LegendRow[];
}

/**
 * Where the legend box goes and how big it is. Null when there's no visible legend or nothing to
 * show. Without a saved position it sits beside the content (`contentBounds`, from computeBounds
 * without the legend), top-aligned.
 */
export function legendLayout(model: DiagramModel, entries: LegendEntry[], contentBounds: { width: number; height: number }): LegendLayout | null {
  if (!model.legend?.visible || entries.length === 0 || model.diagramTypeId === 'sequence') return null;
  const m = LEGEND_METRICS;
  const title = model.legend.title?.trim();
  const longest = Math.max(title?.length ?? 0, ...entries.map((e) => e.label.length));
  const width = Math.max(m.minWidth, m.padding * 2 + m.sampleWidth + m.gap + longest * m.charWidth);
  const height = m.padding * 2 + (title ? m.titleHeight : 0) + entries.length * m.rowHeight;
  const x = model.legend.position?.x ?? Math.max(0, contentBounds.width - 40 + m.offset);
  const y = model.legend.position?.y ?? 40;
  const top = y + m.padding + (title ? m.titleHeight : 0);
  return {
    x,
    y,
    width,
    height,
    ...(title ? { title: { text: title, x: x + m.padding, y: y + m.padding + m.fontSize } } : {}),
    rows: entries.map((entry, i) => ({
      entry,
      y: top + i * m.rowHeight,
      sampleX: x + m.padding,
      labelX: x + m.padding + m.sampleWidth + m.gap,
    })),
  };
}
