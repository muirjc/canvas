import { useEffect, useState } from 'react';
import { api, type UserRecordDto } from '../app/api';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

const ROLES = ['admin', 'architect', 'viewer'] as const;

type Dialog =
  | { kind: 'add' }
  | { kind: 'reset'; user: UserRecordDto }
  | { kind: 'reset-mfa'; user: UserRecordDto }
  | { kind: 'delete'; user: UserRecordDto }
  // The one-time password lives only in this state, only while the panel is open (canvas-ez1.2).
  | { kind: 'password'; name: string; password: string };

/** Admin console: assign/change user roles and active status (FR-022), and -- when Canvas manages
 *  passwords itself -- add users and reset their passwords (canvas-ez1.2). */
export function UsersPage() {
  const [users, setUsers] = useState<UserRecordDto[]>([]);
  const [localAuthEnabled, setLocalAuthEnabled] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [authMode, setAuthMode] = useState<'entra' | 'local'>('local');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.getAuthConfig().then((config) => {
      setLocalAuthEnabled(config.localAuthEnabled);
      setAuthMode(config.authMode);
    }).catch(() => setLocalAuthEnabled(false));
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
      {status && (
        <p role="status" data-testid="delete-user-status">
          {status}
        </p>
      )}
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Active</th>
            {localAuthEnabled && <th>Two-step</th>}
            {localAuthEnabled && (
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            )}
            <th>
              <span className="visually-hidden">Delete</span>
            </th>
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
                  <span className={user.mfaEnabled ? 'badge badge--success' : 'badge'} data-testid={`user-mfa-${user.id}`}>
                    {user.mfaEnabled ? 'On' : 'Off'}
                  </span>
                </td>
              )}
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
                  {user.mfaEnabled && user.id !== currentUserId && (
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary btn--compact"
                        data-testid={`reset-mfa-${user.id}`}
                        aria-label={`Reset two-step verification for ${user.name}`}
                        onClick={() => setDialog({ kind: 'reset-mfa', user })}
                      >
                        Reset MFA
                      </button>{' '}
                    </>
                  )}
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
              <td>
                {user.id !== currentUserId && (
                  <button
                    type="button"
                    className="btn btn--danger btn--compact"
                    data-testid={`delete-user-${user.id}`}
                    aria-label={`Delete ${user.name}`}
                    onClick={() => setDialog({ kind: 'delete', user })}
                  >
                    Delete
                  </button>
                )}
              </td>
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
      {dialog?.kind === 'reset-mfa' && (
        <ResetMfaDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onReset={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteUserDialog
          user={dialog.user}
          others={users.filter((u) => u.id !== dialog.user.id && u.active)}
          entra={authMode === 'entra'}
          onClose={() => setDialog(null)}
          onDeleted={(message) => {
            setDialog(null);
            setStatus(message);
            refresh();
          }}
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

function ResetMfaDialog({ user, onClose, onReset }: { user: UserRecordDto; onClose: () => void; onReset: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await api.resetUserMfa(user.id);
      onReset();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      role="alertdialog"
      label={`Reset two-step verification for ${user.name}`}
      testId="reset-mfa-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" data-testid="confirm-reset-mfa" disabled={submitting} onClick={confirm}>
            Reset MFA
          </button>
        </>
      }
    >
      <p>
        This removes two-step verification for {user.name} and signs them out. They will have to set it up again the next
        time they sign in.
      </p>
      {error && (
        <p role="alert" className="field__error">
          {error}
        </p>
      )}
    </Modal>
  );
}

function DeleteUserDialog({
  user,
  others,
  entra,
  onClose,
  onDeleted,
}: {
  user: UserRecordDto;
  others: UserRecordDto[];
  entra: boolean;
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const [impact, setImpact] = useState<{ ownedProjects: number; ownedDiagrams: number; sharesReceived: number; isLastActiveAdmin: boolean } | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .getUserDeletionImpact(user.id)
      .then(setImpact)
      .catch((err) => setError((err as Error).message));
  }, [user.id]);

  const ownsSomething = !!impact && (impact.ownedProjects > 0 || impact.ownedDiagrams > 0);
  const blocked = !impact || impact.isLastActiveAdmin || (ownsSomething && !transferTo);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const confirm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.deleteUser(user.id, ownsSomething ? transferTo : undefined);
      const target = others.find((u) => u.id === transferTo);
      onDeleted(
        `Deleted ${user.name}` +
          (target ? `; transferred ${plural(result.transferredProjects, 'project')} and ${plural(result.transferredDiagrams, 'diagram')} to ${target.name}.` : '.'),
      );
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      role="alertdialog"
      label={`Delete ${user.name}`}
      testId="delete-user-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" data-testid="confirm-delete-user" disabled={blocked || submitting} onClick={confirm}>
            Delete user
          </button>
        </>
      }
    >
      <div className="stack">
        {!impact && !error && <p>Checking what this affects…</p>}
        {impact?.isLastActiveAdmin && (
          <p role="alert" data-testid="delete-user-last-admin">
            {user.name} is the last active administrator and can't be deleted. Make someone else an administrator first.
          </p>
        )}
        {impact && !impact.isLastActiveAdmin && (
          <>
            <p>
              {user.name} owns {plural(impact.ownedProjects, 'project')} and {plural(impact.ownedDiagrams, 'diagram')}, and has{' '}
              {plural(impact.sharesReceived, 'share')} that will be removed.
            </p>
            {ownsSomething && (
              <div className="field">
                <label className="field__label" htmlFor="delete-user-transfer">
                  Transfer their projects and diagrams to
                </label>
                <select id="delete-user-transfer" data-testid="delete-user-transfer" required value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                  <option value="">Choose a user…</option>
                  {others.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p>
              Their password, two-step verification, personas and sessions are removed and they are signed out immediately. Their
              history stays and shows as "Deleted user". Their email can then be used by a new account. This can't be undone.
            </p>
            {entra && (
              <p className="meta">
                In Entra ID, anyone who still has the app role is re-created as a new user the next time they sign in. Remove their
                role in Entra too.
              </p>
            )}
            <p className="meta">To keep the account but stop it signing in, untick Active instead; that can be undone.</p>
          </>
        )}
        {error && (
          <p role="alert" className="field__error" data-testid="delete-user-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
