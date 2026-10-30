import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../app/api';

export interface PickerUser {
  id: string;
  name: string;
  email: string;
}

export interface PersonPickerProps {
  /** The input's id (its <label htmlFor>). */
  inputId: string;
  /** Prefix for testids: `${p}-email`, `${p}-user-list`, `${p}-user-option-<id>`, `${p}-user-selected`. */
  testIdPrefix: string;
  /** The form around the picker: the list stays open while focus moves within it (e.g. to the
   *  submit button), so clicking that button doesn't move it out from under the click. */
  containerSelector: string;
  text: string;
  onTextChange: (text: string) => void;
  selected: PickerUser | null;
  onSelectedChange: (user: PickerUser | null) => void;
  /** Why a person can't be picked ("(you)", "has edit access"), or null if they can. */
  disabledReason: (userId: string) => string | null;
  /** Shown before the picked person's name ("Sharing with", "Adding"). */
  selectedVerb: string;
}

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Pick a colleague by name or email (canvas-cyt's share picker, shared by Share and Members since
 * canvas-2h2w.2): debounced server search from the first character, arrow keys + Enter, Escape
 * closes the list only. A full email typed without picking is left to the caller to look up.
 */
export function PersonPicker({
  inputId,
  testIdPrefix: p,
  containerSelector,
  text,
  onTextChange,
  selected,
  onSelectedChange,
  disabledReason,
  selectedVerb,
}: PersonPickerProps) {
  const [results, setResults] = useState<PickerUser[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionDomId = (userId: string) => `${uid}-opt-${userId}`;

  // Debounced server-side search from the first character; a sequence number discards stale replies.
  useEffect(() => {
    const q = text.trim();
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
  }, [text, selected]);

  const pickable = results.filter((u) => !disabledReason(u.id));
  const showList = open && text.trim() !== '' && !selected;

  const pick = (user: PickerUser) => {
    if (disabledReason(user.id)) return;
    onSelectedChange(user);
    onTextChange(user.name);
    setOpen(false);
    setActiveId(null);
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

  return (
    <div className="field combobox">
      <label className="field__label" htmlFor={inputId}>
        Person (name or email)
      </label>
      <input
        id={inputId}
        data-testid={`${p}-email`}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && activeId ? optionDomId(activeId) : undefined}
        autoComplete="off"
        type="text"
        value={text}
        onChange={(e) => {
          onTextChange(e.target.value);
          onSelectedChange(null);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        // Close only when focus leaves the whole form: closing as the submit button is pressed would
        // move it out from under the click (the list is in the page flow).
        onBlur={(e) => {
          if (!e.currentTarget.closest(containerSelector)?.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching people"
        data-testid={`${p}-user-list`}
        className="combobox__list"
        hidden={!showList}
        // Keep focus in the input while clicking an option.
        onMouseDown={(e) => e.preventDefault()}
      >
        {showList && searchState === 'loading' && <li role="presentation" className="combobox__status">Searching…</li>}
        {showList && searchState === 'error' && (
          <li role="presentation" className="combobox__status">Could not search users. You can still type a full email.</li>
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
                data-testid={`${p}-user-option-${user.id}`}
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
        <p className="share-selected" data-testid={`${p}-user-selected`}>
          <span>
            {selectedVerb} <strong>{selected.name}</strong> — {selected.email}
          </span>
          <button
            type="button"
            className="btn btn--tertiary btn--compact"
            onClick={() => {
              onSelectedChange(null);
              onTextChange('');
            }}
          >
            Clear
          </button>
        </p>
      )}
    </div>
  );
}
