import { locationToSearch } from '../app/navigation';

/**
 * canvas-fkp: a small "?" next to a feature that opens the matching Help section in a new tab --
 * a new tab so it never leaves (or risks unsaved work in) the screen the user is on.
 */
export function HelpLink({ page, section, topic }: { page: string; section?: string; topic: string }) {
  const href = locationToSearch({ screen: 'help', page, ...(section ? { section } : {}) });
  return (
    <a
      className="help-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Help: ${topic} (opens in a new tab)`}
      title={`Help: ${topic}`}
      data-testid={`help-link-${page.replace('/', '-')}${section ? `-${section}` : ''}`}
    >
      ?
    </a>
  );
}
