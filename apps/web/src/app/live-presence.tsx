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

/** canvas-vvi: one colour per person, from their user id, so they keep it everywhere. None is the canvas's own
 *  selection blue; each is dark enough for white text on a tag. */
export const PERSON_COLORS = ['#b45309', '#15803d', '#be185d', '#6d28d9', '#0e7490', '#b91c1c', '#4d7c0f', '#a21caf'];

export function personColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[hash % PERSON_COLORS.length];
}

export interface OtherSelection {
  /** The selected element's id. */
  id: string;
  name: string;
  color: string;
}

/** What everyone else in the session has selected: one entry per element and person (this tab left out). */
export function othersSelections(people: LivePerson[], me: LivePerson | null, currentUserId: string): OtherSelection[] {
  const result: OtherSelection[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    if (person.connectionId === me?.connectionId) continue;
    const name = person.userId === currentUserId ? 'You, in another tab' : person.name;
    for (const id of person.selection ?? []) {
      const key = `${person.userId}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ id, name, color: personColor(person.userId) });
    }
  }
  return result;
}
