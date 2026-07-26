import { describe, expect, it } from 'vitest';
import { parseSequence, serializeSequence } from '../../src/dsl/sequence.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * Feature 003, User Story 3: sequence diagrams must support Note left/right/over and nestable
 * control-flow blocks (loop/alt/opt/par/critical/break) — currently only bare `participant` +
 * message parses (FR-009–FR-014).
 */
describe('sequence parser: notes and control-flow blocks', () => {
  it('parses "Note right of X" into a note-right container attached to X', () => {
    const dsl = 'sequenceDiagram\nparticipant Alice\nNote right of Alice: some text\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const note = result.model.containers.find((c) => c.role === 'note-right')!;
      expect(note).toBeDefined();
      expect(note.attachedNodeIds).toEqual(['Alice']);
      expect(note.label).toBe('some text');
    }
  });

  it('parses "Note left of X" into a note-left container', () => {
    const dsl = 'sequenceDiagram\nparticipant Alice\nNote left of Alice: some text\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.containers.find((c) => c.role === 'note-left')).toBeDefined();
    }
  });

  it('parses "Note over A, B, C" with an arbitrary number of participants', () => {
    const dsl = 'sequenceDiagram\nparticipant Alice\nparticipant Bob\nparticipant Carol\nNote over Alice, Bob, Carol: some text\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const note = result.model.containers.find((c) => c.role === 'note-over')!;
      expect(note.attachedNodeIds).toEqual(['Alice', 'Bob', 'Carol']);
    }
  });

  it('parses a loop block wrapping two messages', () => {
    const dsl = 'sequenceDiagram\nAlice->>Bob: Hi\nloop Retry\nAlice->>Bob: Ping\nBob->>Alice: Pong\nend\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const loop = result.model.containers.find((c) => c.role === 'loop')!;
      expect(loop).toBeDefined();
      expect(loop.label).toBe('Retry');
      const inLoop = result.model.edges.filter((e) => e.containerId === loop.id);
      expect(inLoop).toHaveLength(2);
      // The message before the loop is NOT nested inside it.
      const outsideLoop = result.model.edges.find((e) => e.label === 'Hi')!;
      expect(outsideLoop.containerId).toBeUndefined();
    }
  });

  it('parses an alt block with an else branch as a nested child container', () => {
    const dsl = 'sequenceDiagram\nalt Check status\nAlice->>Bob: A\nelse Failure\nAlice->>Bob: B\nend\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const alt = result.model.containers.find((c) => c.role === 'alt')!;
      expect(alt.label).toBe('Check status');
      const elseBranch = result.model.containers.find((c) => c.role === 'else')!;
      expect(elseBranch.label).toBe('Failure');
      expect(elseBranch.parentContainerId).toBe(alt.id);
      // Message A belongs directly to the alt block; message B belongs to the else branch.
      const msgA = result.model.edges.find((e) => e.label === 'A')!;
      const msgB = result.model.edges.find((e) => e.label === 'B')!;
      expect(msgA.containerId).toBe(alt.id);
      expect(msgB.containerId).toBe(elseBranch.id);
    }
  });

  it('supports nesting a block inside another block', () => {
    const dsl = 'sequenceDiagram\nloop Outer\nalt Inner\nAlice->>Bob: A\nend\nend\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const outer = result.model.containers.find((c) => c.role === 'loop')!;
      const inner = result.model.containers.find((c) => c.role === 'alt')!;
      expect(inner.parentContainerId).toBe(outer.id);
    }
  });

  it('an unlabeled block (bare "opt") imports with no label', () => {
    const dsl = 'sequenceDiagram\nopt\nAlice->>Bob: A\nend\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const opt = result.model.containers.find((c) => c.role === 'opt')!;
      expect(opt.label ?? '').toBe('');
    }
  });

  it('reports a structured error for an unclosed control-flow block', () => {
    const dsl = 'sequenceDiagram\nloop Retry\nAlice->>Bob: A\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(false);
    if (!isParseSuccess(result)) {
      expect(result.errors[0].message.toLowerCase()).toContain('unclosed');
      expect(result.errors[0].message).toContain('loop');
      expect(result.errors[0].line).toBe(2);
    }
  });

  it('a diagram using only the pre-existing bare participant + message form is unchanged', () => {
    const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: Hello\n';
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes).toHaveLength(2);
      expect(result.model.edges).toHaveLength(1);
      expect(result.model.containers).toHaveLength(0);
    }
  });

  it('round-trips notes and control-flow blocks in their original interleaved order', () => {
    const dsl = [
      'sequenceDiagram',
      'participant Alice',
      'participant Bob',
      'Alice->>Bob: Hi',
      'Note over Alice, Bob: greeting exchanged',
      'loop Retry',
      'Alice->>Bob: Ping',
      'Bob->>Alice: Pong',
      'end',
      'Alice->>Bob: Bye',
      '',
    ].join('\n');
    const result = parseSequence(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const reexported = serializeSequence(result.model);
    const reparsed = parseSequence(reexported);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;

    // Same counts of everything.
    expect(reparsed.model.edges).toHaveLength(4);
    expect(reparsed.model.containers.filter((c) => c.role === 'note-over')).toHaveLength(1);
    expect(reparsed.model.containers.filter((c) => c.role === 'loop')).toHaveLength(1);

    // Original interleaving preserved: "Hi" message comes before the note, which comes before
    // the loop, which comes before "Bye" — reconstructed from the re-exported DSL's line order.
    const lines = reexported.split(/\r?\n/).filter((l) => !l.startsWith('---') && l.trim());
    const dslBody = lines.slice(lines.indexOf('sequenceDiagram'));
    const hiIndex = dslBody.findIndex((l) => l.includes('Hi'));
    const noteIndex = dslBody.findIndex((l) => l.includes('Note over'));
    const loopIndex = dslBody.findIndex((l) => l.trim().startsWith('loop'));
    const byeIndex = dslBody.findIndex((l) => l.includes('Bye'));
    expect(hiIndex).toBeLessThan(noteIndex);
    expect(noteIndex).toBeLessThan(loopIndex);
    expect(loopIndex).toBeLessThan(byeIndex);
  });
});
