import type { OtherEditorDto } from './api';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function describe(others: OtherEditorDto[]): string {
  const people = others.filter((o) => !o.isYou);
  const me = others.some((o) => o.isYou);
  const parts: string[] = [];
  if (people.length === 1) {
    parts.push(`${people[0].name} is also editing this diagram (opened ${time(people[0].since)}).`);
  } else if (people.length > 1) {
    const names = people.map((p) => `${p.name} (opened ${time(p.since)})`);
    parts.push(`${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are also editing this diagram.`);
  }
  if (me) parts.push('You have this diagram open in another tab too.');
  return parts.join(' ');
}

/**
 * canvas-obp0: who else has this diagram open in the editor. Advisory: editing stays enabled, and
 * a save that would replace someone else's newer one is stopped and explained (SaveConflictDialog).
 */
export function PresenceBanner({ others }: { others: OtherEditorDto[] }) {
  if (others.length === 0) return null;
  return (
    <div className="presence-banner" role="status" data-testid="presence-banner">
      <span aria-hidden="true" className="presence-banner__dot" />
      <span>
        {describe(others)} Save often: if they save first, you&rsquo;ll be asked what to do with your changes.
      </span>
    </div>
  );
}
