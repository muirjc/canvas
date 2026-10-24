import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SubmissionStatusDto } from './api';
import { shouldPoll } from './submission-state';

export const SUBMISSION_POLL_MS = 60_000;

export interface UseSubmission {
  status: SubmissionStatusDto | null;
  setStatus: (s: SubmissionStatusDto) => void;
  /** Re-read our own state (cheap, no GitHub call). */
  reload: () => Promise<void>;
  /** Ask the server to re-sync from GitHub (it throttles per pull request). */
  syncNow: () => Promise<void>;
  syncing: boolean;
}

/**
 * canvas-3s5.2: the diagram's submission status. Fetched on load and after each save; while a pull
 * request is open and the tab is visible it re-syncs from GitHub every 60s and when the tab
 * becomes visible again, and stops when the request is no longer open or the tab is hidden.
 */
export function useSubmission(diagramId: string, refreshToken: number): UseSubmission {
  const [status, setStatusState] = useState<SubmissionStatusDto | null>(null);
  const [syncing, setSyncing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await api.getSubmissionStatus(diagramId);
      if (alive.current) setStatusState(next);
    } catch {
      // Status is advisory; a failed read just leaves the controls hidden.
      if (alive.current) setStatusState(null);
    }
  }, [diagramId]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const next = await api.refreshSubmission(diagramId);
      if (alive.current) setStatusState(next);
    } catch {
      // A failed sync keeps the last known status; the server records its own sync errors.
    } finally {
      if (alive.current) setSyncing(false);
    }
  }, [diagramId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  const polling = shouldPoll(status);
  useEffect(() => {
    if (!polling) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      void syncNow();
      timer = setInterval(() => void syncNow(), SUBMISSION_POLL_MS);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [polling, syncNow]);

  return { status, setStatus: setStatusState, reload, syncNow, syncing };
}
