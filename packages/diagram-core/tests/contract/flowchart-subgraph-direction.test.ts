import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * Grouping E (docs/flowchart-completeness-brief.md): a `direction <TD|LR|TB|RL|BT>` statement
 * inside a `subgraph`/`end` block overrides that subgraph's layout direction. Unlike
 * style/classDef/linkStyle, this is native Mermaid grammar with no generic model field to fold
 * into — `DiagramContainer` gains its own `direction` field and the serializer must emit a real
 * `direction` line back out, not just round-trip it through front-matter.
 *
 * Note (per the brief §2, unchanged by this grouping): the diagram's top-level direction is
 * preserved for round-trip but does not drive initial auto-layout — laid-out node positions are
 * unaffected by a subgraph's `direction` too. This grouping is scoped to parse/serialize fidelity
 * only, not to making direction "live".
 */
describe('flowchart parser: subgraph direction override', () => {
  it('sets the direction override on a subgraph containing it', () => {
    const result = parseFlowchart('flowchart TD\n  subgraph sub1\n    direction LR\n    A --> B\n  end\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const container = result.model.containers.find((c) => c.id === 'sub1')!;
      expect(container.direction).toBe('LR');
    }
  });

  it('leaves a subgraph with no direction line undefined, not defaulted to the top-level direction', () => {
    const result = parseFlowchart('flowchart TD\n  subgraph sub1\n    A --> B\n  end\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.containers.find((c) => c.id === 'sub1')!.direction).toBeUndefined();
    }
  });

  it('applies a direction override only to its own subgraph, not siblings or the parent', () => {
    const dsl = [
      'flowchart TD',
      '  subgraph outer',
      '    subgraph inner1',
      '      direction LR',
      '      A --> B',
      '    end',
      '    subgraph inner2',
      '      C --> D',
      '    end',
      '  end',
      '',
    ].join('\n');
    const result = parseFlowchart(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.containers.find((c) => c.id === 'inner1')!.direction).toBe('LR');
      expect(result.model.containers.find((c) => c.id === 'inner2')!.direction).toBeUndefined();
      expect(result.model.containers.find((c) => c.id === 'outer')!.direction).toBeUndefined();
    }
  });

  it('reports an error for a "direction" line outside any subgraph', () => {
    const result = parseFlowchart('flowchart TD\n  direction LR\n  A --> B\n');
    expect(isParseSuccess(result)).toBe(false);
  });

  it.each(['TD', 'LR', 'TB', 'RL', 'BT'] as const)('accepts direction %s inside a subgraph', (dir) => {
    const result = parseFlowchart(`flowchart TD\n  subgraph sub1\n    direction ${dir}\n    A --> B\n  end\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.containers.find((c) => c.id === 'sub1')!.direction).toBe(dir);
    }
  });

  it('round-trips a subgraph direction override through serialize/parse', () => {
    const result = parseFlowchart('flowchart TD\n  subgraph sub1\n    direction LR\n    A --> B\n  end\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const dsl = serializeFlowchart(result.model);
    expect(dsl).toMatch(/direction LR/);

    const reparsed = parseFlowchart(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.containers.find((c) => c.id === 'sub1')!.direction).toBe('LR');
    }
  });

  it('does not emit a "direction" line for a subgraph with no override', () => {
    const result = parseFlowchart('flowchart TD\n  subgraph sub1\n    A --> B\n  end\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const dsl = serializeFlowchart(result.model);
    expect(dsl).not.toMatch(/direction/);
  });
});
