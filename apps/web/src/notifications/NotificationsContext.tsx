import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type NotificationDto } from '../app/api';

export interface NotificationsState {
  notifications: NotificationDto[];
  unreadCount: number;
  /** Set when the last refresh a person asked for (opening the panel) failed. */
  loadFailed: boolean;
  /** Fetches now. `visible` marks a refresh the person asked for, so a failure is reported. */
  refresh: (visible?: boolean) => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const EMPTY: NotificationsState = {
  notifications: [],
  unreadCount: 0,
  loadFailed: false,
  refresh: async () => {},
  markRead: async () => {},
  markAllRead: async () => {},
};

export const NotificationsContext = createContext<NotificationsState>(EMPTY);

export const useNotifications = () => useContext(NotificationsContext);

export const POLL_INTERVAL_MS = 60_000;

/**
 * canvas-2h2w.4: the signed-in user's notifications, fetched on sign-in, every minute while the tab is
 * visible, and on window focus. Background failures keep the last value quietly.
 */
export function useNotificationsState(enabled: boolean): NotificationsState {
  const [notifications, setNotifications] = useState<NotificationDto[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (visible = false) => {
      if (!enabled) return;
      try {
        const result = await api.listNotifications();
        if (!alive.current) return;
        setNotifications(result.notifications);
        setUnreadCount(result.unreadCount);
        setLoadFailed(false);
      } catch {
        if (alive.current && visible) setLoadFailed(true);
      }
    },
    [enabled],
  );

  useEffect(() => {
    if (!enabled) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    void refresh();
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [enabled, refresh]);

  const markRead = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      // Optimistic: the badge drops at once; a failed call is put right by the next refresh.
      setNotifications((list) => list.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)));
      setUnreadCount((count) => Math.max(0, count - ids.length));
      try {
        const result = await api.markNotificationsRead(ids);
        if (alive.current) setUnreadCount(result.unreadCount);
      } catch {
        void refresh();
      }
    },
    [refresh],
  );

  const markAllRead = useCallback(async () => {
    setNotifications((list) => list.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      const result = await api.markNotificationsRead();
      if (alive.current) setUnreadCount(result.unreadCount);
    } catch {
      void refresh();
    }
  }, [refresh]);

  return useMemo(
    () => ({ notifications, unreadCount, loadFailed, refresh, markRead, markAllRead }),
    [notifications, unreadCount, loadFailed, refresh, markRead, markAllRead],
  );
}
