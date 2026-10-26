import { useEffect, useId, useRef, useState } from 'react';
import { api, type AccessLevel, type ShareGrantDto } from '../app/api';
import { Modal } from '../ui/Modal';

export interface ShareDialogProps {
  diagramId: string;
  /** The signed-in user: shown as "(you)" and not pickable. */
  currentUserId: string;
  onClose: () => void;
}

interface PickerUser {
  id: string;
  name: string;
  email: string;
}

const SEARCH_DEBOUNCE_MS = 200;

/** Share a diagram at view/comment/edit access (FR-020) and manage/revoke existing grants. */
export function ShareDialog({ diagramId, currentUserId, onClose }: ShareDialogProps) {
  const [email, setEmail] = useState('');
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('view');
  const [grants, setGrants] = useState<ShareGrantDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<PickerUser | null>(null);
  const [results, setResults] = useState<PickerUser[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionDomId = (userId: string) => `${uid}-opt-${userId}`;

  const refresh = () => {
    api.listDiagramShares(diagramId).then(({ grants }) => setGrants(grants));
  };

  useEffect(refresh, [diagramId]);

  // Debounced server-side search from the first character; a sequence number discards stale replies.
  useEffect(() => {
    const q = email.trim();
    if (selected || q === '') {
      searchSeq.current += 1;
      setSearchState('idle');
      setResults([]);
      return;
    }
    const seq = ++searchSeq.current;
    setSearchState('loading');
    const timer = setTimeout(() => {
      api
        .searchUsers(q)
        .then(({ users }) => {
          if (seq !== searchSeq.current) return;
          setResults(users);
          setSearchState('done');
          setActiveId(null);
        })
        .catch(() => {
          if (seq !== searchSeq.current) return;
          setResults([]);
          setSearchState('error');
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [email, selected]);

  const grantFor = (userId: string) => grants.find((g) => g.granteeUserId === userId);
  // Already-shared users and the signed-in user are listed but not pickable: Share would only
  // duplicate or silently re-level a grant; to change a level, revoke and share again.
  const disabledReason = (userId: string): string | null =>
    userId === currentUserId ? '(you)' : grantFor(userId) ? `has ${grantFor(userId)!.accessLevel} access` : null;
  const pickable = results.filter((u) => !disabledReason(u.id));

  const showList = open && email.trim() !== '' && !selected;

  const pick = (user: PickerUser) => {
    if (disabledReason(user.id)) return;
    setSelected(user);
    setEmail(user.name);
    setOpen(false);
    setActiveId(null);
    setError(null);
  };

  const move = (delta: 1 | -1) => {
    if (pickable.length === 0) return;
    const idx = pickable.findIndex((u) => u.id === activeId);
    const next = idx === -1 ? (delta === 1 ? 0 : pickable.length - 1) : (idx + delta + pickable.length) % pickable.length;
    setActiveId(pickable[next].id);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      else move(-1);
    } else if (e.key === 'Enter' && showList && activeId) {
      e.preventDefault();
      const user = results.find((u) => u.id === activeId);
      if (user) pick(user);
    } else if (e.key === 'Escape' && showList) {
      // Close the list only; the native <dialog> must not treat this Escape as "close the dialog".
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setActiveId(null);
    }
  };

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
      setOpen(false);
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
        <div className="field combobox">
          <label className="field__label" htmlFor="share-email">
            Person (name or email)
          </label>
          <input
            id="share-email"
            data-testid="share-email"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && activeId ? optionDomId(activeId) : undefined}
            autoComplete="off"
            type="text"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setSelected(null);
              setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            // Close only when focus leaves the whole form: closing as Share is pressed would move the
            // button out from under the click (the list is in the page flow).
            onBlur={(e) => {
              if (!e.currentTarget.closest('.share-form')?.contains(e.relatedTarget as Node | null)) setOpen(false);
            }}
          />
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching people"
            data-testid="share-user-list"
            className="combobox__list"
            hidden={!showList}
            // Keep focus in the input while clicking an option.
            onMouseDown={(e) => e.preventDefault()}
          >
            {showList && searchState === 'loading' && <li role="presentation" className="combobox__status">Searching…</li>}
            {showList && searchState === 'error' && (
              <li role="presentation" className="combobox__status">Could not search users. You can still type a full email and press Share.</li>
            )}
            {showList && searchState === 'done' && results.length === 0 && (
              <li role="presentation" className="combobox__status">No matching active users</li>
            )}
            {showList &&
              searchState === 'done' &&
              results.map((user) => {
                const reason = disabledReason(user.id);
                return (
                  <li
                    key={user.id}
                    id={optionDomId(user.id)}
                    role="option"
                    aria-selected={activeId === user.id}
                    aria-disabled={reason ? true : undefined}
                    data-testid={`share-user-option-${user.id}`}
                    className={`combobox__option${activeId === user.id ? ' combobox__option--active' : ''}`}
                    onClick={() => pick(user)}
                  >
                    <span>
                      {user.name} — {user.email}
                    </span>
                    {reason && <span className="meta">{reason}</span>}
                  </li>
                );
              })}
          </ul>
          {selected && (
            <p className="share-selected" data-testid="share-user-selected">
              <span>
                Sharing with <strong>{selected.name}</strong> — {selected.email}
              </span>
              <button
                type="button"
                className="btn btn--tertiary btn--compact"
                onClick={() => {
                  setSelected(null);
                  setEmail('');
                }}
              >
                Clear
              </button>
            </p>
          )}
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
