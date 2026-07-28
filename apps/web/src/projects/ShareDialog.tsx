import { useEffect, useState } from 'react';
import { api, type AccessLevel, type ShareGrantDto } from '../app/api';
import { Modal } from '../ui/Modal';

export interface ShareDialogProps {
  diagramId: string;
  onClose: () => void;
}

/** Share a diagram at view/comment/edit access (FR-020) and manage/revoke existing grants. */
export function ShareDialog({ diagramId, onClose }: ShareDialogProps) {
  const [email, setEmail] = useState('');
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('view');
  const [grants, setGrants] = useState<ShareGrantDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    api.listDiagramShares(diagramId).then(({ grants }) => setGrants(grants));
  };

  useEffect(refresh, [diagramId]);

  const handleShare = async () => {
    setError(null);
    try {
      const { user } = await api.lookupUserByEmail(email);
      if (!user) {
        setError(`No active user found with email ${email}`);
        return;
      }
      await api.createDiagramShare(diagramId, user.id, accessLevel);
      setEmail('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal
      label="Share diagram"
      title="Share this diagram"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--secondary" data-testid="close-share-dialog" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="share-form">
        <div className="field">
          <label className="field__label" htmlFor="share-email">
            Email
          </label>
          <input
            id="share-email"
            data-testid="share-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
          />
        </div>
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
              <span className="row__title">{grant.granteeUserId}</span>
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
