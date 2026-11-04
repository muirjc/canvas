import type { AccessLevel, NotificationDto } from '../app/api';

const LEVEL_LABELS: Record<AccessLevel, string> = { view: 'View', comment: 'Comment', edit: 'Edit', manage: 'Manage' };

export const levelLabel = (level: AccessLevel | null): string => (level ? LEVEL_LABELS[level] : '');

/** canvas-2h2w.4: the one plain sentence a notification reads as. */
export function notificationSentence(n: NotificationDto): string {
  const who = n.actorName ?? 'Someone';
  switch (n.kind) {
    case 'added':
      return n.subjectType === 'project'
        ? `${who} added you to ${n.subjectName} (${levelLabel(n.accessLevel)}).`
        : `${who} shared ${n.subjectName} with you (${levelLabel(n.accessLevel)}).`;
    case 'level_changed':
      return `${who} changed your access to ${n.subjectName} from ${levelLabel(n.previousLevel)} to ${levelLabel(n.accessLevel)}.`;
    case 'removed':
      return `${who} removed your access to ${n.subjectName}.`;
    case 'ownership':
      return `${who} made you the owner of ${n.subjectName}.`;
  }
}

/** The badge text: nothing at 0, then the count, "9+" above nine. */
export function unreadBadgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}

/** A short relative time ("just now", "5 min ago", "3 h ago", "2 d ago"), then a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
