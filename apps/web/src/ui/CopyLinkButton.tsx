import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { locationToSearch, type Location } from '../app/navigation';

/** The full address of a screen, e.g. https://canvas.example.com/?diagramId=... */
export function absoluteUrlFor(to: Location): string {
  const search = locationToSearch(to);
  return `${window.location.origin}${window.location.pathname}${search === '?' ? '' : search}`;
}

/**
 * canvas-2h2w.5: copies a plain link to a diagram or project. Everyone signed in can read every
 * project and diagram, so the link works for any colleague who signs in. It grants nothing:
 * no access-granting or anonymous links (docs/sharing-design.md).
 */
export function CopyLinkButton({ to, testId, label = 'Copy link' }: { to: Location; testId: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absoluteUrlFor(to));
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <button type="button" className="btn btn--secondary btn--compact" data-testid={testId} data-url={absoluteUrlFor(to)} onClick={() => void copy()}>
      <Icon name="link" />
      <span aria-live="polite">{state === 'copied' ? 'Link copied' : state === 'failed' ? "Couldn't copy" : label}</span>
    </button>
  );
}
