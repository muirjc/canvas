import { useCallback, useEffect, useState } from 'react';
import { HelpLink } from '../help/HelpLink';
import { accessAtLeast, api, ApiError, type AccessLevel, type ProjectMembersDto } from '../app/api';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { PersonPicker, type PickerUser } from './PersonPicker';

export interface MembersDialogProps {
  projectId: string;
  projectName: string;
  currentUser: { id: string; role: string };
  onClose: () => void;
  /** Ownership or the caller's own level changed: the shell reloads its project list. */
  onAccessChanged: () => void;
}

const LEVELS: { value: AccessLevel; label: string; hint: string }[] = [
  { value: 'view', label: 'View', hint: 'read (everyone signed in can already)' },
  { value: 'comment', label: 'Comment', hint: 'read and comment' },
  { value: 'edit', label: 'Edit', hint: 'change diagrams and add new ones' },
  { value: 'manage', label: 'Manage', hint: 'edit, and decide who else has access' },
];

const who = (name: string | null, email: string | null, fallback: string) =>
  name || email ? [name, email].filter(Boolean).join(' — ') : fallback;

/**
 * canvas-2h2w.2 (docs/sharing-design.md): a project's members. The owner, Manage members and admins
 * add people, change their level and remove them; the owner (or an admin) can hand the project
 * over. Everyone else sees the list read-only. Members see all the project's diagrams at their level.
 */
export function MembersDialog({ projectId, projectName, currentUser, onClose, onAccessChanged }: MembersDialogProps) {
  const [data, setData] = useState<(ProjectMembersDto & { yourAccess: AccessLevel }) | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<PickerUser | null>(null);
  const [level, setLevel] = useState<AccessLevel>('edit');
  const [busy, setBusy] = useState(false);
  const [transferTo, setTransferTo] = useState<{ userId: string; name: string } | null>(null);

  const refresh = useCallback(() => {
    api
      .getProjectMembers(projectId)
      .then((result) => {
        setData(result);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load the members."));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  const canManage = accessAtLeast(data?.yourAccess, 'manage');
  const canTransfer = data !== null && (data.owner.id === currentUser.id || currentUser.role === 'admin');
  const memberFor = (userId: string) => data?.members.find((m) => m.userId === userId);

  const disabledReason = (userId: string): string | null =>
    userId === data?.owner.id ? 'owner' : memberFor(userId) ? `already ${memberFor(userId)!.accessLevel}` : null;

  const run = async (action: () => Promise<unknown>, afterwards?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      afterwards?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      let userId = selected?.id;
      if (!userId) {
        const { user } = await api.lookupUserByEmail(text.trim());
        if (!user) throw new Error(`No active user found with email ${text.trim()}`);
        userId = user.id;
      }
      if (disabledReason(userId)) throw new Error(`${text.trim()} is ${disabledReason(userId)}. Change their level in the list instead.`);
      await api.setProjectMember(projectId, userId, level);
      setText('');
      setSelected(null);
    });

  return (
    <Modal
      label={`Members of ${projectName}`}
      title={
        <span className="section-heading">
          Members of {projectName} <HelpLink page="user/sharing-and-exporting" section="project-members" topic="project members" />
        </span>
      }
      wide
      testId="members-dialog"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--secondary" data-testid="members-close" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="meta">
        Everyone signed in can read this project. Members get more: Comment, Edit or Manage.
        {!canManage && data && ' Only the owner or someone with Manage can change who is a member.'}
      </p>

      {loadError && (
        <p role="alert" data-testid="members-load-error">
          {loadError}
        </p>
      )}

      {canManage && (
        <form
          className="share-form members-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) void add();
          }}
        >
          <PersonPicker
            inputId="member-email"
            testIdPrefix="member"
            containerSelector=".members-form"
            text={text}
            onTextChange={(value) => {
              setText(value);
              setError(null);
            }}
            selected={selected}
            onSelectedChange={setSelected}
            disabledReason={disabledReason}
            selectedVerb="Adding"
          />
          <div className="field">
            <label className="field__label" htmlFor="member-level">
              Access
            </label>
            <select id="member-level" data-testid="member-level" value={level} onChange={(e) => setLevel(e.target.value as AccessLevel)}>
              {LEVELS.filter((l) => l.value !== 'view').map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}: {l.hint}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn--primary" data-testid="member-add" disabled={busy || !text.trim()}>
            Add
          </button>
        </form>
      )}

      {error && (
        <p role="alert" data-testid="members-error">
          {error}
        </p>
      )}

      {data && (
        <ul className="share-grants" data-testid="members-list">
          <li className="row" data-testid="member-owner">
            <span className="row__main">
              <span className="row__title">
                {who(data.owner.name, data.owner.email, data.owner.id)}
                {data.owner.id === currentUser.id && ' (you)'}
              </span>
              <span className="meta">Owner</span>
            </span>
          </li>
          {data.members.map((member) => {
            const name = who(member.name, member.email, member.userId);
            return (
              <li key={member.grantId} className="row" data-testid={`member-${member.userId}`}>
                <span className="row__main">
                  <span className="row__title">
                    {name}
                    {member.userId === currentUser.id && ' (you)'}
                  </span>
                  {!canManage && <span className="meta">{LEVELS.find((l) => l.value === member.accessLevel)?.label}</span>}
                </span>
                {canManage && (
                  <span className="row__actions">
                    <select
                      aria-label={`Access for ${name}`}
                      data-testid={`member-level-${member.userId}`}
                      value={member.accessLevel}
                      disabled={busy}
                      onChange={(e) =>
                        void run(() => api.setProjectMember(projectId, member.userId, e.target.value as AccessLevel), member.userId === currentUser.id ? onAccessChanged : undefined)
                      }
                    >
                      {LEVELS.map((l) => (
                        <option key={l.value} value={l.value}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    {canTransfer && (
                      <button
                        type="button"
                        className="btn btn--tertiary btn--compact"
                        data-testid={`member-make-owner-${member.userId}`}
                        disabled={busy}
                        onClick={() => setTransferTo({ userId: member.userId, name })}
                      >
                        Make owner
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--tertiary-danger btn--compact"
                      data-testid={`member-remove-${member.userId}`}
                      aria-label={`Remove ${name}`}
                      disabled={busy}
                      onClick={() => void run(() => api.revokeShare(member.grantId), member.userId === currentUser.id ? onAccessChanged : undefined)}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {transferTo && (
        <ConfirmDialog
          message={`Make ${transferTo.name} the owner of "${projectName}"? You stay on as a member with Manage access.`}
          onConfirm={() => {
            const target = transferTo;
            setTransferTo(null);
            void run(() => api.transferProjectOwnership(projectId, target.userId), onAccessChanged);
          }}
          onCancel={() => setTransferTo(null)}
        />
      )}
    </Modal>
  );
}
