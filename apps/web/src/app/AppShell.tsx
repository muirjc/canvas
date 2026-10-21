import { api, type SessionUser } from './api';
import { Icon } from '../ui/Icon';

export interface AppShellProps {
  user: SessionUser;
  onSignOut: () => void;
  /** canvas-t3b.4: which header link is the current section ('browse' at both Browse levels). */
  currentSection: 'browse' | 'admin' | null;
  /** The project list's address, and the in-app way to get there (App's guarded navigate()). */
  projectsHref: string;
  onNavigateProjects: () => void;
  children: React.ReactNode;
}

/**
 * Persistent header wrapping every authenticated view (FR-001: sign-out must be visible and
 * always-reachable). canvas-t3b.4 (docs/browse-screen-design.md §4): with no "current project"
 * the header no longer needs to know one -- it's the same on every screen: the wordmark, the
 * Projects and Admin sections, the user and Sign Out, plus a skip link past it all.
 */
export function AppShell({ user, onSignOut, currentSection, projectsHref, onNavigateProjects, children }: AppShellProps) {
  const handleSignOut = async () => {
    const result = await api.logout();
    if (result?.logoutUrl) {
      window.location.href = result.logoutUrl;
      return;
    }
    onSignOut();
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" data-testid="skip-to-main">
        Skip to main content
      </a>
      <header className="app-header">
        <span className="app-wordmark">
          <Icon name="diamond" />
          Canvas
        </span>
        <nav className="app-nav" aria-label="Primary">
          <a
            className="app-nav__link"
            href={projectsHref}
            data-testid="nav-projects"
            aria-current={currentSection === 'browse' ? 'page' : undefined}
            onClick={(event) => {
              // A plain click stays in-app (and through the unsaved-changes check); a modified
              // click opens the project list in a new tab as an ordinary link would.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onNavigateProjects();
            }}
          >
            Projects
          </a>
          {user.role === 'admin' && (
            <a
              className="app-nav__link"
              href="?admin=overview"
              data-testid="nav-admin"
              aria-current={currentSection === 'admin' ? 'page' : undefined}
            >
              Admin
            </a>
          )}
        </nav>
        <span className="cluster">
          <span className="meta">{user.email}</span>
          <button type="button" className="btn btn--secondary btn--compact" data-testid="sign-out" onClick={handleSignOut}>
            Sign Out
          </button>
        </span>
      </header>
      <div className="app-content" id="main-content" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
