import { useEffect, useState } from 'react';
import { api, type UserRecordDto } from '../app/api';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

const ROLES = ['admin', 'architect', 'viewer'] as const;

type Dialog =
  | { kind: 'add' }
  | { kind: 'reset'; user: UserRecordDto }
  // The one-time password lives only in this state, only while the panel is open (canvas-ez1.2).
  | { kind: 'password'; name: string; password: string };

/** Admin console: assign/change user roles and active status (FR-022), and -- when Canvas manages
 *  passwords itself -- add users and reset their passwords (canvas-ez1.2). */
export function UsersPage() {
  const [users, setUsers] = useState<UserRecordDto[]>([]);
  const [localAuthEnabled, setLocalAuthEnabled] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    api.getAuthConfig().then((config) => setLocalAuthEnabled(config.localAuthEnabled)).catch(() => setLocalAuthEnabled(false));
    api.me().then(({ user }) => setCurrentUserId(user.id)).catch(() => setCurrentUserId(null));
  }, []);

  const refresh = () => {
    api.listAdminUsers().then(({ users }) => setUsers(users));
  };

  useEffect(refresh, []);

  return (
    <div>
      {/* canvas-4pw: the page's <h1>, focused after an in-app navigation lands here. */}
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Users
      </h1>
      {localAuthEnabled && (
        <div className="home__actions" style={{ marginBlockEnd: 'var(--space-4)' }}>
          <button type="button" className="btn btn--primary" data-testid="users-add" onClick={() => setDialog({ kind: 'add' })}>
            <Icon name="plus" />
            Add user
          </button>
        </div>
      )}
      {localAuthEnabled && (
        <p className="meta">Accounts lock after 3 failed sign-in attempts. Unlock them here; resetting a password also unlocks.</p>
      )}
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Active</th>
            {localAuthEnabled && (
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} data-testid={`user-row-${user.id}`}>
              <td>
                {user.name}
                {user.locked && (
                  <>
                    {' '}
                    <span className="badge badge--warning" data-testid={`user-locked-${user.id}`}>
                      Locked
                    </span>
                  </>
                )}
              </td>
              <td>{user.email}</td>
              <td>
                <select
                  data-testid={`user-role-${user.id}`}
                  aria-label={`Role for ${user.name}`}
                  value={user.role}
                  onChange={(e) => api.updateAdminUser(user.id, { role: e.target.value }).then(refresh)}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  data-testid={`user-active-${user.id}`}
                  aria-label={`${user.name} is active`}
                  type="checkbox"
                  checked={user.active}
                  onChange={(e) => api.updateAdminUser(user.id, { active: e.target.checked }).then(refresh)}
                />
              </td>
              {localAuthEnabled && (
                <td>
                  <a
                    className="btn btn--secondary btn--compact"
                    data-testid={`view-activity-${user.id}`}
                    href={`?admin=audit&userId=${encodeURIComponent(user.id)}`}
                    aria-label={`View activity for ${user.name}`}
                  >
                    View activity
                  </a>{' '}
                  {user.locked && (
                    <button
                      type="button"
                      className="btn btn--primary btn--compact"
                      data-testid={`unlock-${user.id}`}
                      aria-label={`Unlock ${user.name}`}
                      onClick={() => api.unlockUser(user.id).then(refresh)}
                    >
                      Unlock
                    </button>
                  )}{' '}
                  {user.id !== currentUserId && (
                    <button
                      type="button"
                      className="btn btn--secondary btn--compact"
                      data-testid={`reset-password-${user.id}`}
                      aria-label={`Reset password for ${user.name}`}
                      onClick={() => setDialog({ kind: 'reset', user })}
                    >
                      Reset password
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {dialog?.kind === 'add' && (
        <AddUserDialog
          onClose={() => setDialog(null)}
          onCreated={(user, password) => {
            refresh();
            setDialog({ kind: 'password', name: user.name, password });
          }}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ResetPasswordDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onReset={(password) => setDialog({ kind: 'password', name: dialog.user.name, password })}
        />
      )}
      {dialog?.kind === 'password' && (
        <OneTimePasswordDialog name={dialog.name} password={dialog.password} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function AddUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (user: UserRecordDto, password: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('viewer');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { user, temporaryPassword } = await api.createUser({ email: email.trim(), name: name.trim(), role });
      onCreated(user, temporaryPassword);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      label="Add user"
      testId="add-user-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-user-form" className="btn btn--primary" data-testid="add-user-submit" disabled={submitting}>
            Add user
          </button>
        </>
      }
    >
      <form id="add-user-form" onSubmit={handleSubmit}>
        <div className="field">
          <label className="field__label" htmlFor="add-user-email">
            Email
          </label>
          <input id="add-user-email" data-testid="add-user-email" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="add-user-name">
            Name
          </label>
          <input id="add-user-name" data-testid="add-user-name" autoComplete="off" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="add-user-role">
            Role
          </label>
          <select id="add-user-role" data-testid="add-user-role" value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p role="alert" className="field__error" data-testid="add-user-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onReset,
}: {
  user: UserRecordDto;
  onClose: () => void;
  onReset: (password: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const { temporaryPassword } = await api.resetUserPassword(user.id);
      onReset(temporaryPassword);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      role="alertdialog"
      label={`Reset password for ${user.name}`}
      testId="reset-password-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" data-testid="confirm-reset-password" disabled={submitting} onClick={confirm}>
            Reset password
          </button>
        </>
      }
    >
      <p>
        This signs {user.name} out everywhere and gives them a new one-time password. They will choose their own password
        when they next sign in.
      </p>
      {error && (
        <p role="alert" className="field__error">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** Shows a one-time password exactly once. It is held only in this component's props/state and is
 *  never written to storage, the address or logs; closing the dialog unmounts it. */
function OneTimePasswordDialog({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <Modal
      label="One-time password"
      testId="one-time-password-dialog"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--primary" data-testid="one-time-password-done" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="stack">
        <p>
          Shown once — give it to {name}. They'll choose their own password when they first sign in.
        </p>
        <code className="one-time-password" data-testid="one-time-password">
          {password}
        </code>
        <div className="cluster">
          <button type="button" className="btn btn--secondary" data-testid="one-time-password-copy" onClick={copy}>
            Copy
          </button>
          <span role="status" className="meta">
            {copyState === 'copied' && 'Copied to clipboard.'}
            {copyState === 'failed' && 'Could not copy automatically — select the password and copy it.'}
          </span>
        </div>
      </div>
    </Modal>
  );
}
