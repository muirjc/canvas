import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../app/api';
import { Icon } from '../ui/Icon';
import type { PickerGroup } from './groups';

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
  selected: PickerUser | PickerGroup | null;
  onSelectedChange: (target: PickerUser | PickerGroup | null) => void;
  /** Why a person can't be picked ("(you)", "has edit access"), or null if they can. */
  disabledReason: (userId: string) => string | null;
  /** Shown before the picked person's name ("Sharing with", "Adding"). */
  selectedVerb: string;
  /** canvas-2h2w.3: also offer Entra groups (only when the deployment turned them on). */
  groupsEnabled?: boolean;
  /** Why a group can't be picked ("has edit access"), or null if it can. */
  groupDisabledReason?: (groupId: string) => string | null;
}

type Option = { key: string; target: PickerUser | PickerGroup };
const optionKey = (t: PickerUser | PickerGroup) => ('kind' in t ? `g:${t.id}` : `u:${t.id}`);

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
  groupsEnabled = false,
  groupDisabledReason = () => null,
}: PersonPickerProps) {
  const [results, setResults] = useState<PickerUser[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [groupsFailed, setGroupsFailed] = useState(false);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionDomId = (key: string) => `${uid}-opt-${key.replace(':', '-')}`;

  // Debounced server-side search from the first character; a sequence number discards stale replies.
  useEffect(() => {
    const q = text.trim();
    if (selected || q === '') {
      searchSeq.current += 1;
      setSearchState('idle');
      setResults([]);
      setGroups([]);
      setGroupsFailed(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearchState('loading');
    const timer = setTimeout(() => {
      // Groups are best effort: if Microsoft can't be reached the people still show.
      const groupSearch = groupsEnabled
        ? api
            .searchGroups(q)
            .then(({ groups }) => ({
              groups: groups.map((g): PickerGroup => ({
                kind: 'group',
                id: g.id,
                name: g.displayName,
              })),
              failed: false,
            }))
            .catch(() => ({ groups: [] as PickerGroup[], failed: true }))
        : Promise.resolve({ groups: [] as PickerGroup[], failed: false });
      Promise.all([api.searchUsers(q), groupSearch])
        .then(([{ users }, found]) => {
          if (seq !== searchSeq.current) return;
          setResults(users);
          setGroups(found.groups);
          setGroupsFailed(found.failed);
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
  }, [text, selected, groupsEnabled]);

  const options: Option[] = [...results, ...groups].map((target) => ({
    key: optionKey(target),
    target,
  }));
  const reasonFor = (t: PickerUser | PickerGroup) => ('kind' in t ? groupDisabledReason(t.id) : disabledReason(t.id));
  const pickable = options.filter((o) => !reasonFor(o.target));
  const showList = open && text.trim() !== '' && !selected;

  const pick = (target: PickerUser | PickerGroup) => {
    if (reasonFor(target)) return;
    onSelectedChange(target);
    onTextChange(target.name);
    setOpen(false);
    setActiveId(null);
  };

  const move = (delta: 1 | -1) => {
    if (pickable.length === 0) return;
    const idx = pickable.findIndex((o) => o.key === activeId);
    const next = idx === -1 ? (delta === 1 ? 0 : pickable.length - 1) : (idx + delta + pickable.length) % pickable.length;
    setActiveId(pickable[next].key);
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
      const option = options.find((o) => o.key === activeId);
      if (option) pick(option.target);
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
        {groupsEnabled ? 'Person (name or email) or group' : 'Person (name or email)'}
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
        aria-label={groupsEnabled ? 'Matching people and groups' : 'Matching people'}
        data-testid={`${p}-user-list`}
        className="combobox__list"
        hidden={!showList}
        // Keep focus in the input while clicking an option.
        onMouseDown={(e) => e.preventDefault()}
      >
        {showList && searchState === 'loading' && (
          <li role="presentation" className="combobox__status">
            Searching…
          </li>
        )}
        {showList && searchState === 'error' && (
          <li role="presentation" className="combobox__status">
            Could not search users. You can still type a full email.
          </li>
        )}
        {showList && searchState === 'done' && options.length === 0 && (
          <li role="presentation" className="combobox__status">
            {groupsEnabled ? 'No matching active users or groups' : 'No matching active users'}
          </li>
        )}
        {showList && searchState === 'done' && groupsFailed && (
          <li role="presentation" className="combobox__status" data-testid={`${p}-groups-error`}>
            Couldn&apos;t load groups from Microsoft.
          </li>
        )}
        {showList &&
          searchState === 'done' &&
          options.map(({ key, target }) => {
            const reason = reasonFor(target);
            const isGroup = 'kind' in target;
            return (
              <li
                key={key}
                id={optionDomId(key)}
                role="option"
                aria-selected={activeId === key}
                aria-disabled={reason ? true : undefined}
                data-testid={isGroup ? `${p}-group-option-${target.id}` : `${p}-user-option-${target.id}`}
                className={`combobox__option${activeId === key ? ' combobox__option--active' : ''}`}
                onClick={() => pick(target)}
              >
                {isGroup ? (
                  <span className="combobox__group">
                    <Icon name="users" />
                    {target.name} — Group
                  </span>
                ) : (
                  <span>
                    {target.name} — {target.email}
                  </span>
                )}
                {reason && <span className="meta">{reason}</span>}
              </li>
            );
          })}
      </ul>
      {selected && (
        <p className="share-selected" data-testid={`${p}-user-selected`}>
          <span>
            {selectedVerb} <strong>{selected.name}</strong> — {'kind' in selected ? 'Group' : selected.email}
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
