import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * Feature 003, User Story 1: the architecture (cloud infrastructure) parser must accept
 * `-->`/`<--` connections — standard, documented Mermaid syntax that currently fails to parse
 * at all (only plain `--` works today) — and preserve arrow direction and anchor hints through
 * an import→export round-trip (FR-001–FR-004).
 */
describe('architecture parser: arrowhead edges', () => {
  const base = 'architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n';

  it('parses a --> connection and sets arrow to "target"', () => {
    const result = parseArchitecture(`${base}  a --> b\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.sourceId).toBe('a');
      expect(edge.targetId).toBe('b');
      expect(edge.arrow).toBe('target');
    }
  });

  it('parses a <-- connection and sets arrow to "source"', () => {
    const result = parseArchitecture(`${base}  a <-- b\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.sourceId).toBe('a');
      expect(edge.targetId).toBe('b');
      expect(edge.arrow).toBe('source');
    }
  });

  it('continues to parse the pre-existing plain -- connector with arrow left unset', () => {
    const result = parseArchitecture(`${base}  a -- b\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.arrow).toBeUndefined();
    }
  });

  it('accepts :T/:B/:L/:R anchor hints on either side for all three connector forms', () => {
    for (const connector of ['-->', '<--', '--']) {
      const result = parseArchitecture(`${base}  a:R ${connector} L:b\n`);
      expect(isParseSuccess(result), `expected "${connector}" with anchor hints to parse`).toBe(true);
    }
  });

  it('round-trips arrow direction and anchor hints through export and re-import', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        { id: 'a', label: 'A', shape: 'icon', position: { x: 0, y: 0 } },
        { id: 'b', label: 'B', shape: 'icon', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'a', targetId: 'b', arrow: 'target' }],
      containers: [],
    };
    const dsl = serializeArchitecture(model);
    expect(dsl).toMatch(/a\s*-->\s*b/);

    const reparsed = parseArchitecture(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.edges[0].arrow).toBe('target');
    }
  });

  it('round-trips a <-- edge', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        { id: 'a', label: 'A', shape: 'icon', position: { x: 0, y: 0 } },
        { id: 'b', label: 'B', shape: 'icon', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'a', targetId: 'b', arrow: 'source' }],
      containers: [],
    };
    const dsl = serializeArchitecture(model);
    expect(dsl).toMatch(/a\s*<--\s*b/);

    const reparsed = parseArchitecture(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.edges[0].arrow).toBe('source');
    }
  });

  it('a plain -- edge with no arrow set round-trips to an equal model (existing behavior unchanged)', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        { id: 'a', label: 'A', shape: 'icon', position: { x: 0, y: 0 } },
        { id: 'b', label: 'B', shape: 'icon', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'a', targetId: 'b' }],
      containers: [],
    };
    const dsl = serializeArchitecture(model);
    const reparsed = parseArchitecture(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.edges).toEqual(model.edges);
    }
  });
});
