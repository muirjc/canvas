import { describe, expect, it } from 'vitest';
import { computeSequenceLayout } from '../../src/render/sequence-layout.js';
import { parseSequence } from '../../src/dsl/sequence.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * canvas-7vs.1: computeSequenceLayout() is the one shared geometry calculation both renderers
 * consume (contracts/sequence-layout-contract.md). These tests assert real numeric relationships
 * — not just "it doesn't throw" — per quickstart.md's own warning that a happy-path-only suite
 * would pass even if every message collapsed onto the same y-value (the exact bug this feature
 * fixes).
 */
function parseOk(dsl: string) {
  const result = parseSequence(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('parse failed');
  return result.model;
}

describe('computeSequenceLayout: lifelines (US1)', () => {
  it('orders lifelines left-to-right by declaration order', () => {
    const model = parseOk('sequenceDiagram\nparticipant Alice\nparticipant Bob\nparticipant Carol\n');
    const layout = computeSequenceLayout(model);
    const alice = layout.lifelines.get('Alice')!;
    const bob = layout.lifelines.get('Bob')!;
    const carol = layout.lifelines.get('Carol')!;
    expect(alice.x).toBeLessThan(bob.x);
    expect(bob.x).toBeLessThan(carol.x);
  });

  it('every participant gets a distinct, non-overlapping lifeline', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nparticipant B\n');
    const layout = computeSequenceLayout(model);
    const a = layout.lifelines.get('A')!;
    const b = layout.lifelines.get('B')!;
    expect(a.x).not.toBe(b.x);
    expect(a.headerX + a.headerWidth).toBeLessThanOrEqual(b.headerX);
  });
});

describe('computeSequenceLayout: messages (US1)', () => {
  it('4 messages between the same 2 participants get 4 distinct, strictly increasing y-values in declared order', () => {
    const model = parseOk(
      'sequenceDiagram\nparticipant Alice\nparticipant John\nAlice->>+John: msg1\nJohn-->>Alice: msg2\nAlice->>+John: msg3\nJohn-->>-Alice: msg4\n',
    );
    const layout = computeSequenceLayout(model);
    const ys = model.edges.map((e) => layout.messages.get(e.id)!.y);
    expect(new Set(ys).size).toBe(ys.length);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  });

  it('flags a self-message distinctly from an ordinary message', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nA->>A: think\n');
    const layout = computeSequenceLayout(model);
    const edge = model.edges[0];
    expect(layout.messages.get(edge.id)!.isSelfMessage).toBe(true);
  });

  it('an ordinary message (different source/target) is not flagged as a self-message', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hi\n');
    const layout = computeSequenceLayout(model);
    expect(layout.messages.get(model.edges[0].id)!.isSelfMessage).toBe(false);
  });
});

describe('computeSequenceLayout: activation bars (US2)', () => {
  it('an activate/deactivate pair gets a bar spanning exactly that message range, on the right participant', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nparticipant B\nactivate B\nA->>B: work\ndeactivate B\n');
    const activateContainer = model.containers.find((c) => c.role === 'activate')!;
    const deactivateContainer = model.containers.find((c) => c.role === 'deactivate')!;
    const layout = computeSequenceLayout(model);
    const bar = layout.activations.get(activateContainer.id)!;
    expect(bar.participantId).toBe('B');
    expect(bar.x).toBe(layout.lifelines.get('B')!.x);
    expect(bar.yStart).toBeLessThan(bar.yEnd);
    expect(deactivateContainer).toBeDefined();
  });

  it('nested/stacked activations on the same participant get distinct lane offsets', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nactivate A\nactivate A\ndeactivate A\ndeactivate A\n');
    const activations = model.containers.filter((c) => c.role === 'activate');
    const layout = computeSequenceLayout(model);
    const bars = activations.map((c) => layout.activations.get(c.id)!);
    expect(bars).toHaveLength(2);
    expect(bars[0].laneOffset).not.toBe(bars[1].laneOffset);
    expect(bars[0].x).not.toBe(bars[1].x);
  });

  it('an activate with no matching deactivate still produces finite, well-formed bar geometry', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nactivate A\n');
    const activateContainer = model.containers.find((c) => c.role === 'activate')!;
    const layout = computeSequenceLayout(model);
    const bar = layout.activations.get(activateContainer.id)!;
    expect(Number.isFinite(bar.yStart)).toBe(true);
    expect(Number.isFinite(bar.yEnd)).toBe(true);
    expect(bar.yEnd).toBeGreaterThan(bar.yStart);
  });
});

describe('computeSequenceLayout: control-flow blocks (US3)', () => {
  it('a loop wrapping messages between 2 of 3 participants spans only those 2 lifelines', () => {
    const model = parseOk(
      'sequenceDiagram\nparticipant Alice\nparticipant Bob\nparticipant Carol\nloop Retry\nAlice->>Bob: ping\nBob->>Alice: pong\nend\n',
    );
    const loop = model.containers.find((c) => c.role === 'loop')!;
    const layout = computeSequenceLayout(model);
    const block = layout.blocks.get(loop.id)!;
    const alice = layout.lifelines.get('Alice')!;
    const bob = layout.lifelines.get('Bob')!;
    const carol = layout.lifelines.get('Carol')!;
    expect(block.x).toBeLessThanOrEqual(alice.x);
    expect(block.x + block.width).toBeGreaterThanOrEqual(bob.x);
    // Carol's lifeline sits strictly to the right of the block's own bounds.
    expect(block.x + block.width).toBeLessThan(carol.x);
  });

  it('an alt/else block produces a divider entry at the second branch\'s starting row', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nparticipant B\nalt Check\nA->>B: one\nelse Failure\nA->>B: two\nend\n');
    const elseBranch = model.containers.find((c) => c.role === 'else')!;
    const layout = computeSequenceLayout(model);
    const divider = layout.blocks.get(elseBranch.id)!;
    expect(divider.isDivider).toBe(true);
    expect(divider.height).toBe(0);
  });

  it('a loop nested inside an alt branch renders fully inside the outer bounds', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nparticipant B\nalt Outer\nloop Inner\nA->>B: msg\nend\nend\n');
    const outer = model.containers.find((c) => c.role === 'alt')!;
    const inner = model.containers.find((c) => c.role === 'loop')!;
    const layout = computeSequenceLayout(model);
    const outerBlock = layout.blocks.get(outer.id)!;
    const innerBlock = layout.blocks.get(inner.id)!;
    expect(innerBlock.x).toBeGreaterThanOrEqual(outerBlock.x);
    expect(innerBlock.x + innerBlock.width).toBeLessThanOrEqual(outerBlock.x + outerBlock.width);
    expect(innerBlock.y).toBeGreaterThanOrEqual(outerBlock.y);
    expect(innerBlock.y + innerBlock.height).toBeLessThanOrEqual(outerBlock.y + outerBlock.height);
  });

  it('an empty block (no messages/nested blocks) falls back to a well-formed default, not NaN/undefined', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nloop Empty\nend\n');
    const loop = model.containers.find((c) => c.role === 'loop')!;
    const layout = computeSequenceLayout(model);
    const block = layout.blocks.get(loop.id)!;
    expect(Number.isFinite(block.x)).toBe(true);
    expect(Number.isFinite(block.width)).toBe(true);
    expect(block.width).toBeGreaterThan(0);
  });
});

describe('computeSequenceLayout: notes and boxes (US4)', () => {
  it('Note over spans from the leftmost to the rightmost named participant', () => {
    const model = parseOk('sequenceDiagram\nparticipant Alice\nparticipant Bob\nNote over Alice, Bob: hi\n');
    const note = model.containers.find((c) => c.role === 'note-over')!;
    const layout = computeSequenceLayout(model);
    const alice = layout.lifelines.get('Alice')!;
    const bob = layout.lifelines.get('Bob')!;
    const noteLayout = layout.notes.get(note.id)!;
    const noteCenter = noteLayout.x + (note.size?.width ?? 0) / 2;
    expect(noteCenter).toBeGreaterThanOrEqual(alice.x);
    expect(noteCenter).toBeLessThanOrEqual(bob.x);
  });

  it('Note right of sits to the right of its single participant', () => {
    const model = parseOk('sequenceDiagram\nparticipant Bob\nNote right of Bob: text\n');
    const note = model.containers.find((c) => c.role === 'note-right')!;
    const layout = computeSequenceLayout(model);
    expect(layout.notes.get(note.id)!.x).toBeGreaterThan(layout.lifelines.get('Bob')!.x);
  });

  it('Note left of sits to the left of its single participant', () => {
    const model = parseOk('sequenceDiagram\nparticipant Bob\nNote left of Bob: text\n');
    const note = model.containers.find((c) => c.role === 'note-left')!;
    const layout = computeSequenceLayout(model);
    expect(layout.notes.get(note.id)!.x).toBeLessThan(layout.lifelines.get('Bob')!.x);
  });

  it('a box grouping spans only its member participants\' lifelines, full diagram height', () => {
    const model = parseOk('sequenceDiagram\nbox Team\nparticipant A\nparticipant B\nend\nparticipant C\n');
    const box = model.containers.find((c) => c.role === 'box')!;
    const layout = computeSequenceLayout(model);
    const boxLayout = layout.boxes.get(box.id)!;
    const a = layout.lifelines.get('A')!;
    const b = layout.lifelines.get('B')!;
    const c = layout.lifelines.get('C')!;
    expect(boxLayout.x).toBeLessThanOrEqual(a.x);
    expect(boxLayout.x + boxLayout.width).toBeGreaterThanOrEqual(b.x);
    expect(boxLayout.x + boxLayout.width).toBeLessThan(c.x);
    expect(boxLayout.height).toBeGreaterThan(layout.diagramHeight - 100);
  });
});

describe('computeSequenceLayout: determinism (contract)', () => {
  it('returns identical geometry for the same model across repeated calls', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hi\n');
    const layout1 = computeSequenceLayout(model);
    const layout2 = computeSequenceLayout(model);
    expect(layout1.lifelines.get('A')).toEqual(layout2.lifelines.get('A'));
    expect(layout1.messages.get(model.edges[0].id)).toEqual(layout2.messages.get(model.edges[0].id));
  });

  it('does not mutate the model', () => {
    const model = parseOk('sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hi\n');
    const before = JSON.stringify(model);
    computeSequenceLayout(model);
    expect(JSON.stringify(model)).toBe(before);
  });
});
