import { useEffect, useState } from 'react';
import { api, type AccessLevel, type ShareGrantDto } from '../app/api';

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
    <div role="dialog" aria-label="Share diagram">
      <h3>Share this diagram</h3>
      <label>
        Email
        <input data-testid="share-email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
      </label>
      <select
        data-testid="share-access-level"
        aria-label="Access level to grant"
        value={accessLevel}
        onChange={(e) => setAccessLevel(e.target.value as AccessLevel)}
      >
        <option value="view">View</option>
        <option value="comment">Comment</option>
        <option value="edit">Edit</option>
      </select>
      <button type="button" data-testid="confirm-share" onClick={handleShare}>
        Share
      </button>
      <button type="button" data-testid="close-share-dialog" onClick={onClose}>
        Close
      </button>
      {error && (
        <p role="alert" data-testid="share-error">
          {error}
        </p>
      )}
      <ul data-testid="share-grants">
        {grants.map((grant) => (
          <li key={grant.id} data-testid={`share-grant-${grant.granteeUserId}`}>
            {grant.granteeUserId} — {grant.accessLevel}
            <button
              type="button"
              data-testid={`revoke-share-${grant.granteeUserId}`}
              onClick={() => api.revokeShare(grant.id).then(refresh)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
