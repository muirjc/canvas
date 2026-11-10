import type { OtherEditorDto } from './api';
import type { LivePerson, LiveStatus } from './live-session';

/**
 * canvas-vvi: who else is in a diagram's live session, for the presence banner. One entry per person (several
 * tabs count once, from the earliest); this tab itself is left out, and the signed-in user in another tab is
 * "you, in another tab".
 */
export function livePresence(
  people: LivePerson[],
  me: LivePerson | null,
  currentUserId: string,
): { editors: OtherEditorDto[]; watching: string[] } {
  const byUser = new Map<string, LivePerson & { anyEdit: boolean }>();
  for (const person of people) {
    if (person.connectionId === me?.connectionId) continue;
    const seen = byUser.get(person.userId);
    if (!seen) byUser.set(person.userId, { ...person, anyEdit: person.canEdit });
    else
      byUser.set(person.userId, {
        ...seen,
        since: seen.since < person.since ? seen.since : person.since,
        anyEdit: seen.anyEdit || person.canEdit,
      });
  }
  const editors: OtherEditorDto[] = [];
  const watching: string[] = [];
  for (const person of byUser.values()) {
    const isYou = person.userId === currentUserId;
    if (person.anyEdit || isYou)
      editors.push({ userId: person.userId, name: person.name, since: person.since, isYou });
    else watching.push(person.name);
  }
  return { editors, watching };
}

const NOTES: Partial<Record<string, string>> = {
  'signed-out':
    'You’ve been signed out, so live updates have stopped. Sign in again to see other people’s changes.',
  'no-access': 'You no longer have access to this diagram’s live updates.',
  gone: 'This diagram was deleted.',
  'not-allowed': 'Live updates aren’t available here.',
};

/** canvas-vvi: shown while live updates aren't reaching this editor. The editor still works on its own. */
export function LiveStatusNote({
  status,
  reason,
  enabled,
}: {
  status: LiveStatus;
  reason?: string;
  enabled: boolean;
}) {
  if (!enabled || status === 'live' || status === 'connecting') return null;
  const text =
    status === 'reconnecting'
      ? 'Reconnecting… Your changes are kept and shared once the connection is back.'
      : ((reason && NOTES[reason]) ??
        'Live updates aren’t connected, so other people’s changes won’t show for now. Canvas keeps trying.');
  return (
    <div
      className="presence-banner presence-banner--quiet"
      role="status"
      data-testid="live-status"
      data-state={status}
    >
      <span>{text}</span>
    </div>
  );
}
