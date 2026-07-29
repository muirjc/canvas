import type { ReactNode } from 'react';
import { Icon } from './Icon';

/** The five admin destinations, in the order they appear in the navigation. `param` is the
 *  `?admin=` value that reaches each one — "true" is the standards editor, for historical
 *  reasons predating the other destinations. */
const DESTINATIONS = [
  { id: 'overview', param: 'overview', label: 'Overview' },
  { id: 'standards', param: 'true', label: 'Standards' },
  { id: 'users', param: 'users', label: 'Users' },
  { id: 'deleted', param: 'deleted', label: 'Deleted Diagrams' },
  { id: 'ai-personas', param: 'ai-personas', label: 'AI Personas' },
] as const;

export interface AdminShellProps {
  /** The `?admin=` value currently being viewed, used to mark the active destination. */
  activeParam: string;
  /** Preserved on the "back to diagrams" link so the architect returns to the project they came
   *  from rather than a project-less screen. */
  projectId?: string | null;
  children: ReactNode;
}

/**
 * Chrome shared by every admin screen: a centred page container and persistent navigation.
 *
 * This exists because the five admin screens render bare markup with no page container of their
 * own — feature 005 scoped them to "inherit tokens, no bespoke layout", but they had no layout to
 * inherit, so they came out flush against the viewport edge. Wrapping at the routing site fixes
 * all five without editing any of them (research §10).
 *
 * The navigation sits beneath the global header rather than in a left sidebar, matching the
 * diagram editor's document-bar pattern and preserving horizontal width for the wide tables on
 * the Users, Standards, and Deleted Diagrams screens.
 */
export function AdminShell({ activeParam, projectId, children }: AdminShellProps) {
  const backHref = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '?';

  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin sections">
        <a className="admin-nav__back" data-testid="admin-back-to-diagrams" href={backHref}>
          <Icon name="chevron-right" className="admin-nav__back-icon" />
          Back to diagrams
        </a>
        <span className="admin-nav__divider" aria-hidden="true" />
        <ul className="admin-nav__list">
          {DESTINATIONS.map((destination) => {
            const isActive = destination.param === activeParam;
            return (
              <li key={destination.id}>
                <a
                  className="admin-nav__link"
                  data-testid={`admin-nav-${destination.id}`}
                  href={`?admin=${destination.param}`}
                  // Exposes the current destination to assistive technology, not by colour alone.
                  aria-current={isActive ? 'page' : undefined}
                >
                  {destination.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <main className="admin__page" data-testid="admin-shell">
        {children}
      </main>
    </div>
  );
}
