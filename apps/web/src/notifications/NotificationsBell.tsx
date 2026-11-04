import { useEffect, useRef, useState } from 'react';
import type { NotificationDto } from '../app/api';
import { Icon } from '../ui/Icon';
import { InAppLink } from '../ui/InAppLink';
import type { Location } from '../app/navigation';
import { useNotifications } from './NotificationsContext';
import { notificationSentence, relativeTime, unreadBadgeText } from './notification-text';

function targetOf(n: NotificationDto): Location | null {
  if (n.kind === 'removed') return null;
  return n.subjectType === 'project' ? { screen: 'project', projectId: n.subjectId } : { screen: 'diagram', diagramId: n.subjectId };
}

/**
 * canvas-2h2w.4: the header's bell -- an unread badge and a panel listing the user's access notifications.
 * A plain disclosure (button + anchored panel), like the editor's Export menu: Escape or a click outside
 * closes it and focus goes back to the bell.
 */
export function NotificationsBell() {
  const { notifications, unreadCount, loadFailed, refresh, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void refresh(true);
    panelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, refresh]);

  const badge = unreadBadgeText(unreadCount);
  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  return (
    <div className="notifications" ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className="btn btn--tertiary btn--compact notifications__button"
        data-testid="notifications-button"
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" />
        {badge && (
          <span className="notifications__badge" data-testid="notifications-unread-count" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="notifications__panel" data-testid="notifications-panel" role="region" aria-label="Notifications" tabIndex={-1} ref={panelRef}>
          <div className="notifications__head">
            <h2 className="notifications__title">Notifications</h2>
            {unreadCount > 0 && (
              <button type="button" className="btn btn--tertiary btn--compact" data-testid="notifications-mark-all-read" onClick={() => void markAllRead()}>
                Mark all as read
              </button>
            )}
          </div>
          {loadFailed && (
            <p className="meta" role="status" data-testid="notifications-error">
              Couldn’t load notifications. Try again in a moment.
            </p>
          )}
          {notifications.length === 0 ? (
            !loadFailed && <p className="meta notifications__empty">Nothing yet. You’ll see here when someone shares a project or diagram with you.</p>
          ) : (
            <ul className="notifications__list">
              {notifications.map((n) => {
                const target = targetOf(n);
                const content = (
                  <>
                    <span className="notifications__text">{notificationSentence(n)}</span>
                    <span className="meta">{relativeTime(n.createdAt)}</span>
                  </>
                );
                const classes = `notifications__item${n.read ? '' : ' notifications__item--unread'}`;
                return (
                  <li key={n.id} data-testid="notification-item" data-read={n.read ? 'true' : 'false'}>
                    {target ? (
                      <InAppLink
                        to={target}
                        className={classes}
                        onClick={() => {
                          void markRead([n.id]);
                          setOpen(false);
                        }}
                      >
                        {content}
                      </InAppLink>
                    ) : (
                      <div className={classes}>{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
