import { api, type SessionUser } from './api';

export interface AppShellProps {
  user: SessionUser;
  onSignOut: () => void;
  children: React.ReactNode;
}

/**
 * Persistent header wrapping every authenticated view (FR-001: sign-out must be visible and
 * always-reachable — this app has no other shared chrome, so without this wrapper sign-out
 * would need to be duplicated into each view and would be missed on some, as every view added
 * before this feature demonstrates).
 */
export function AppShell({ user, onSignOut, children }: AppShellProps) {
  const handleSignOut = async () => {
    await api.logout();
    onSignOut();
  };

  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 1rem' }}>
        <strong>Canvas</strong>
        <span>
          {user.email}
          <button type="button" data-testid="sign-out" onClick={handleSignOut} style={{ marginLeft: '1rem' }}>
            Sign Out
          </button>
        </span>
      </header>
      <div>{children}</div>
    </div>
  );
}
