import { useEffect, useState } from 'react';
import { api, type OtherEditorDto } from './api';

/** One id per browser tab, so the same person in two tabs shows up as "you, in another tab". */
// crypto.randomUUID needs a secure context (https or localhost), which Canvas always runs in.
const TAB_ID = crypto.randomUUID();
let mountCount = 0;

/**
 * canvas-obp0: while this editor is open (and the user can edit), tell the API every ~30s and hear
 * back who else has the diagram open. Polling, no websockets. Advisory only: nothing is blocked.
 * On leaving, the tab says goodbye; if it can't (crash, lost network) its entry expires.
 */
export function usePresence(diagramId: string, enabled: boolean): OtherEditorDto[] {
  const [others, setOthers] = useState<OtherEditorDto[]>([]);

  useEffect(() => {
    if (!enabled) {
      setOthers([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each mount has its own session ("<tab>.<n>"): the goodbye from an editor that just unmounted
    // (React remounts in development, quick navigation) must not delete the live mount's entry if
    // it arrives after the new heartbeat. The API ignores the same tab's other mounts.
    mountCount += 1;
    const sessionId = `${TAB_ID}.${mountCount}`;
    // The heartbeat request in flight, if any. Saying goodbye waits for it: a goodbye that overtook
    // it would be undone when it landed, leaving a stale "also editing" entry for up to 90s.
    let inFlight: Promise<unknown> = Promise.resolve();
    const beat = async () => {
      let next = 30;
      try {
        const request = api.presenceHeartbeat(diagramId, sessionId);
        inFlight = request.catch(() => undefined);
        const result = await request;
        if (cancelled) return;
        setOthers(result.others);
        next = result.heartbeatSeconds;
      } catch {
        // Presence is a nicety: a failed heartbeat just tries again next time.
      }
      if (!cancelled) timer = setTimeout(() => void beat(), next * 1000);
    };
    void beat();
    const sendLeave = () => api.presenceLeave(diagramId, sessionId).catch(() => undefined);
    // The page is going away: there's no time to wait, so say goodbye now (keepalive) and again
    // once any heartbeat in flight has landed, in case that request still reaches the API.
    const onPageHide = () => {
      void sendLeave();
      void inFlight.then(sendLeave);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('pagehide', onPageHide);
      void inFlight.then(sendLeave);
    };
  }, [diagramId, enabled]);

  return others;
}
