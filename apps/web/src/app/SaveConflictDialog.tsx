import { useState } from 'react';
import { Modal } from '../ui/Modal';
import type { VersionConflictDto } from './api';

export interface SaveConflictDialogProps {
  conflict: VersionConflictDto;
  currentUserId: string;
  /** What's on this user's screen, so they can keep a copy before loading the other version. */
  myDsl: string;
  diagramName: string;
  onLoadTheirs: () => void;
  onSaveMine: () => void;
  onKeepEditing: () => void;
}

/**
 * canvas-obp0: someone saved a newer version while this user was editing, so their Save was
 * refused and nothing was written. Three ways on: load the newer version (copy or download your
 * own first), save yours anyway (theirs stays in History), or keep editing.
 */
export function SaveConflictDialog({ conflict, currentUserId, myDsl, diagramName, onLoadTheirs, onSaveMine, onKeepEditing }: SaveConflictDialogProps) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const byMe = conflict.savedBy.id === currentUserId;
  const who = byMe ? 'You' : conflict.savedBy.name;
  const when = new Date(conflict.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(myDsl);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  const downloadHref = `data:text/plain;charset=utf-8,${encodeURIComponent(myDsl)}`;
  const fileName = `${diagramName.replace(/[^\w.-]+/g, '-') || 'diagram'}-my-version.mmd`;

  return (
    <Modal
      label="Someone else saved this diagram"
      title={byMe ? 'You saved this diagram somewhere else' : 'Someone else saved this diagram'}
      role="alertdialog"
      testId="save-conflict"
      onClose={onKeepEditing}
      footer={
        <>
          <button type="button" className="btn btn--secondary" data-testid="save-conflict-keep-editing" onClick={onKeepEditing}>
            Keep editing
          </button>
          <button type="button" className="btn btn--secondary" data-testid="save-conflict-load" onClick={onLoadTheirs}>
            Load the newer version
          </button>
          <button type="button" className="btn btn--primary" data-testid="save-conflict-save-mine" onClick={onSaveMine}>
            Save mine anyway
          </button>
        </>
      }
    >
      <p data-testid="save-conflict-message">
        {who} saved a newer version at {when}{byMe ? ', in another tab or window' : ''} while you were editing. Your changes
        haven&rsquo;t been saved yet.
      </p>
      <ul>
        <li>
          <strong>Load the newer version</strong> replaces what&rsquo;s on your screen. Keep a copy of yours first if you
          want it.
        </li>
        <li>
          <strong>Save mine anyway</strong> saves your version on top. Theirs stays in History.
        </li>
      </ul>
      <p className="row">
        <button type="button" className="btn btn--tertiary btn--compact" data-testid="save-conflict-copy" onClick={() => void copy()}>
          Copy my version
        </button>
        <a className="btn btn--tertiary btn--compact" data-testid="save-conflict-download" href={downloadHref} download={fileName}>
          Download my version (.mmd)
        </a>
        {copied === 'yes' && <span className="meta" role="status">Copied.</span>}
        {copied === 'failed' && <span className="meta" role="status">Couldn&rsquo;t copy. Use Download instead.</span>}
      </p>
    </Modal>
  );
}
