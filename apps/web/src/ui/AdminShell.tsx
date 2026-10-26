import type { ReactNode } from 'react';

/** The ten admin destinations, in the order they appear in the navigation. `param` is the
 *  `?admin=` value that reaches each one (`?admin=true` is a legacy alias for `standards`). */
export const ADMIN_DESTINATIONS = [
  { id: 'overview', param: 'overview', label: 'Overview' },
  { id: 'standards', param: 'standards', label: 'Standards' },
  { id: 'users', param: 'users', label: 'Users' },
  { id: 'deleted', param: 'deleted', label: 'Deleted Diagrams' },
  { id: 'deleted-projects', param: 'deleted-projects', label: 'Deleted Projects' },
  { id: 'ai-personas', param: 'ai-personas', label: 'AI Personas' },
  { id: 'ai-usage', param: 'ai-usage', label: 'AI usage' },
  { id: 'libraries', param: 'libraries', label: 'Libraries' },
  { id: 'github', param: 'github', label: 'GitHub' },
  { id: 'audit', param: 'audit', label: 'Audit log' },
] as const;

export interface AdminShellProps {
  /** The `?admin=` value currently being viewed, used to mark the active destination. */
  activeParam: string;
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
export function AdminShell({ activeParam, children }: AdminShellProps) {
  // canvas-513: no Back link of its own -- the header's Projects link leaves the admin console,
  // the same way on every screen (it duplicated that, with an invisible "last location" target).
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin sections">
        <ul className="admin-nav__list">
          {ADMIN_DESTINATIONS.map((destination) => {
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
