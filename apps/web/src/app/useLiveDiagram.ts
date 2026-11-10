import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiagramModel } from '@canvas/diagram-core';
import { loadWebConfig } from '../config';
import {
  LiveSession,
  liveUrl,
  type LivePerson,
  type LiveReset,
  type LiveSaved,
  type LiveSocket,
  type LiveStatus,
} from './live-session';

const { apiBaseUrl } = loadWebConfig();

export interface LiveDiagramOptions {
  diagramId: string;
  /** False for an unsaved Create with AI draft: it exists only in this tab until its first save. */
  enabled: boolean;
  canEdit: boolean;
  /** The model the editor shows, and its state setter. */
  model: DiagramModel;
  setModel: (model: DiagramModel) => void;
  onHello: (baseVersionId: string) => void;
  onSaved: (saved: LiveSaved) => void;
  onReset: (reset: LiveReset) => void;
  onRejected: (message: string) => void;
}

export interface LiveDiagram {
  /** Use instead of the plain state setter for every edit: it shares the change with everyone else here. */
  setModel: (next: DiagramModel) => void;
  status: LiveStatus;
  statusReason?: string;
  people: LivePerson[];
  me: LivePerson | null;
  /** Sends any change still waiting (call before saving). */
  flush: () => void;
  /** Tells the others what this editor has selected. */
  select: (ids: string[]) => void;
}

/** canvas-vvi: the editor's live session (live-session.ts), opened while the diagram is open. */
export function useLiveDiagram(options: LiveDiagramOptions): LiveDiagram {
  const { diagramId, enabled, canEdit, model, setModel } = options;
  // The model the editor last drew. Every edit is a change from it, applied to the newest view: an edit made
  // before the next redraw (a second change in one event, or one that crossed someone else's) keeps the rest.
  const rendered = useRef(model);
  rendered.current = model;
  const callbacks = useRef(options);
  callbacks.current = options;
  const session = useRef<LiveSession | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [statusReason, setStatusReason] = useState<string | undefined>(undefined);
  const [people, setPeople] = useState<LivePerson[]>([]);
  const [me, setMe] = useState<LivePerson | null>(null);

  useEffect(() => {
    if (!enabled || typeof WebSocket === 'undefined') {
      setStatus('off');
      return;
    }
    const live = new LiveSession(
      rendered.current,
      callbacks.current.canEdit,
      () => new WebSocket(liveUrl(apiBaseUrl, diagramId, window.location)) as unknown as LiveSocket,
      {
        model: (next) => callbacks.current.setModel(next),
        hello: (base) => callbacks.current.onHello(base),
        saved: (saved) => callbacks.current.onSaved(saved),
        reset: (reset) => callbacks.current.onReset(reset),
        rejected: (message) => callbacks.current.onRejected(message),
        people: (list, mine) => {
          setPeople(list);
          setMe(mine);
        },
        status: (next, reason) => {
          setStatus(next);
          setStatusReason(reason);
        },
      },
    );
    session.current = live;
    live.start();
    return () => {
      live.stop();
      if (session.current === live) session.current = null;
      setPeople([]);
      setMe(null);
    };
  }, [diagramId, enabled]);

  useEffect(() => {
    session.current?.setCanEdit(canEdit);
  }, [canEdit]);

  const setLiveModel = useCallback(
    (next: DiagramModel) => {
      const live = session.current;
      if (!live) {
        setModel(next);
        return;
      }
      setModel(live.edit(rendered.current, next));
    },
    [setModel],
  );

  const flush = useCallback(() => session.current?.flush(), []);
  const select = useCallback((ids: string[]) => session.current?.select(ids), []);

  return { setModel: setLiveModel, status, statusReason, people, me, flush, select };
}
