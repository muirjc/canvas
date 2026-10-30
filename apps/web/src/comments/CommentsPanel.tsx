import { useEffect, useRef, useState } from 'react';
import type { DiagramModel } from '@canvas/diagram-core';
import { accessAtLeast, api, ApiError, type AccessLevel, type CommentAnchor, type CommentDto, type CommentThreadDto } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';

export interface CommentsPanelProps {
  diagramId: string;
  threads: CommentThreadDto[];
  onThreadsChange: (threads: CommentThreadDto[]) => void;
  currentUser: { id: string; role: string };
  /** The diagram owner can delete anyone's comment. */
  ownerId?: string;
  /** The caller's access: view-only users can read but not comment or resolve. */
  accessLevel: AccessLevel;
  /** The current canvas model, to name pinned elements. */
  model: DiagramModel;
  /** Exactly one node/connector selected on the canvas, if any. */
  selection: CommentAnchor | null;
  /** A canvas pin was clicked: show and highlight that element's first open thread. */
  highlightRequest?: { anchorId: string; nonce: number };
  /** Server error from loading, shown above the list. */
  loadError?: string | null;
}

const relative = (iso: string) => {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (seconds < 60) return rtf.format(0, 'second');
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  return rtf.format(-Math.round(seconds / 86400), 'day');
};

const full = (iso: string) => new Date(iso).toLocaleString();

/** The Comments rail tab: threads (optionally pinned to a shape/connector), replies, resolve. */
export function CommentsPanel({ diagramId, threads, onThreadsChange, currentUser, ownerId, accessLevel, model, selection, highlightRequest, loadError }: CommentsPanelProps) {
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState('');
  const [pin, setPin] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const canComment = accessAtLeast(accessLevel, 'comment');
  const resolvedCount = threads.filter((t) => t.resolved).length;
  const shown = threads.filter((t) => showResolved || !t.resolved);
  const canPin = selection !== null;

  // Unpin when the selection goes away.
  useEffect(() => {
    if (!canPin) setPin(false);
  }, [canPin]);

  useEffect(() => {
    if (!highlightRequest) return;
    const target = threads.find((t) => !t.resolved && t.anchor?.id === highlightRequest.anchorId);
    if (!target) return;
    setHighlightId(target.id);
    requestAnimationFrame(() => document.getElementById(`comment-thread-el-${target.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    const timer = window.setTimeout(() => setHighlightId(null), 2500);
    return () => window.clearTimeout(timer);
    // Only a new pin click should re-trigger.
  }, [highlightRequest?.nonce]);

  const run = async (action: () => Promise<{ threads: CommentThreadDto[] }>): Promise<boolean> => {
    setError(null);
    setBusy(true);
    try {
      onThreadsChange((await action()).threads);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    const ok = await run(() =>
      api.addComment(diagramId, { body, ...(pin && selection ? { anchor: selection } : {}) }),
    );
    if (ok) {
      setDraft('');
      setPin(false);
      composerRef.current?.focus();
    }
  };

  const postReply = async (rootId: string) => {
    const body = replyDraft.trim();
    if (!body) return;
    const ok = await run(() => api.addComment(diagramId, { body, threadRootId: rootId }));
    if (ok) {
      setReplyDraft('');
      setReplyTo(null);
    }
  };

  const saveEdit = async (id: string) => {
    const body = editDraft.trim();
    if (!body) return;
    if (await run(() => api.editComment(diagramId, id, body))) setEditing(null);
  };

  const confirmDelete = async () => {
    const id = deleting;
    setDeleting(null);
    if (id) await run(() => api.deleteComment(diagramId, id));
  };

  const submitOnShortcut = (event: React.KeyboardEvent, action: () => void) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      action();
    }
  };

  const labelFor = (id: string): string | undefined =>
    model.nodes.find((n) => n.id === id)?.label ??
    model.edges.find((e) => e.id === id)?.label ??
    model.containers.find((c) => c.id === id)?.label ??
    undefined;
  const exists = (id: string) => model.nodes.some((n) => n.id === id) || model.edges.some((e) => e.id === id) || model.containers.some((c) => c.id === id);
  const kindName = (anchor: CommentAnchor) => (anchor.type === 'edge' ? 'connector' : anchor.type === 'container' ? 'group' : 'shape');
  const anchorName = (anchor: CommentAnchor) => labelFor(anchor.id) || `a ${kindName(anchor)}`;

  const pinLabel = (t: CommentThreadDto) => {
    if (!t.anchor) return null;
    if (!exists(t.anchor.id)) return `On a ${kindName(t.anchor)} that was removed`;
    return `On: ${anchorName(t.anchor)}`;
  };

  const canEditOrDelete = (c: CommentDto) => !c.deleted && c.author.id === currentUser.id;
  const canDelete = (c: CommentDto) => !c.deleted && (c.author.id === currentUser.id || currentUser.role === 'admin' || (!!ownerId && ownerId === currentUser.id));

  const renderComment = (c: CommentDto) => (
    <div key={c.id} data-testid={`comment-${c.id}`}>
      <p className="meta">
        <strong>{c.author.name}</strong>{' '}
        <time dateTime={c.createdAt} title={full(c.createdAt)}>
          {relative(c.createdAt)}
        </time>
        {c.editedAt && !c.deleted && <span> · Edited</span>}
      </p>
      {c.deleted ? (
        <p className="meta">
          <em>Comment deleted</em>
        </p>
      ) : editing === c.id ? (
        <div className="field">
          <label className="field__label visually-hidden" htmlFor={`comment-edit-input-${c.id}`}>
            Edit comment
          </label>
          <textarea
            id={`comment-edit-input-${c.id}`}
            data-testid={`comment-edit-input-${c.id}`}
            rows={3}
            maxLength={4000}
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => submitOnShortcut(e, () => void saveEdit(c.id))}
          />
          <span className="cluster">
            <button type="button" className="btn btn--primary btn--compact" data-testid={`comment-edit-save-${c.id}`} disabled={busy || !editDraft.trim()} onClick={() => void saveEdit(c.id)}>
              Save
            </button>
            <button type="button" className="btn btn--secondary btn--compact" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.body}</p>
      )}
      {editing !== c.id && (canEditOrDelete(c) || canDelete(c)) && (
        <span className="cluster cluster--tight">
          {canEditOrDelete(c) && (
            <button
              type="button"
              className="btn btn--secondary btn--compact"
              data-testid={`comment-edit-${c.id}`}
              onClick={() => {
                setEditing(c.id);
                setEditDraft(c.body);
              }}
            >
              Edit
            </button>
          )}
          {canDelete(c) && (
            <button type="button" className="btn btn--secondary btn--compact" data-testid={`comment-delete-${c.id}`} onClick={() => setDeleting(c.id)}>
              Delete
            </button>
          )}
        </span>
      )}
    </div>
  );

  return (
    <div className="panel" data-testid="comments-panel">
      <div className="panel__body stack">
        {loadError && (
          <p role="alert" data-testid="comments-error">
            {loadError}
          </p>
        )}
        {resolvedCount > 0 && (
          <label className="cluster" htmlFor="comments-show-resolved">
            <input id="comments-show-resolved" data-testid="comments-show-resolved" type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
            Show resolved ({resolvedCount})
          </label>
        )}
        {shown.length === 0 ? (
          <p className="state" data-testid="comments-empty">
            No comments yet. Start the conversation below.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }} className="stack">
            {shown.map((t) => (
              <li
                key={t.id}
                id={`comment-thread-el-${t.id}`}
                data-testid={`comment-thread-${t.id}`}
                className={`card comment-thread${highlightId === t.id ? ' comment-thread--highlight' : ''}${t.resolved ? ' comment-thread--resolved' : ''}`}
              >
                {pinLabel(t) && <p className="meta">{pinLabel(t)}</p>}
                {t.resolved && <p className="meta">Resolved</p>}
                {renderComment(t)}
                {t.replies.length > 0 && (
                  <div className="comment-replies stack">{t.replies.map((r) => renderComment(r))}</div>
                )}
                {!canComment ? null : replyTo === t.id ? (
                  <div className="field">
                    <label className="field__label" htmlFor={`comment-reply-input-${t.id}`}>
                      Your reply
                    </label>
                    <textarea
                      id={`comment-reply-input-${t.id}`}
                      data-testid={`comment-reply-input-${t.id}`}
                      rows={3}
                      maxLength={4000}
                      autoFocus
                      value={replyDraft}
                      onChange={(e) => setReplyDraft(e.target.value)}
                      onKeyDown={(e) => submitOnShortcut(e, () => void postReply(t.id))}
                    />
                    <span className="cluster">
                      <button type="button" className="btn btn--primary btn--compact" data-testid={`comment-reply-submit-${t.id}`} disabled={busy || !replyDraft.trim()} onClick={() => void postReply(t.id)}>
                        Reply
                      </button>
                      <button type="button" className="btn btn--secondary btn--compact" onClick={() => setReplyTo(null)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                ) : (
                  <span className="cluster cluster--tight">
                    <button
                      type="button"
                      className="btn btn--secondary btn--compact"
                      data-testid={`comment-reply-${t.id}`}
                      onClick={() => {
                        setReplyTo(t.id);
                        setReplyDraft('');
                      }}
                    >
                      Reply
                    </button>
                    {t.resolved ? (
                      <button type="button" className="btn btn--secondary btn--compact" data-testid={`comment-reopen-${t.id}`} disabled={busy} onClick={() => void run(() => api.reopenComment(diagramId, t.id))}>
                        Reopen
                      </button>
                    ) : (
                      <button type="button" className="btn btn--secondary btn--compact" data-testid={`comment-resolve-${t.id}`} disabled={busy} onClick={() => void run(() => api.resolveComment(diagramId, t.id))}>
                        Resolve
                      </button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!canComment ? (
        <p className="panel__footer meta" data-testid="comments-readonly">
          You can read comments but not add them.
        </p>
      ) : (
      <div className="panel__footer comment-composer">
        <div className="field">
          <label className="field__label" htmlFor="comment-new">
            Add a comment
          </label>
          <textarea
            id="comment-new"
            ref={composerRef}
            data-testid="comment-new"
            rows={3}
            maxLength={4000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => submitOnShortcut(e, () => void post())}
          />
        </div>
        <label className="cluster" htmlFor="comment-pin-selected">
          <input
            id="comment-pin-selected"
            data-testid="comment-pin-selected"
            type="checkbox"
            checked={pin}
            disabled={!canPin}
            aria-describedby={canPin ? undefined : 'comment-pin-hint'}
            onChange={(e) => setPin(e.target.checked)}
          />
          {selection ? `Pin to ${anchorName(selection)}` : 'Pin to the selected element'}
        </label>
        {/* canvas-eac: say why the pin is off -- a disabled checkbox alone read as broken. */}
        {!canPin && (
          <p id="comment-pin-hint" className="meta" data-testid="comment-pin-hint">
            To pin this comment, select one shape, connector or group on the canvas.
          </p>
        )}
        {error && (
          <p role="alert" className="field__error" data-testid="comments-error">
            {error}
          </p>
        )}
        <button type="button" className="btn btn--primary btn--compact" data-testid="comment-new-submit" disabled={busy || !draft.trim()} onClick={() => void post()}>
          Comment
        </button>
      </div>
      )}
      {deleting && (
        <ConfirmDialog
          message="Delete this comment? This can't be undone."
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
