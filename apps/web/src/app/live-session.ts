import {
  applyPatch,
  applyPatches,
  diffModels,
  type DiagramModel,
  type ModelPatch,
} from '@canvas/diagram-core';

/**
 * canvas-vvi: one editor's side of a live editing session (docs/live-editing-design.md). Plain TypeScript, no
 * React, so it can be tested with a fake socket; useLiveDiagram wires it into the editor.
 *
 * The room on the server applies everyone's patches in one order. This side keeps:
 * - `confirmed`: the room's model as of the last message;
 * - `pending`: its own patches sent but not yet acknowledged;
 * - `unsent`: its own patches still waiting for the next send (a drag makes one per pointer move; they go out
 *   together, at most every FLUSH_MS);
 * - `view`: what the editor shows, always `confirmed` with `pending` and `unsent` on top.
 *
 * When someone else's patch arrives it goes onto `confirmed` and this editor's own changes are put back on top,
 * so every editor ends on the room's model. Edits made while disconnected are kept: when the connection comes
 * back, whatever differs from the last confirmed model is sent again on top of the room's.
 */

export interface LivePerson {
  connectionId: string;
  userId: string;
  name: string;
  canEdit: boolean;
  since: string;
}

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'off';

export interface LiveSaved {
  versionId: string;
  dsl: string;
  by: { id: string; name: string };
  at: string;
}

export interface LiveReset {
  model: DiagramModel;
  baseVersionId: string;
  by: { id: string; name: string };
  reason: 'restored' | 'saved-elsewhere';
}

export interface LiveEvents {
  /** The model the editor should show now. */
  model(model: DiagramModel): void;
  hello(baseVersionId: string): void;
  saved(saved: LiveSaved): void;
  reset(reset: LiveReset): void;
  people(people: LivePerson[], me: LivePerson | null): void;
  status(status: LiveStatus, reason?: string): void;
  rejected(message: string): void;
}

/** What LiveSession needs of a WebSocket. */
export interface LiveSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

export const FLUSH_MS = 50;
export const PING_MS = 25_000;
const OPEN = 1;
/** Close codes after which trying again can't help (docs/live-editing-design.md). */
const FINAL_CODES: Record<number, string> = {
  1008: 'not-allowed',
  4401: 'signed-out',
  4403: 'no-access',
  4404: 'gone',
};
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class LiveSession {
  private confirmed: DiagramModel;
  private pending: { id: number; patch: ModelPatch }[] = [];
  private unsent: ModelPatch[] = [];
  private view: DiagramModel;
  private socket: LiveSocket | null = null;
  private me: LivePerson | null = null;
  private nextPatchId = 1;
  private attempts = 0;
  private flushTimer: unknown = null;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;
  private stopped = false;
  private everLive = false;
  private canEdit: boolean;

  constructor(
    model: DiagramModel,
    canEdit: boolean,
    private readonly open: () => LiveSocket,
    private readonly events: LiveEvents,
    private readonly timers: Timers = browserTimers,
  ) {
    this.confirmed = model;
    this.view = model;
    this.canEdit = canEdit;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.flush();
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close(1000);
    }
  }

  /** The current view, for an editor that wants it. */
  get model(): DiagramModel {
    return this.view;
  }

  get live(): boolean {
    return this.me !== null && this.socket?.readyState === OPEN;
  }

  setCanEdit(canEdit: boolean): void {
    this.canEdit = canEdit;
  }

  /**
   * The editor changed `rendered` (the model it last drew) into `next`. Only what changed is applied, on top of
   * the latest view, so a change made from a model one remote update behind doesn't undo that update. Returns
   * the new view.
   */
  edit(rendered: DiagramModel, next: DiagramModel): DiagramModel {
    const patch = diffModels(rendered, next);
    if (!patch) return this.view;
    this.view = applyPatch(this.view, patch);
    if (this.live && this.canEdit) {
      this.unsent.push(patch);
      if (this.flushTimer === null)
        this.flushTimer = this.timers.setTimeout(() => this.flush(), FLUSH_MS);
    }
    return this.view;
  }

  /** Sends what's waiting now (before a save, so the room has it too). */
  flush(): void {
    if (this.flushTimer !== null) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.unsent.length === 0 || !this.live || !this.socket) return;
    const base = applyPatches(
      this.confirmed,
      this.pending.map((p) => p.patch),
    );
    const patch = diffModels(base, applyPatches(base, this.unsent));
    this.unsent = [];
    if (!patch) return;
    const id = this.nextPatchId++;
    this.pending.push({ id, patch });
    this.socket.send(JSON.stringify({ type: 'patch', clientPatchId: id, patch }));
  }

  private connect(): void {
    if (this.stopped) return;
    this.events.status(this.everLive ? 'reconnecting' : 'connecting');
    let socket: LiveSocket;
    try {
      socket = this.open();
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    let closedCode: number | null = null;
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === 'closed') closedCode = Number(message.code);
      this.receive(message);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.me = null;
      this.clearTimers();
      // Whatever was waiting stays in the view; the next hello sends it again.
      this.unsent = [];
      const code = closedCode ?? event.code;
      const final = FINAL_CODES[code];
      if (final) {
        this.stopped = true;
        this.events.status('off', final);
        return;
      }
      this.retry();
    };
  }

  private retry(): void {
    if (this.stopped) return;
    const delay = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)];
    this.attempts += 1;
    this.events.status(this.everLive ? 'reconnecting' : 'off', 'unreachable');
    this.retryTimer = this.timers.setTimeout(() => this.connect(), delay);
  }

  private ping(): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify({ type: 'ping' }));
    this.pingTimer = this.timers.setTimeout(() => this.ping(), PING_MS);
  }

  private clearTimers(): void {
    for (const timer of [this.flushTimer, this.pingTimer, this.retryTimer])
      if (timer !== null) this.timers.clearTimeout(timer);
    this.flushTimer = this.pingTimer = this.retryTimer = null;
  }

  private rebuild(): void {
    this.view = applyPatches(this.confirmed, [...this.pending.map((p) => p.patch), ...this.unsent]);
    this.events.model(this.view);
  }

  private receive(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'hello': {
        // Anything here that the room doesn't have yet -- edits made before connecting, or while the connection
        // was down -- goes again, on top of the room's model.
        const local = diffModels(this.confirmed, this.view);
        this.confirmed = message.model as DiagramModel;
        this.pending = [];
        this.unsent = [];
        this.me = message.you as LivePerson;
        this.canEdit = this.me.canEdit;
        this.attempts = 0;
        this.everLive = true;
        this.view = local ? applyPatch(this.confirmed, local) : this.confirmed;
        this.events.hello(message.baseVersionId as string);
        this.events.model(this.view);
        this.events.people(message.people as LivePerson[], this.me);
        this.events.status('live');
        if (local && this.canEdit) {
          this.unsent.push(local);
          this.flush();
        }
        this.pingTimer = this.timers.setTimeout(() => this.ping(), PING_MS);
        return;
      }
      case 'patch': {
        this.confirmed = applyPatch(this.confirmed, message.patch as ModelPatch);
        const mine = this.me && message.by === this.me.connectionId ? this.pending.findIndex((p) => p.id === message.clientPatchId) : -1;
        if (mine >= 0) {
          // Our own, back: it's in the view already.
          this.pending.splice(mine, 1);
          return;
        }
        this.rebuild();
        return;
      }
      case 'rejected': {
        this.pending = this.pending.filter((p) => p.id !== message.clientPatchId);
        this.rebuild();
        this.events.rejected(String(message.message ?? ''));
        return;
      }
      case 'saved':
        this.events.saved(message as unknown as LiveSaved);
        return;
      case 'reset': {
        this.confirmed = message.model as DiagramModel;
        this.pending = [];
        this.unsent = [];
        this.view = this.confirmed;
        this.events.model(this.view);
        this.events.reset(message as unknown as LiveReset);
        return;
      }
      case 'people': {
        const people = message.people as LivePerson[];
        const me =
          people.find((person) => person.connectionId === this.me?.connectionId) ?? this.me;
        if (me) {
          this.me = me;
          this.canEdit = me.canEdit;
        }
        this.events.people(people, me);
        return;
      }
      default:
        return;
    }
  }
}

/** The address of a diagram's live session, from the API's base URL ('' = this page's own origin). */
export function liveUrl(
  apiBaseUrl: string,
  diagramId: string,
  location: { protocol: string; host: string },
): string {
  const base = apiBaseUrl
    ? apiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  return `${base}/diagrams/${encodeURIComponent(diagramId)}/live`;
}
