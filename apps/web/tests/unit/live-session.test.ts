import { describe, expect, it } from 'vitest';
import type { DiagramModel } from '@canvas/diagram-core';
import { LiveSession, liveUrl, type LiveEvents, type LivePerson, type LiveSocket } from '../../src/app/live-session';

/** canvas-vvi: the editor's side of a live session, against a fake socket and a hand-run clock. */

class FakeSocket implements LiveSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: LiveSocket['onopen'] = null;
  onmessage: LiveSocket['onmessage'] = null;
  onclose: LiveSocket['onclose'] = null;
  closedWith: number | undefined;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number) {
    this.closedWith = code;
  }
  receive(message: Record<string, unknown>) {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  patches() {
    return this.sent.filter((m) => m.type === 'patch');
  }
}

class Clock {
  now = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = until;
  }
}

const model = (): DiagramModel => ({
  diagramTypeId: 'flowchart',
  nodes: [
    { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
    { id: 'b', label: 'B', shape: 'rectangle', position: { x: 100, y: 0 } },
  ],
  edges: [],
  containers: [],
});
const relabel = (m: DiagramModel, id: string, label: string): DiagramModel => ({
  ...m,
  nodes: m.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
});
const move = (m: DiagramModel, id: string, x: number): DiagramModel => ({
  ...m,
  nodes: m.nodes.map((n) => (n.id === id ? { ...n, position: { x, y: 0 } } : n)),
});
const labels = (m: DiagramModel) => m.nodes.map((n) => n.label);
const person = (connectionId: string, canEdit = true): LivePerson => ({
  connectionId,
  userId: `u-${connectionId}`,
  name: connectionId,
  canEdit,
  since: '2026-11-10T10:00:00.000Z',
});

function setup(options: { canEdit?: boolean; start?: DiagramModel } = {}) {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  const log: { models: DiagramModel[]; statuses: string[]; saved: unknown[]; resets: unknown[]; rejected: string[]; hellos: string[] } = {
    models: [],
    statuses: [],
    saved: [],
    resets: [],
    rejected: [],
    hellos: [],
  };
  const events: LiveEvents = {
    model: (m) => log.models.push(m),
    hello: (base) => log.hellos.push(base),
    saved: (s) => log.saved.push(s),
    reset: (r) => log.resets.push(r),
    people: () => undefined,
    status: (s, reason) => log.statuses.push(reason ? `${s}:${reason}` : s),
    rejected: (m) => log.rejected.push(m),
  };
  const session = new LiveSession(
    options.start ?? model(),
    options.canEdit ?? true,
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    events,
    clock,
  );
  session.start();
  const hello = (room: DiagramModel = model(), you = person('me', options.canEdit ?? true)) =>
    sockets[sockets.length - 1].receive({ type: 'hello', seq: 0, model: room, baseVersionId: 'v1', you, people: [you] });
  return { session, clock, sockets, log, hello, socket: () => sockets[sockets.length - 1] };
}

describe('LiveSession', () => {
  it('shows the room model on joining and says it is live', () => {
    const { log, hello } = setup();
    hello(relabel(model(), 'a', 'Live A'));
    expect(labels(log.models.at(-1)!)).toEqual(['Live A', 'B']);
    expect(log.hellos).toEqual(['v1']);
    expect(log.statuses).toEqual(['connecting', 'live']);
  });

  it('sends a drag as one patch per flush, made of what changed only', () => {
    const { session, clock, hello, socket } = setup();
    hello();
    let drawn = model();
    for (const x of [10, 20, 30]) drawn = session.edit(drawn, move(drawn, 'a', x));
    expect(socket().patches()).toHaveLength(0);
    clock.advance(60);
    expect(socket().patches()).toEqual([
      { type: 'patch', clientPatchId: 1, patch: { nodes: { changed: [{ id: 'a', set: { position: { x: 30, y: 0 } } }] } } },
    ]);
  });

  it('puts its own unacknowledged change back on top of someone else’s', () => {
    const { session, clock, log, hello, socket } = setup();
    hello();
    const drawn = session.edit(model(), relabel(model(), 'a', 'Mine'));
    clock.advance(60);
    // Bob's rename of B lands before our own patch comes back.
    socket().receive({ type: 'patch', seq: 1, by: 'bob', clientPatchId: 9, patch: { nodes: { changed: [{ id: 'b', set: { label: 'Bob' } }] } } });
    expect(labels(log.models.at(-1)!)).toEqual(['Mine', 'Bob']);
    // And Bob's change to the same field we changed is undone by ours (ours reaches the room after his).
    socket().receive({ type: 'patch', seq: 2, by: 'bob', clientPatchId: 10, patch: { nodes: { changed: [{ id: 'a', set: { label: 'Bob A' } }] } } });
    expect(labels(log.models.at(-1)!)).toEqual(['Mine', 'Bob']);
    socket().receive({ type: 'patch', seq: 3, by: 'me', clientPatchId: 1, patch: socket().patches()[0].patch });
    expect(labels(session.model)).toEqual(['Mine', 'Bob']);
    expect(drawn).toBeDefined();
  });

  it('applies an edit made from a model one remote update behind without undoing that update', () => {
    const { session, hello, socket } = setup();
    hello();
    const drawn = model();
    socket().receive({ type: 'patch', seq: 1, by: 'bob', clientPatchId: 1, patch: { nodes: { changed: [{ id: 'b', set: { label: 'Bob' } }] } } });
    // The canvas hasn't redrawn yet: it changes A from the model it last drew.
    const view = session.edit(drawn, relabel(drawn, 'a', 'Mine'));
    expect(labels(view)).toEqual(['Mine', 'Bob']);
  });

  it('undoes a change the room refused and says so', () => {
    const { session, clock, log, hello, socket } = setup();
    hello();
    session.edit(model(), relabel(model(), 'a', 'Bad'));
    clock.advance(60);
    socket().receive({ type: 'rejected', clientPatchId: 1, message: 'Nope.' });
    expect(labels(log.models.at(-1)!)).toEqual(['A', 'B']);
    expect(log.rejected).toEqual(['Nope.']);
  });

  it('sends edits made while disconnected once it is back, on top of the room’s model', () => {
    const { session, clock, log, sockets, hello, socket } = setup();
    hello();
    socket().drop(1006);
    expect(log.statuses.at(-1)).toBe('reconnecting:unreachable');
    session.edit(model(), relabel(model(), 'a', 'Offline'));
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    hello(relabel(model(), 'b', 'Bob meanwhile'));
    expect(labels(log.models.at(-1)!)).toEqual(['Offline', 'Bob meanwhile']);
    expect(socket().patches().map((m) => m.patch)).toEqual([{ nodes: { changed: [{ id: 'a', set: { label: 'Offline' } }] } }]);
  });

  it('stops trying after a sign-out, a lost share or a deleted diagram', () => {
    for (const code of [4401, 4403, 4404]) {
      const { clock, log, sockets, hello, socket } = setup();
      hello();
      socket().receive({ type: 'closed', code, reason: 'x' });
      socket().drop(code);
      clock.advance(60_000);
      expect(sockets).toHaveLength(1);
      expect(log.statuses.at(-1)?.startsWith('off:')).toBe(true);
    }
  });

  it('takes a reset as the new model and drops its own changes', () => {
    const { session, clock, log, hello, socket } = setup();
    hello();
    session.edit(model(), relabel(model(), 'a', 'Mine'));
    clock.advance(60);
    const restored = relabel(model(), 'a', 'Restored');
    socket().receive({ type: 'reset', seq: 2, model: restored, baseVersionId: 'v3', by: { id: 'u', name: 'Bob' }, reason: 'restored' });
    socket().receive({ type: 'patch', seq: 3, by: 'me', clientPatchId: 1, patch: { nodes: { changed: [{ id: 'b', set: { label: 'x' } }] } } });
    expect(log.resets).toHaveLength(1);
    expect(labels(session.model)).toEqual(['Restored', 'x']);
  });

  it('only watches when it may not edit', () => {
    const { session, clock, hello, socket } = setup({ canEdit: false });
    hello();
    session.edit(model(), relabel(model(), 'a', 'Mine'));
    clock.advance(60);
    expect(socket().patches()).toHaveLength(0);
  });

  it('pings while connected and sends what is waiting before it stops', () => {
    const { session, clock, hello, socket } = setup();
    hello();
    clock.advance(25_000);
    expect(socket().sent.filter((m) => m.type === 'ping')).toHaveLength(1);
    session.edit(model(), relabel(model(), 'a', 'Last'));
    session.stop();
    expect(socket().patches()).toHaveLength(1);
    expect(socket().closedWith).toBe(1000);
  });

  it('passes saved messages on', () => {
    const { log, hello, socket } = setup();
    hello();
    socket().receive({ type: 'saved', seq: 1, versionId: 'v2', by: { id: 'u', name: 'Bob' }, at: 'now', dsl: 'flowchart TD' });
    expect(log.saved).toEqual([{ type: 'saved', seq: 1, versionId: 'v2', by: { id: 'u', name: 'Bob' }, at: 'now', dsl: 'flowchart TD' }]);
  });
});

describe('liveUrl', () => {
  it('uses the API address, or this page’s own origin when the API shares it', () => {
    expect(liveUrl('http://localhost:3000', 'd 1', { protocol: 'http:', host: 'x' })).toBe('ws://localhost:3000/diagrams/d%201/live');
    expect(liveUrl('https://api.example/', 'd', { protocol: 'http:', host: 'x' })).toBe('wss://api.example/diagrams/d/live');
    expect(liveUrl('', 'd', { protocol: 'https:', host: 'canvas.example' })).toBe('wss://canvas.example/diagrams/d/live');
  });
});
