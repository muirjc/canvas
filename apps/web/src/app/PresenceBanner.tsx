import type { OtherEditorDto } from './api';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function describe(others: OtherEditorDto[], watching: string[], live: boolean): string {
  const people = others.filter((o) => !o.isYou);
  const me = others.some((o) => o.isYou);
  const parts: string[] = [];
  const doing = live ? 'editing this diagram with you' : 'editing this diagram';
  if (people.length === 1) {
    parts.push(`${people[0].name} is also ${doing} (opened ${time(people[0].since)}).`);
  } else if (people.length > 1) {
    const names = people.map((p) => `${p.name} (opened ${time(p.since)})`);
    parts.push(
      `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are also ${doing}.`,
    );
  }
  if (watching.length === 1) parts.push(`${watching[0]} is watching.`);
  else if (watching.length > 1)
    parts.push(
      `${watching.slice(0, -1).join(', ')} and ${watching[watching.length - 1]} are watching.`,
    );
  if (me) parts.push('You have this diagram open in another tab too.');
  return parts.join(' ');
}

/**
 * canvas-obp0: who else has this diagram open in the editor. Advisory: editing stays enabled.
 * canvas-vvi: in a live session everyone's changes show as they're made, and anyone's Save saves for all;
 * without one (the fallback), a save that would replace someone else's newer one is stopped and explained
 * (SaveConflictDialog).
 */
export function PresenceBanner({
  others,
  watching = [],
  live = false,
}: {
  others: OtherEditorDto[];
  watching?: string[];
  live?: boolean;
}) {
  if (others.length === 0 && watching.length === 0) return null;
  const advice =
    others.some((o) => !o.isYou) && live
      ? ' Changes show up for everyone as they’re made, and anyone’s Save saves them for all.'
      : others.length > 0 && !live
        ? ' Save often: if they save first, you’ll be asked what to do with your changes.'
        : '';
  return (
    <div
      className="presence-banner"
      role="status"
      data-testid="presence-banner"
      data-live={live ? 'true' : 'false'}
    >
      <span aria-hidden="true" className="presence-banner__dot" />
      <span>
        {describe(others, watching, live)}
        {advice}
      </span>
    </div>
  );
}
