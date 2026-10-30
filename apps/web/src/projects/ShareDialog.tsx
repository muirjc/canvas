import { useEffect, useState } from 'react';
import { HelpLink } from '../help/HelpLink';
import { api, type AccessLevel, type ShareGrantDto } from '../app/api';
import { Modal } from '../ui/Modal';
import { PersonPicker, type PickerUser } from './PersonPicker';

export interface ShareDialogProps {
  diagramId: string;
  /** The signed-in user: shown as "(you)" and not pickable. */
  currentUserId: string;
  onClose: () => void;
}

/** Share a diagram at view/comment/edit access (FR-020) and manage/revoke existing grants. */
export function ShareDialog({ diagramId, currentUserId, onClose }: ShareDialogProps) {
  const [email, setEmail] = useState('');
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('view');
  const [grants, setGrants] = useState<ShareGrantDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<PickerUser | null>(null);

  const refresh = () => {
    api.listDiagramShares(diagramId).then(({ grants }) => setGrants(grants));
  };

  useEffect(refresh, [diagramId]);

  const grantFor = (userId: string) => grants.find((g) => g.granteeUserId === userId);
  // Already-shared users and the signed-in user are listed but not pickable: Share would only
  // duplicate or silently re-level a grant; to change a level, revoke and share again.
  const disabledReason = (userId: string): string | null =>
    userId === currentUserId ? '(you)' : grantFor(userId) ? `has ${grantFor(userId)!.accessLevel} access` : null;

  const handleShare = async () => {
    setError(null);
    try {
      let userId = selected?.id;
      if (!userId) {
        // Fallback: a full email typed without picking (people the list doesn't show).
        const { user } = await api.lookupUserByEmail(email);
        if (!user) {
          setError(`No active user found with email ${email}`);
          return;
        }
        userId = user.id;
      }
      await api.createDiagramShare(diagramId, userId, accessLevel);
      setEmail('');
      setSelected(null);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal
      label="Share diagram"
      title={
        <span className="section-heading">
          Share this diagram <HelpLink page="user/sharing-and-exporting" section="sharing-a-single-diagram" topic="sharing a diagram" />
        </span>
      }
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--secondary" data-testid="close-share-dialog" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="share-form">
        <PersonPicker
          inputId="share-email"
          testIdPrefix="share"
          containerSelector=".share-form"
          text={email}
          onTextChange={(text) => {
            setEmail(text);
            setError(null);
          }}
          selected={selected}
          onSelectedChange={setSelected}
          disabledReason={disabledReason}
          selectedVerb="Sharing with"
        />
        <div className="field">
          <label className="field__label" htmlFor="share-access-level">
            Access
          </label>
          <select
            id="share-access-level"
            data-testid="share-access-level"
            aria-label="Access level to grant"
            value={accessLevel}
            onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}
          >
            <option value="view">View</option>
            <option value="comment">Comment</option>
            <option value="edit">Edit</option>
          </select>
        </div>
        <button type="button" className="btn btn--primary" data-testid="confirm-share" onClick={handleShare}>
          Share
        </button>
      </div>
      {error && (
        <p role="alert" data-testid="share-error">
          {error}
        </p>
      )}
      <ul className="share-grants" data-testid="share-grants">
        {grants.map((grant) => (
          <li key={grant.id} className="row" data-testid={`share-grant-${grant.granteeUserId}`}>
            <span className="row__main">
              <span className="row__title">
                {grant.granteeName || grant.granteeEmail
                  ? [grant.granteeName, grant.granteeEmail].filter(Boolean).join(' — ')
                  : grant.granteeUserId}
              </span>
              <span className="meta">{grant.accessLevel}</span>
            </span>
            <button
              type="button"
              className="btn btn--tertiary-danger btn--compact"
              data-testid={`revoke-share-${grant.granteeUserId}`}
              onClick={() => api.revokeShare(grant.id).then(refresh)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
