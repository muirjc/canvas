import { api, type SessionUser } from './api';
import { Icon } from '../ui/Icon';

export interface AppShellProps {
  user: SessionUser;
  onSignOut: () => void;
  /**
   * The project chooser (feature 007). It belongs in the shared header for the same reason
   * sign-out does: every view needs it. Putting it only on the home screen would mean the user
   * cannot tell which project they are in while editing (FR-008), and would make the
   * unsaved-changes warning unreachable — you cannot switch project from a screen that has no
   * switcher (FR-013d).
   */
  projectPicker?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Persistent header wrapping every authenticated view (FR-001: sign-out must be visible and
 * always-reachable — this app has no other shared chrome, so without this wrapper sign-out
 * would need to be duplicated into each view and would be missed on some, as every view added
 * before this feature demonstrates).
 */
export function AppShell({ user, onSignOut, projectPicker, children }: AppShellProps) {
  const handleSignOut = async () => {
    await api.logout();
    onSignOut();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-wordmark">
          <Icon name="diamond" />
          Canvas
        </span>
        <span className="cluster">
          {projectPicker}
          <span className="meta">{user.email}</span>
          <button type="button" className="btn btn--secondary btn--compact" data-testid="sign-out" onClick={handleSignOut}>
            Sign Out
          </button>
        </span>
      </header>
      <div className="app-content">{children}</div>
    </div>
  );
}
