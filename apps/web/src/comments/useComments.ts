import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CommentThreadDto } from '../app/api';

/** Loads a diagram's comment threads and unread count (kept in the editor so canvas pins and the
 *  tab badge work before the Comments tab is ever opened). */
/** How often to look for new comments while a diagram is open (and the browser tab visible). */
export const COMMENT_POLL_MS = 60_000;

export function useComments(diagramId: string, options: { tabActive?: boolean } = {}) {
  const [threads, setThreads] = useState<CommentThreadDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const tabActive = useRef(Boolean(options.tabActive));
  tabActive.current = Boolean(options.tabActive);

  // Others' new comments: re-fetch every minute while the page is visible, so pins, threads and
  // the badge catch up without a reload. With the Comments tab open they count as seen.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api
        .listComments(diagramId)
        .then((result) => {
          setThreads(result.threads);
          if (tabActive.current && result.unread > 0) {
            setUnread(0);
            api.markCommentsRead(diagramId).catch(() => undefined);
          } else {
            setUnread(result.unread);
          }
        })
        .catch(() => undefined);
    }, COMMENT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [diagramId]);

  useEffect(() => {
    let cancelled = false;
    api
      .listComments(diagramId)
      .then((result) => {
        if (cancelled) return;
        setThreads(result.threads);
        setUnread(result.unread);
      })
      .catch((err) => !cancelled && setLoadError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [diagramId]);

  const refreshUnread = useCallback(() => {
    api.getUnreadComments(diagramId).then((r) => setUnread(r.unread)).catch(() => undefined);
  }, [diagramId]);

  /** The user has the tab open: mark seen and zero the badge. */
  const markRead = useCallback(() => {
    setUnread(0);
    api.markCommentsRead(diagramId).catch(() => undefined);
  }, [diagramId]);

  return { threads, setThreads, unread, loadError, refreshUnread, markRead };
}
