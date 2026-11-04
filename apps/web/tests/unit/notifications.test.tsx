import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type NotificationDto } from '../../src/app/api';
import { notificationSentence, unreadBadgeText } from '../../src/notifications/notification-text';
import { NotificationsContext, useNotificationsState } from '../../src/notifications/NotificationsContext';
import { NotificationsBell } from '../../src/notifications/NotificationsBell';

const base: NotificationDto = {
  id: 'n1', kind: 'added', subjectType: 'project', subjectId: 'p1', subjectName: 'Payments',
  accessLevel: 'edit', previousLevel: null, actorName: 'Olive Owner', createdAt: new Date().toISOString(), read: false,
};

describe('notificationSentence', () => {
  it('words each kind', () => {
    expect(notificationSentence(base)).toBe('Olive Owner added you to Payments (Edit).');
    expect(notificationSentence({ ...base, subjectType: 'diagram', subjectName: 'Checkout flow', accessLevel: 'comment' })).toBe(
      'Olive Owner shared Checkout flow with you (Comment).',
    );
    expect(notificationSentence({ ...base, kind: 'level_changed', previousLevel: 'view' })).toBe(
      'Olive Owner changed your access to Payments from View to Edit.',
    );
    expect(notificationSentence({ ...base, kind: 'removed', accessLevel: null, previousLevel: 'edit' })).toBe('Olive Owner removed your access to Payments.');
    expect(notificationSentence({ ...base, kind: 'ownership', accessLevel: null, subjectName: 'Handover', actorName: 'Ada Admin' })).toBe(
      'Ada Admin made you the owner of Handover.',
    );
  });
  it('says Someone when the actor is unknown', () => {
    expect(notificationSentence({ ...base, actorName: null })).toBe('Someone added you to Payments (Edit).');
  });
});

describe('unreadBadgeText', () => {
  it('hides zero, shows counts and caps at 9+', () => {
    expect(unreadBadgeText(0)).toBeNull();
    expect(unreadBadgeText(3)).toBe('3');
    expect(unreadBadgeText(9)).toBe('9');
    expect(unreadBadgeText(10)).toBe('9+');
  });
});

function Harness() {
  const state = useNotificationsState(true);
  return (
    <NotificationsContext.Provider value={state}>
      <NotificationsBell />
    </NotificationsContext.Provider>
  );
}

describe('NotificationsBell', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the unread count, names it for screen readers, and lists items', async () => {
    vi.spyOn(api, 'listNotifications').mockResolvedValue({ notifications: [base, { ...base, id: 'n2', read: true }], unreadCount: 12 });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('notifications-unread-count').textContent).toBe('9+'));
    expect(screen.getByTestId('notifications-button').getAttribute('aria-label')).toBe('Notifications, 12 unread');
    await act(async () => {
      fireEvent.click(screen.getByTestId('notifications-button'));
    });
    const items = screen.getAllByTestId('notification-item');
    expect(items.map((i) => i.getAttribute('data-read'))).toEqual(['false', 'true']);
    expect(items[0].textContent).toContain('Olive Owner added you to Payments (Edit).');
  });

  it('keeps the last value when a background fetch fails', async () => {
    const spy = vi.spyOn(api, 'listNotifications').mockResolvedValueOnce({ notifications: [base], unreadCount: 1 });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('notifications-unread-count').textContent).toBe('1'));
    spy.mockRejectedValue(new Error('down'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByTestId('notifications-unread-count').textContent).toBe('1');
  });

  it('marks all read', async () => {
    vi.spyOn(api, 'listNotifications').mockResolvedValue({ notifications: [base], unreadCount: 1 });
    const mark = vi.spyOn(api, 'markNotificationsRead').mockResolvedValue({ unreadCount: 0 });
    render(<Harness />);
    await waitFor(() => screen.getByTestId('notifications-unread-count'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('notifications-button'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('notifications-mark-all-read'));
    });
    expect(mark).toHaveBeenCalledWith();
    expect(screen.queryByTestId('notifications-unread-count')).toBeNull();
  });
});
