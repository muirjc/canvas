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

/**
 * jmuir-dtu.4: `actor` keyword, the full arrow-token set, activation (both the explicit
 * statements and the +/- shorthand form), `rect`/`box` blocks, and `autonumber` — see
 * sequence.ts's own comments for the grammar this is asserting against (especially
 * ARROW_TOKEN_TO_STYLE / ARROW_STYLE_TO_TOKEN and the +/- activation asymmetry).
 */
describe('sequence parser: actor keyword, arrow tokens, activation, rect/box, autonumber', () => {
  describe('actor vs participant', () => {
    it('"actor" gets role actor / shape person; "participant" gets role participant / shape rectangle', () => {
      const dsl = 'sequenceDiagram\nactor Alice\nparticipant Bob\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const alice = result.model.nodes.find((n) => n.id === 'Alice')!;
      const bob = result.model.nodes.find((n) => n.id === 'Bob')!;
      expect(alice.role).toBe('actor');
      expect(alice.shape).toBe('person');
      expect(bob.role).toBe('participant');
      expect(bob.shape).toBe('rectangle');
    });

    it('"as <alias>" sets the label but keeps the id canonical, for both actor and participant', () => {
      const dsl = 'sequenceDiagram\nactor A as Alice\nparticipant B as Bob\nA->>B: hi\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const a = result.model.nodes.find((n) => n.id === 'A')!;
      const b = result.model.nodes.find((n) => n.id === 'B')!;
      expect(a.label).toBe('Alice');
      expect(b.label).toBe('Bob');
      const edge = result.model.edges[0];
      expect(edge.sourceId).toBe('A');
      expect(edge.targetId).toBe('B');
    });

    it('order-independent: a message referencing an id before its own actor/participant line still ends up correctly typed and aliased', () => {
      const dsl = 'sequenceDiagram\nA->>B: hi\nactor A as Alice\nparticipant B as Bob\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const a = result.model.nodes.find((n) => n.id === 'A')!;
      const b = result.model.nodes.find((n) => n.id === 'B')!;
      expect(a.role).toBe('actor');
      expect(a.shape).toBe('person');
      expect(a.label).toBe('Alice');
      expect(b.role).toBe('participant');
      expect(b.shape).toBe('rectangle');
      expect(b.label).toBe('Bob');
    });
  });

  describe('arrow tokens', () => {
    const ARROW_CASES: Array<{
      token: string;
      arrow: 'none' | 'target' | 'both' | 'cross' | 'open';
      lineStyle: 'solid' | 'dotted';
    }> = [
      { token: '->', arrow: 'none', lineStyle: 'solid' },
      { token: '-->', arrow: 'none', lineStyle: 'dotted' },
      { token: '->>', arrow: 'target', lineStyle: 'solid' },
      { token: '-->>', arrow: 'target', lineStyle: 'dotted' },
      { token: '-x', arrow: 'cross', lineStyle: 'solid' },
      { token: '--x', arrow: 'cross', lineStyle: 'dotted' },
      { token: '-)', arrow: 'open', lineStyle: 'solid' },
      { token: '--)', arrow: 'open', lineStyle: 'dotted' },
      { token: '<<->>', arrow: 'both', lineStyle: 'solid' },
      { token: '<<-->>', arrow: 'both', lineStyle: 'dotted' },
    ];

    it.each(ARROW_CASES)('parses "$token" as arrow=$arrow lineStyle=$lineStyle and round-trips to the identical token', ({ token, arrow, lineStyle }) => {
      const dsl = `sequenceDiagram\nparticipant A\nparticipant B\nA${token}B: msg\n`;
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const edge = result.model.edges[0];
      expect(edge.arrow).toBe(arrow);
      expect(edge.lineStyle).toBe(lineStyle);

      const reexported = serializeSequence(result.model);
      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.edges[0].arrow).toBe(arrow);
      expect(reparsed.model.edges[0].lineStyle).toBe(lineStyle);
      // ARROW_TOKEN_TO_STYLE and ARROW_STYLE_TO_TOKEN are exact inverses, so the canonical
      // re-serialized token is identical to the one that was parsed.
      expect(reexported).toContain(`A${token}B: msg`);
    });
  });

  describe('activation', () => {
    it('explicit "activate"/"deactivate" statements produce activate/deactivate containers attached to the named participant', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nactivate A\ndeactivate A\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const activate = result.model.containers.find((c) => c.role === 'activate')!;
      const deactivate = result.model.containers.find((c) => c.role === 'deactivate')!;
      expect(activate.attachedNodeIds).toEqual(['A']);
      expect(deactivate.attachedNodeIds).toEqual(['A']);

      const reexported = serializeSequence(result.model);
      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.containers.filter((c) => c.role === 'activate')).toHaveLength(1);
      expect(reparsed.model.containers.filter((c) => c.role === 'deactivate')).toHaveLength(1);
    });

    it('stacked/repeated activation of the same participant produces multiple independent activate containers with no error', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nactivate A\nactivate A\ndeactivate A\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const activations = result.model.containers.filter((c) => c.role === 'activate');
      expect(activations).toHaveLength(2);
      // Independent items, not a linked pair — distinct ids, each with its own attachment.
      expect(new Set(activations.map((c) => c.id)).size).toBe(2);
      expect(activations.every((c) => c.attachedNodeIds?.[0] === 'A')).toBe(true);
    });

    it('the "+"/"-" arrow shorthand activates the TARGET on "+" and deactivates the SOURCE on "-" (asymmetric, not the same participant for both signs on the same A->>B direction)', () => {
      // Both messages go the same direction (A to B) so the only variable is the sign — if the
      // signs were (wrongly) symmetric, both would reference the same participant. They don't:
      // "+" activates B (the target of "A->>+B"), "-" deactivates A (the source of "A->>-B").
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>+B: msg1\nA->>-B: msg2\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const containers = result.model.containers;
      expect(containers).toHaveLength(2);
      const activate = containers.find((c) => c.role === 'activate')!;
      const deactivate = containers.find((c) => c.role === 'deactivate')!;
      expect(activate).toBeDefined();
      expect(deactivate).toBeDefined();
      // "+" on "A->>+B" activates B (the arrow's TARGET), not A (the source).
      expect(activate.attachedNodeIds).toEqual(['B']);
      // "-" on "A->>-B" deactivates A (the arrow's SOURCE), not B (the target) — even though the
      // arrow points the same direction as the "+" case above.
      expect(deactivate.attachedNodeIds).toEqual(['A']);
    });

    it('the "+"/"-" shorthand also produces the documented pairing when the response arrow reverses direction: "A->>+B" then "B-->>-A" both activate/deactivate B', () => {
      // A common real-world pattern: request activates the callee, response (source now B)
      // deactivates that same callee — both signs end up referencing B, since "-" always targets
      // the SOURCE of ITS OWN message, and B is the source of the response.
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>+B: request\nB-->>-A: response\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const activate = result.model.containers.find((c) => c.role === 'activate')!;
      const deactivate = result.model.containers.find((c) => c.role === 'deactivate')!;
      expect(activate.attachedNodeIds).toEqual(['B']);
      expect(deactivate.attachedNodeIds).toEqual(['B']);
    });

    it('the "+"/"-" shorthand round-trips as the dedicated activate/deactivate statement form, not the reconstructed shorthand', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>+B: request\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const reexported = serializeSequence(result.model);
      expect(reexported).toContain('A->>B: request');
      expect(reexported).toContain('activate B');
      expect(reexported).not.toContain('+B');

      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.containers.find((c) => c.role === 'activate')?.attachedNodeIds).toEqual(['B']);
    });
  });

  describe('create/destroy participants (jmuir-dtu.4.1)', () => {
    it('"create participant X"/"create actor X" produce correctly typed/shaped nodes, a create-role container, and round-trip as an inline "create ..." line (not a top-of-file declaration)', () => {
      const dsl = 'sequenceDiagram\nparticipant Existing\ncreate participant P\ncreate actor Q\nExisting->>P: hi\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const p = result.model.nodes.find((n) => n.id === 'P')!;
      const q = result.model.nodes.find((n) => n.id === 'Q')!;
      expect(p.role).toBe('participant');
      expect(p.shape).toBe('rectangle');
      expect(q.role).toBe('actor');
      expect(q.shape).toBe('person');

      const createP = result.model.containers.find((c) => c.role === 'create' && c.attachedNodeIds?.[0] === 'P');
      const createQ = result.model.containers.find((c) => c.role === 'create' && c.attachedNodeIds?.[0] === 'Q');
      expect(createP).toBeDefined();
      expect(createP?.attachedNodeIds).toEqual(['P']);
      expect(createQ).toBeDefined();
      expect(createQ?.attachedNodeIds).toEqual(['Q']);

      const reexported = serializeSequence(result.model);
      expect(reexported).toContain('create participant P');
      expect(reexported).toContain('create actor Q');
      const lines = reexported.split(/\r?\n/);
      // Not declared as a plain top-of-file participant/actor line.
      expect(lines).not.toContain('participant P');
      expect(lines).not.toContain('actor Q');
      // The pre-existing, non-created participant is unaffected.
      expect(lines).toContain('participant Existing');
    });

    it('"create ... as <alias>" sets the label and round-trips the alias on the inline "create" line', () => {
      const dsl = 'sequenceDiagram\ncreate participant P as Payment Service\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const p = result.model.nodes.find((n) => n.id === 'P')!;
      expect(p.label).toBe('Payment Service');

      const reexported = serializeSequence(result.model);
      expect(reexported).toContain('create participant P as Payment Service');

      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.nodes.find((n) => n.id === 'P')!.label).toBe('Payment Service');
    });

    it('"destroy X" produces a destroy-role container and round-trips as a "destroy X" line', () => {
      const dsl = 'sequenceDiagram\nparticipant A\ndestroy A\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const destroyContainer = result.model.containers.find((c) => c.role === 'destroy')!;
      expect(destroyContainer).toBeDefined();
      expect(destroyContainer.attachedNodeIds).toEqual(['A']);

      const reexported = serializeSequence(result.model);
      expect(reexported).toContain('destroy A');

      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.containers.find((c) => c.role === 'destroy')?.attachedNodeIds).toEqual(['A']);
    });

    it('"destroy X" round-trips at its correct position relative to surrounding messages', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hi\ndestroy B\nA->>B: bye\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const reexported = serializeSequence(result.model);
      const lines = reexported.split(/\r?\n/).filter((l) => l.trim());
      const hiIndex = lines.findIndex((l) => l.includes('hi'));
      const destroyIndex = lines.findIndex((l) => l.trim() === 'destroy B');
      const byeIndex = lines.findIndex((l) => l.includes('bye'));
      expect(hiIndex).toBeLessThan(destroyIndex);
      expect(destroyIndex).toBeLessThan(byeIndex);
    });

    it('order-independent: a message referencing a participant before its own "create" line still produces the node and create container correctly', () => {
      const dsl = 'sequenceDiagram\nA->>B: hi\ncreate participant B\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const b = result.model.nodes.find((n) => n.id === 'B')!;
      expect(b).toBeDefined();
      expect(b.role).toBe('participant');
      const createB = result.model.containers.find((c) => c.role === 'create' && c.attachedNodeIds?.[0] === 'B');
      expect(createB).toBeDefined();
      const reexported = serializeSequence(result.model);
      expect(reexported.split(/\r?\n/)).not.toContain('participant B');
      expect(reexported).toContain('create participant B');
    });

    it('order-independent: a "destroy" line for a participant declared only afterward via a message still resolves correctly', () => {
      const dsl = 'sequenceDiagram\ndestroy X\nX->>Y: msg\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const x = result.model.nodes.find((n) => n.id === 'X')!;
      expect(x).toBeDefined();
      const destroyX = result.model.containers.find((c) => c.role === 'destroy');
      expect(destroyX?.attachedNodeIds).toEqual(['X']);
      const edge = result.model.edges.find((e) => e.label === 'msg')!;
      expect(edge.sourceId).toBe('X');
      expect(edge.targetId).toBe('Y');
    });

    it('"create" nested inside a loop/alt/rect block gets the correct parentContainerId and round-trips nested inside that block\'s own "... end"', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nloop Retry\ncreate participant P\nA->>P: hi\nend\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const loop = result.model.containers.find((c) => c.role === 'loop')!;
      const createContainer = result.model.containers.find((c) => c.role === 'create')!;
      expect(createContainer.parentContainerId).toBe(loop.id);

      const reexported = serializeSequence(result.model);
      const lines = reexported.split(/\r?\n/).filter((l) => l.trim());
      const loopIndex = lines.findIndex((l) => l.trim().startsWith('loop'));
      const createIndex = lines.findIndex((l) => l.trim().startsWith('create participant P'));
      const endIndex = lines.findIndex((l, idx) => idx > loopIndex && l.trim() === 'end');
      expect(loopIndex).toBeLessThan(createIndex);
      expect(createIndex).toBeLessThan(endIndex);
      // The "create" line is indented inside the loop, same as a plain message would be.
      const rawCreateLine = lines.find((l) => l.trim().startsWith('create participant P'))!;
      expect(rawCreateLine.startsWith('  ')).toBe(true);

      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      const reparsedLoop = reparsed.model.containers.find((c) => c.role === 'loop')!;
      const reparsedCreate = reparsed.model.containers.find((c) => c.role === 'create')!;
      expect(reparsedCreate.parentContainerId).toBe(reparsedLoop.id);
    });

    it('a node with no "create" container still gets a normal top-of-file participant/actor declaration (regression guard)', () => {
      const dsl = 'sequenceDiagram\nparticipant Normal\nactor Regular\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const reexported = serializeSequence(result.model);
      const lines = reexported.split(/\r?\n/);
      expect(lines).toContain('participant Normal');
      expect(lines).toContain('actor Regular');
    });

    it('multiple participants, some created inline and some declared normally, in one diagram: top-of-file declarations only include the non-created ones, and created ones appear at their correct inline positions', () => {
      const dsl = [
        'sequenceDiagram',
        'participant Alice',
        'participant Bob',
        'Alice->>Bob: hi',
        'create participant Carol',
        'Bob->>Carol: welcome',
        'create actor Dave',
        'Carol->>Dave: hello',
        '',
      ].join('\n');
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const reexported = serializeSequence(result.model);
      const allLines = reexported.split(/\r?\n/).filter((l) => l.trim());
      // Skip the front-matter block (position coordinates would otherwise contain lines
      // literally naming "Carol"/"Dave", producing a false positive below).
      const lines = allLines.slice(allLines.indexOf('sequenceDiagram'));

      // Top-of-file declarations (everything before the first message) only include the
      // non-created participants.
      const firstMessageIndex = lines.findIndex((l) => l.includes('->>'));
      const topDeclarations = lines.slice(0, firstMessageIndex);
      expect(topDeclarations).toContain('participant Alice');
      expect(topDeclarations).toContain('participant Bob');
      expect(topDeclarations.some((l) => l.includes('Carol'))).toBe(false);
      expect(topDeclarations.some((l) => l.includes('Dave'))).toBe(false);

      // Created participants appear inline, at their correct position relative to surrounding messages.
      const hiIndex = lines.findIndex((l) => l.includes('hi'));
      const createCarolIndex = lines.findIndex((l) => l.trim() === 'create participant Carol');
      const welcomeIndex = lines.findIndex((l) => l.includes('welcome'));
      const createDaveIndex = lines.findIndex((l) => l.trim() === 'create actor Dave');
      const helloIndex = lines.findIndex((l) => l.includes('hello'));
      expect(hiIndex).toBeLessThan(createCarolIndex);
      expect(createCarolIndex).toBeLessThan(welcomeIndex);
      expect(welcomeIndex).toBeLessThan(createDaveIndex);
      expect(createDaveIndex).toBeLessThan(helloIndex);
    });

    it('round-trips a normal participant, a created participant with an alias, a message between them, and a destroy, all in one diagram', () => {
      const dsl = [
        'sequenceDiagram',
        'participant Client',
        'create participant Server as App Server',
        'Client->>Server: request',
        'destroy Server',
        '',
      ].join('\n');
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const reexported = serializeSequence(result.model);
      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      const model = reparsed.model;

      expect(model.nodes).toHaveLength(2);
      const client = model.nodes.find((n) => n.id === 'Client')!;
      const server = model.nodes.find((n) => n.id === 'Server')!;
      expect(client.label).toBe('Client');
      expect(server.label).toBe('App Server');

      const createContainer = model.containers.find((c) => c.role === 'create')!;
      expect(createContainer.attachedNodeIds).toEqual(['Server']);
      const destroyContainer = model.containers.find((c) => c.role === 'destroy')!;
      expect(destroyContainer.attachedNodeIds).toEqual(['Server']);

      const edge = model.edges.find((e) => e.label === 'request')!;
      expect(edge.sourceId).toBe('Client');
      expect(edge.targetId).toBe('Server');

      // "Client" stays a normal top-of-file declaration; "Server" doesn't.
      const lines = reexported.split(/\r?\n/);
      expect(lines).toContain('participant Client');
      expect(lines).not.toContain('participant Server');
      expect(reexported).toContain('create participant Server as App Server');
      expect(reexported).toContain('destroy Server');

      // Original interleaved order preserved: create -> request -> destroy.
      const contentLines = lines.filter((l) => l.trim());
      const createIndex = contentLines.findIndex((l) => l.includes('create participant Server'));
      const requestIndex = contentLines.findIndex((l) => l.includes('request'));
      const destroyIndex = contentLines.findIndex((l) => l.trim() === 'destroy Server');
      expect(createIndex).toBeLessThan(requestIndex);
      expect(requestIndex).toBeLessThan(destroyIndex);
    });
  });

  describe('rect block', () => {
    it('"rect <color> ... end" puts the color into style.fillColor, keeps label empty, and nests messages inside', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nrect rgb(200, 200, 200)\nA->>B: one\nA->>B: two\nend\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const rect = result.model.containers.find((c) => c.role === 'rect')!;
      expect(rect.label).toBe('');
      expect(rect.style?.fillColor).toBe('rgb(200, 200, 200)');
      const nested = result.model.edges.filter((e) => e.containerId === rect.id);
      expect(nested).toHaveLength(2);
    });

    it('round-trips "rect" with the color preserved as a "rect <color>" line, not as a label', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nrect rgb(10, 20, 30)\nA->>B: one\nend\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const reexported = serializeSequence(result.model);
      expect(reexported).toContain('rect rgb(10, 20, 30)');

      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      const rect = reparsed.model.containers.find((c) => c.role === 'rect')!;
      expect(rect.style?.fillColor).toBe('rgb(10, 20, 30)');
      expect(rect.label).toBe('');
    });
  });

  describe('box grouping', () => {
    it('groups participant/actor members via node.containerId, recognizes rgb()/transparent colors and a title, and leaves un-boxed participants uncontained', () => {
      const dsl = [
        'sequenceDiagram',
        'box rgb(10, 20, 30) Team One',
        'actor A as Alice',
        'participant B as Bob',
        'end',
        'box transparent',
        'participant D',
        'end',
        'participant C',
        '',
      ].join('\n');
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const boxOne = result.model.containers.find((c) => c.role === 'box' && c.label === 'Team One')!;
      expect(boxOne).toBeDefined();
      expect(boxOne.style?.fillColor).toBe('rgb(10, 20, 30)');
      const boxTwo = result.model.containers.find((c) => c.role === 'box' && c.id !== boxOne.id)!;
      expect(boxTwo).toBeDefined();
      expect(boxTwo.style?.fillColor).toBe('transparent');
      expect(boxTwo.label).toBe('');

      const a = result.model.nodes.find((n) => n.id === 'A')!;
      const b = result.model.nodes.find((n) => n.id === 'B')!;
      const d = result.model.nodes.find((n) => n.id === 'D')!;
      const c = result.model.nodes.find((n) => n.id === 'C')!;
      expect(a.containerId).toBe(boxOne.id);
      expect(a.role).toBe('actor');
      expect(a.label).toBe('Alice');
      expect(b.containerId).toBe(boxOne.id);
      expect(b.label).toBe('Bob');
      expect(d.containerId).toBe(boxTwo.id);
      expect(c.containerId).toBeUndefined();

      // box containers aren't part of the message timeline.
      expect(boxOne.sequenceOrder).toBeUndefined();
      expect(boxOne.parentContainerId).toBeUndefined();
    });

    it('round-trips a box with re-nested members, followed by non-boxed participants emitted separately', () => {
      const dsl = [
        'sequenceDiagram',
        'box rgb(1, 2, 3) Squad',
        'actor A as Alice',
        'participant B',
        'end',
        'participant C',
        '',
      ].join('\n');
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const reexported = serializeSequence(result.model);
      expect(reexported).toContain('box rgb(1, 2, 3) Squad');

      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      const box = reparsed.model.containers.find((c) => c.role === 'box')!;
      expect(box.style?.fillColor).toBe('rgb(1, 2, 3)');
      expect(box.label).toBe('Squad');
      const a = reparsed.model.nodes.find((n) => n.id === 'A')!;
      const b = reparsed.model.nodes.find((n) => n.id === 'B')!;
      const c = reparsed.model.nodes.find((n) => n.id === 'C')!;
      expect(a.containerId).toBe(box.id);
      expect(b.containerId).toBe(box.id);
      expect(c.containerId).toBeUndefined();
    });
  });

  describe('autonumber', () => {
    it('bare "autonumber" sets sequenceAutonumber (defined, with start/step both undefined)', () => {
      const dsl = 'sequenceDiagram\nautonumber\nparticipant A\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.sequenceAutonumber).toBeDefined();
      expect(result.model.sequenceAutonumber?.start).toBeUndefined();
      expect(result.model.sequenceAutonumber?.step).toBeUndefined();
    });

    it('"autonumber <start> <step>" (including decimals) captures both values', () => {
      const dsl = 'sequenceDiagram\nautonumber 10 2\nparticipant A\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.sequenceAutonumber).toEqual({ start: 10, step: 2 });

      const decimalDsl = 'sequenceDiagram\nautonumber 1.5 0.5\nparticipant A\n';
      const decimalResult = parseSequence(decimalDsl);
      expect(isParseSuccess(decimalResult)).toBe(true);
      if (!isParseSuccess(decimalResult)) return;
      expect(decimalResult.model.sequenceAutonumber).toEqual({ start: 1.5, step: 0.5 });
    });

    it('no "autonumber" line at all leaves sequenceAutonumber undefined, not a default object', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hi\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.sequenceAutonumber).toBeUndefined();
    });
  });

  describe('combined round-trip', () => {
    it('round-trips a diagram combining autonumber, a colored/titled box of aliased actor/participant members, a rect block with an activation-shorthand message, and cross/open/bidirectional arrows', () => {
      const dsl = [
        'sequenceDiagram',
        'autonumber 5 1',
        'box rgb(10, 20, 30) Team',
        'actor A as Alice',
        'participant B as Bob',
        'end',
        'participant C',
        'rect rgb(100, 100, 100)',
        'A->>+B: start work',
        'end',
        'B-xC: fail case',
        'C-)A: async notify',
        'A<<->>C: sync both',
        '',
      ].join('\n');
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;

      const reexported = serializeSequence(result.model);
      const reparsed = parseSequence(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      const model = reparsed.model;

      expect(model.sequenceAutonumber).toEqual({ start: 5, step: 1 });

      const box = model.containers.find((c) => c.role === 'box')!;
      expect(box.style?.fillColor).toBe('rgb(10, 20, 30)');
      expect(box.label).toBe('Team');
      const a = model.nodes.find((n) => n.id === 'A')!;
      const b = model.nodes.find((n) => n.id === 'B')!;
      const c = model.nodes.find((n) => n.id === 'C')!;
      expect(a.containerId).toBe(box.id);
      expect(a.role).toBe('actor');
      expect(a.label).toBe('Alice');
      expect(b.containerId).toBe(box.id);
      expect(b.label).toBe('Bob');
      expect(c.containerId).toBeUndefined();

      const rect = model.containers.find((c) => c.role === 'rect')!;
      expect(rect.style?.fillColor).toBe('rgb(100, 100, 100)');
      const activate = model.containers.find((c) => c.role === 'activate')!;
      expect(activate.attachedNodeIds).toEqual(['B']);
      expect(activate.parentContainerId).toBe(rect.id);

      const startWork = model.edges.find((e) => e.label === 'start work')!;
      expect(startWork.containerId).toBe(rect.id);
      expect(startWork.arrow).toBe('target');
      expect(startWork.lineStyle).toBe('solid');

      const failCase = model.edges.find((e) => e.label === 'fail case')!;
      expect(failCase.arrow).toBe('cross');
      expect(failCase.lineStyle).toBe('solid');
      const asyncNotify = model.edges.find((e) => e.label === 'async notify')!;
      expect(asyncNotify.arrow).toBe('open');
      expect(asyncNotify.lineStyle).toBe('solid');
      const syncBoth = model.edges.find((e) => e.label === 'sync both')!;
      expect(syncBoth.arrow).toBe('both');
      expect(syncBoth.lineStyle).toBe('solid');
    });
  });

  // jmuir-dtu.4.1 implemented create/destroy (see the "create/destroy participants" describe
  // block below) -- superseding jmuir-dtu.4's own "still out of scope" guards for them. Only the
  // half-arrow tokens remain genuinely deferred (see jmuir-dtu.4.1's own decision notes: too
  // new/niche relative to their implementation cost, a closed decision, not a further-deferred
  // one) and actor link/links menu directives (deferred pending flowchart's own not-yet-
  // implemented click/href security design, jmuir-dzd grouping G).
  describe('out-of-scope constructs still fail to parse', () => {
    it('a half-arrow token (e.g. "-|\\") is not silently accepted', () => {
      const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nA-|\\B: msg\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(false);
    });

    it('an actor "link" directive is not silently accepted', () => {
      const dsl = 'sequenceDiagram\nactor A\nlink A: Dashboard @ https://example.com\n';
      const result = parseSequence(dsl);
      expect(isParseSuccess(result)).toBe(false);
    });
  });
});
