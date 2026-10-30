import { useEffect, useState } from 'react';
import { api, type OtherEditorDto } from './api';

/** One id per browser tab, so the same person in two tabs shows up as "you, in another tab". */
const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;

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
    const beat = async () => {
      let next = 30;
      try {
        const result = await api.presenceHeartbeat(diagramId, TAB_ID);
        if (cancelled) return;
        setOthers(result.others);
        next = result.heartbeatSeconds;
      } catch {
        // Presence is a nicety: a failed heartbeat just tries again next time.
      }
      if (!cancelled) timer = setTimeout(() => void beat(), next * 1000);
    };
    void beat();
    const leave = () => void api.presenceLeave(diagramId, TAB_ID).catch(() => undefined);
    window.addEventListener('pagehide', leave);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [diagramId, enabled]);

  return others;
}
