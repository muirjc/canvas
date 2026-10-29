import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { createEmptyDiagramModel, getDslFamily, isParseSuccess, type DiagramModel } from '@canvas/diagram-core';
import { Canvas } from '../canvas/Canvas';
import { DslPanel } from '../canvas/DslPanel';
import { ExportMenu } from '../canvas/ExportMenu';
import { ViolationsPanel } from '../canvas/ViolationsPanel';
import { useDslSync } from '../canvas/useDslSync';
import { CommentsPanel } from '../comments/CommentsPanel';
import { useComments } from '../comments/useComments';
import { ChatPanel } from '../ai/ChatPanel';
import { Palette } from '../palette/Palette';
import { VersionHistory } from '../projects/VersionHistory';
import { ShareDialog } from '../projects/ShareDialog';
import { api, ApiError, type CommentAnchor, type DiagramDto, type DiagramVersionDetailDto, type DiagramVersionDto, type IconDto } from './api';
import { SubmitForApproval } from './SubmitForApproval';
import { ApprovalPanel } from './ApprovalPanel';
import { useSubmission } from './useSubmission';
import { isApprovalTabVisible } from './submission-state';
import { Icon } from '../ui/Icon';
import { RailTabs } from '../ui/RailTabs';
import { Modal } from '../ui/Modal';
import { useActiveStandard, useLiveViolations } from '../standards/useStandard';

let iconNodeCounter = 0;
function nextIconNodeId(): string {
  iconNodeCounter += 1;
  return `icon${Date.now().toString(36)}${iconNodeCounter}`;
}

export interface DiagramEditorProps {
  diagram: DiagramDto;
  /** Navigates back out of the editor (App's navigate() owns the unsaved-changes guard).
   *  Optional only so DiagramEditor stays usable without a shell around it. */
  onRequestClose?: () => void;
  /** canvas-t3b.2: where the back button goes, as its label -- the diagram's project name, or
   *  "Projects" (docs/browse-screen-design.md §7). Required (canvas-hmm: the old "Diagrams"
   *  default named a screen that no longer exists). */
  backLabel: string;
  /** canvas-ltm: which side-rail tab opens first -- 'chat' right after Create with AI when the AI
   *  asked follow-up questions, so that exchange is in view. Defaults to the DSL tab. */
  initialRailTab?: 'dsl' | 'chat';
  /** The signed-in user, for comment edit/delete permissions. */
  currentUser: { id: string; role: string };
}

/**
 * canvas-eow: exposed via ref rather than a callback-into-parent-state prop, so the shell (App)
 * can read whether there are unsaved edits *synchronously, at the moment of a project switch* —
 * a callback mirrored into a parent `useState` would only land on the parent's NEXT render (one
 * commit after this component's own DOM update), which a test's next action can easily outrace
 * under CI load. `hasUnsavedChanges` here is a plain getter closing over each render's current
 * derived value — no propagation delay, since there is no second copy of the state to propagate.
 */
export interface DiagramEditorHandle {
  hasUnsavedChanges: () => boolean;
}

function initialModelFromDsl(diagram: DiagramDto): DiagramModel {
  // Parsing here reuses the exact same diagram-core parser the server validated with, so the
  // canvas and the stored DSL start out guaranteed consistent.
  const family = getDslFamily(diagram.dslFamily);
  if (!family) return createEmptyDiagramModel(diagram.diagramTypeId);
  const result = family.parse(diagram.dslContent);
  return isParseSuccess(result) ? result.model : createEmptyDiagramModel(diagram.diagramTypeId);
}

export const DiagramEditor = forwardRef<DiagramEditorHandle, DiagramEditorProps>(function DiagramEditor(
  { diagram: initialDiagram, onRequestClose, backLabel, initialRailTab = 'dsl', currentUser },
  ref,
) {
  const [diagram, setDiagram] = useState(initialDiagram);
  const [model, setModel] = useState<DiagramModel>(() => initialModelFromDsl(diagram));
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // The server's result of the last save -- shown until the standard has loaded, then superseded
  // by the live check below (the server stays the authority for what gets stored).
  const [violations, setViolations] = useState(diagram.lastValidationResult);
  // canvas-tfr: the diagram type's active standard drives the canvas tools, the DSL panel's
  // live check and the Issues tab. Re-fetched if a save reports a different standard version.
  const [standardRefreshKey, setStandardRefreshKey] = useState(0);
  const standard = useActiveStandard(diagram.diagramTypeId, standardRefreshKey);
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | undefined>(undefined);
  // canvas-bw4: comments live outside the DSL; threads load up front so pins and the badge work.
  const [commentsTabActive, setCommentsTabActive] = useState(false);
  const comments = useComments(diagram.id, { tabActive: commentsTabActive });
  const [selection, setSelection] = useState<CommentAnchor | null>(null);
  const [commentsTabRequest, setCommentsTabRequest] = useState<{ id: string; nonce: number } | undefined>(undefined);
  const [pinHighlight, setPinHighlight] = useState<{ anchorId: string; nonce: number } | undefined>(undefined);
  const commentPins: Record<string, number> = {};
  for (const t of comments.threads) {
    if (t.anchor && !t.resolved) commentPins[t.anchor.id] = (commentPins[t.anchor.id] ?? 0) + 1;
  }
  const [versionRefreshToken, setVersionRefreshToken] = useState(0);
  const submission = useSubmission(diagram.id, versionRefreshToken);
  const [sharing, setSharing] = useState(false);
  // canvas-8x1: click-to-edit, mirroring ProjectsPage.tsx's own rename pattern for a project row —
  // same commit-on-Enter/blur, cancel-on-Escape shape, just scoped to this one diagram's title.
  const [editingName, setEditingName] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // canvas-hbk: Diagram Details dialog — owner/created-date display plus an editable description.
  // The description textarea follows the same controlled-draft + explicit-Save pattern as
  // PersonaAdminPage.tsx's prompt editor (canvas-ddx): `descriptionDraft` is null until the user
  // actually types, falling back to diagram.description otherwise, so dirty state is a plain
  // comparison with no separate reset needed after a successful save.
  const [showDetails, setShowDetails] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionSaved, setDescriptionSaved] = useState(false);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  // State rather than a ref: the portal target must trigger a re-render once it is attached,
  // otherwise Canvas renders its toolbar in place on the first pass and never moves it.
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const { dsl, parseErrors, applyDsl } = useDslSync(model, setModel, diagram.dslFamily);
  const liveViolations = useLiveViolations(model, standard?.rules);
  const shownViolations = liveViolations ?? violations;

  // Unsaved-change detection (feature 007, FR-013d). `saveStatus` above is REQUEST state — it
  // never becomes "dirty" when the model changes — so there was previously no way to answer
  // "would switching project lose this user's work".
  //
  // The baseline is the first SERIALIZED dsl, not `diagram.dslContent`. Parsing and re-serializing
  // can normalise whitespace and ordering, so comparing against the stored text would report every
  // freshly opened diagram as dirty and nag on every switch. Comparing serialized to serialized
  // reports only real edits.
  const initialDslRef = useRef<string | null>(null);
  if (initialDslRef.current === null) initialDslRef.current = dsl;
  const [lastSavedDsl, setLastSavedDsl] = useState<string | null>(null);
  const hasUnsavedChanges = dsl !== (lastSavedDsl ?? initialDslRef.current);

  useImperativeHandle(ref, () => ({ hasUnsavedChanges: () => hasUnsavedChanges }), [hasUnsavedChanges]);

  // canvas-3fha: an earlier version shown read-only on the canvas (History -> View). The editor's own
  // model -- including unsaved edits -- is left untouched while previewing.
  const [preview, setPreview] = useState<{ version: DiagramVersionDetailDto; model: DiagramModel; dsl: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [restoreStep, setRestoreStep] = useState<'confirm' | 'unsaved' | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const canEdit = (diagram.accessLevel ?? 'edit') === 'edit';

  const openPreview = async (version: DiagramVersionDto) => {
    setPreviewError(null);
    try {
      const { version: detail } = await api.getDiagramVersion(diagram.id, version.id);
      const family = getDslFamily(diagram.dslFamily);
      const parsed = family?.parse(detail.dslContent);
      const previewModel = parsed && isParseSuccess(parsed) ? parsed.model : createEmptyDiagramModel(diagram.diagramTypeId);
      setPreview({ version: detail, model: previewModel, dsl: detail.dslContent });
    } catch {
      setPreviewError(`Couldn't open v${version.sequenceNumber}. Try again.`);
    }
  };

  const closePreview = () => {
    setPreview(null);
    setRestoreStep(null);
    setRestoreError(null);
  };

  const requestRestore = () => {
    setRestoreError(null);
    setRestoreStep(hasUnsavedChanges ? 'unsaved' : 'confirm');
  };

  const restorePreviewed = async (saveFirst: boolean) => {
    if (!preview) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      if (saveFirst && !(await handleSave())) {
        setRestoreError("Couldn't save your changes, so nothing was restored.");
        return;
      }
      await api.restoreDiagramVersion(diagram.id, preview.version.id);
      await handleRestored();
      setVersionRefreshToken((t) => t + 1);
      closePreview();
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : "Couldn't restore this version.");
    } finally {
      setRestoring(false);
    }
  };

  const handleRestored = async () => {
    const { diagram: restored } = await api.getDiagram(diagram.id);
    setDiagram(restored);
    setModel(initialModelFromDsl(restored));
    setViolations(restored.lastValidationResult);
    setLastSavedDsl(null);
    initialDslRef.current = null;
  };

  const handleSelectIcon = (icon: IconDto) => {
    const index = model.nodes.length;
    setModel({
      ...model,
      nodes: [
        ...model.nodes,
        {
          id: nextIconNodeId(),
          label: icon.displayName,
          shape: 'icon',
          position: { x: 40 + (index % 5) * 160, y: 40 + Math.floor(index / 5) * 120 },
          icon: { libraryId: icon.libraryId, libraryVersion: icon.libraryVersion, iconId: icon.id },
        },
      ],
    });
  };

  const commitRename = async (newName: string) => {
    if (!newName.trim() || newName === diagram.name) {
      setEditingName(false);
      return;
    }
    setRenameError(null);
    try {
      const { diagram: renamed } = await api.renameDiagram(diagram.id, newName);
      setDiagram(renamed);
      setEditingName(false);
    } catch (err) {
      setRenameError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const descriptionValue = descriptionDraft ?? diagram.description ?? '';
  const descriptionDirty = descriptionValue !== (diagram.description ?? '');

  const handleSaveDescription = async () => {
    setSavingDescription(true);
    setDescriptionError(null);
    try {
      const { diagram: updated } = await api.updateDiagramDescription(diagram.id, descriptionValue);
      setDiagram(updated);
      setDescriptionDraft(null);
      setDescriptionSaved(true);
    } catch (err) {
      setDescriptionError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSavingDescription(false);
    }
  };

  const handleSave = async (): Promise<boolean> => {
    setSaveStatus('saving');
    try {
      const { diagram: saved } = await api.saveDiagram(diagram.id, dsl);
      setViolations(saved.lastValidationResult);
      // The server checked against a different standard than the one loaded here (published or
      // retired since this editor opened): pick up the current one so live checks agree again.
      if ((saved.standardVersionAtLastCheck ?? null) !== (standard?.version ?? null)) setStandardRefreshKey((k) => k + 1);
      setVersionRefreshToken((t) => t + 1);
      setLastSavedDsl(dsl);
      setSaveStatus('saved');
      return true;
    } catch {
      setSaveStatus('error');
      return false;
    }
  };

  // canvas-08d: plain words, not the raw request state ('idle' showed up beside Save). Whether
  // there's anything to save comes from hasUnsavedChanges; a failed save stays visible until the
  // next attempt. The raw state stays available to tests as data-state.
  const saveLabel =
    saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? "Couldn't save" : hasUnsavedChanges ? 'Unsaved changes' : 'Saved';
  const statusModifier = saveStatus === 'error' ? 'error' : saveStatus === 'saving' || hasUnsavedChanges ? 'dirty' : 'saved';

  return (
    <div className="editor">
      <div className="editor__doc-bar" data-testid="doc-bar">
        {onRequestClose && (
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            data-testid="back-to-diagrams"
            aria-label={backLabel === 'Projects' ? 'Back to Projects' : `Back to project ${backLabel}`}
            title={backLabel}
            onClick={onRequestClose}
          >
            <Icon name="chevron-right" className="icon--flip" />
            <span className="editor__back-label">{backLabel}</span>
          </button>
        )}
        {/* canvas-t3b.3: the editor's heading, for screen readers and for focus to land on after
            opening a diagram (the visible name below is a rename button). */}
        <h1 className="visually-hidden" tabIndex={-1} data-browse-heading>
          {diagram.name}
        </h1>
        <span className="editor__title">
          <Icon name="diamond" />
          {editingName ? (
            <input
              data-testid="diagram-title-input"
              className="editor__title-input"
              autoFocus
              defaultValue={diagram.name}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void commitRename((event.target as HTMLInputElement).value);
                if (event.key === 'Escape') setEditingName(false);
              }}
              onBlur={(event) => void commitRename(event.target.value)}
            />
          ) : (
            <button
              type="button"
              className="editor__title-text editor__title-text--editable"
              data-testid="diagram-title"
              onClick={() => setEditingName(true)}
              title="Rename diagram"
            >
              {diagram.name}
            </button>
          )}
        </span>
        <button
          type="button"
          className="btn btn--tertiary btn--compact btn--icon"
          data-testid="open-diagram-details"
          aria-label="Diagram details"
          title="Diagram details"
          onClick={() => setShowDetails(true)}
        >
          <Icon name="info" />
        </button>
        <span className="spacer" />
        {/* The dot reinforces the words, it never replaces them (FR-006). Specs wait on
            data-state (idle | saving | saved | error), not on the wording. */}
        <span className={`status status--${statusModifier}`} aria-live="polite">
          <span className="status__dot" aria-hidden="true" />
          <span data-testid="save-status" data-state={saveStatus} role={saveStatus === 'error' ? 'alert' : undefined}>
            {saveLabel}
          </span>
        </span>
        <button
          type="button"
          className="btn btn--primary btn--compact"
          data-testid="save-diagram"
          disabled={preview !== null}
          title={preview ? 'Go back to the current version to save' : undefined}
          onClick={() => void handleSave()}
        >
          Save
        </button>
        <ExportMenu diagramId={diagram.id} diagramName={diagram.name} hasUnsavedChanges={hasUnsavedChanges} />
        <SubmitForApproval diagramId={diagram.id} hasUnsavedChanges={hasUnsavedChanges} submission={submission} />
        {/* canvas-i5y: sharing needs edit access (the API refuses it otherwise). */}
        {(diagram.accessLevel ?? 'edit') === 'edit' && (
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            data-testid="open-share-dialog"
            onClick={() => setSharing(true)}
          >
            <Icon name="share" />
            Share
          </button>
        )}
      </div>

      {renameError && (
        <p role="alert" data-testid="diagram-rename-error">
          {renameError}
        </p>
      )}

      <div className="editor__body">
        <div className="editor__rail-left">
          {/* Canvas portals its diagram-tools toolbar in here, above the icon palette. */}
          <div ref={setToolbarContainer} hidden={preview !== null} />
          {/* canvas-hox follow-up: every ER entity is a plain rectangle (erd.ts's own parser has
              no other shape) -- there is no legitimate icon concept for an ER diagram, so the
              search-scoped-to-the-"generic"-library section (which only ever offered the same
              handful of shape-alias sentinels the toolbar's own Shapes section already covers,
              canvas-23t.4) is hidden entirely rather than shown with nothing useful in it. */}
          {diagram.dslFamily !== 'erd' && !preview && (
            <Palette diagramTypeId={diagram.diagramTypeId} onSelectIcon={handleSelectIcon} />
          )}
          {preview && (
            <p className="meta editor__preview-note" data-testid="preview-tools-note">
              Editing tools are hidden while you view an earlier version.
            </p>
          )}
        </div>

        <div className={`editor__canvas${preview ? ' editor__canvas--preview' : ''}`} data-testid="canvas-surface">
          {preview && (
            <div className="preview-bar" role="region" aria-label="Viewing an earlier version" data-testid="version-preview-bar">
              <span className="preview-bar__text">
                <strong>Viewing v{preview.version.sequenceNumber}</strong>
                {preview.version.restoredFromSequence !== null && <> (restored from v{preview.version.restoredFromSequence})</>} ·{' '}
                {preview.version.authorName} · {new Date(preview.version.createdAt).toLocaleString()} · read-only
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="btn btn--primary btn--compact"
                  data-testid="restore-preview"
                  disabled={restoring}
                  onClick={requestRestore}
                >
                  Restore this version
                </button>
              )}
              <button type="button" className="btn btn--secondary btn--compact" data-testid="close-preview" onClick={closePreview}>
                Back to current
              </button>
            </div>
          )}
          {previewError && (
            <p role="alert" className="state state--error" data-testid="preview-error">
              {previewError}
            </p>
          )}
          {preview ? (
            <Canvas
              key={`preview-${preview.version.id}`}
              model={preview.model}
              onChange={() => undefined}
              dslFamily={diagram.dslFamily}
              toolbarContainer={toolbarContainer}
            />
          ) : (
          <Canvas
            model={model}
            onChange={setModel}
            dslFamily={diagram.dslFamily}
            toolbarContainer={toolbarContainer}
            standardRules={standard?.rules}
            violations={liveViolations}
            focusRequest={focusRequest}
            onSelectionChange={setSelection}
            commentPins={commentPins}
            onCommentPinClick={(anchorId) => {
              setCommentsTabRequest((prev) => ({ id: 'comments', nonce: (prev?.nonce ?? 0) + 1 }));
              setPinHighlight((prev) => ({ anchorId, nonce: (prev?.nonce ?? 0) + 1 }));
            }}
          />
          )}
        </div>

        <div className="editor__rail-right">
          <RailTabs
            aria-label="Diagram panels"
            initialTabId={initialRailTab}
            activeRequest={commentsTabRequest}
            onActivate={(id) => {
              setCommentsTabActive(id === 'comments');
              if (id === 'comments') comments.markRead();
            }}
            tabs={[
              {
                id: 'dsl',
                label: 'DSL',
                render: () =>
                  preview ? (
                    <DslPanel key={`preview-${preview.version.id}`} dsl={preview.dsl} parseErrors={[]} onApply={() => undefined} readOnly />
                  ) : (
                    <DslPanel dsl={dsl} parseErrors={parseErrors} onApply={applyDsl} rules={standard?.rules} dslFamily={diagram.dslFamily} />
                  ),
              },
              {
                id: 'chat',
                label: 'Chat',
                render: () => (
                  <ChatPanel diagramId={diagram.id} currentDslContent={dsl} onDiagramUpdated={applyDsl} />
                ),
              },
              {
                id: 'comments',
                label: 'Comments',
                badge:
                  comments.unread > 0 ? (
                    <span className="badge badge--warning" data-testid="comments-unread" aria-label={`${comments.unread} unread comments`}>
                      {comments.unread}
                    </span>
                  ) : undefined,
                render: () => (
                  <CommentsPanel
                    diagramId={diagram.id}
                    threads={comments.threads}
                    onThreadsChange={comments.setThreads}
                    currentUser={currentUser}
                    ownerId={diagram.ownerId}
                    accessLevel={diagram.accessLevel ?? 'edit'}
                    model={model}
                    selection={selection}
                    highlightRequest={pinHighlight}
                    loadError={comments.loadError}
                  />
                ),
              },
              {
                id: 'issues',
                label: 'Issues',
                badge:
                  shownViolations.length > 0 ? (
                    <span className="badge badge--warning">{shownViolations.length}</span>
                  ) : undefined,
                render: () => (
                  <ViolationsPanel
                    violations={shownViolations}
                    rules={standard?.rules}
                    live={liveViolations !== undefined}
                    onSelectElement={(id) => setFocusRequest((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))}
                  />
                ),
              },
              ...(isApprovalTabVisible(submission.status)
                ? [
                    {
                      id: 'approval',
                      label: 'Approval',
                      render: () => <ApprovalPanel diagramId={diagram.id} submission={submission} refreshToken={versionRefreshToken} />,
                    },
                  ]
                : []),
              {
                id: 'history',
                label: 'History',
                render: () => (
                  <VersionHistory
                    diagramId={diagram.id}
                    refreshToken={versionRefreshToken}
                    onPreview={(version) => void openPreview(version)}
                    previewedVersionId={preview?.version.id}
                  />
                ),
              },
            ]}
          />
        </div>
      </div>

      {preview && restoreStep === 'confirm' && (
        <Modal
          label={`Restore v${preview.version.sequenceNumber}`}
          title={`Restore v${preview.version.sequenceNumber}?`}
          testId="restore-confirm"
          onClose={() => setRestoreStep(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="restore-cancel" onClick={() => setRestoreStep(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="restore-confirm-button"
                disabled={restoring}
                onClick={() => void restorePreviewed(false)}
              >
                Restore
              </button>
            </>
          }
        >
          <p>
            This saves v{preview.version.sequenceNumber}&rsquo;s content as a new version. The current diagram stays in the
            history, so you can go back to it.
          </p>
          {restoreError && <p role="alert">{restoreError}</p>}
        </Modal>
      )}

      {preview && restoreStep === 'unsaved' && (
        <Modal
          label="Unsaved changes"
          title="You have unsaved changes"
          testId="restore-unsaved"
          onClose={() => setRestoreStep(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="restore-cancel" onClick={() => setRestoreStep(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="restore-discard"
                disabled={restoring}
                onClick={() => void restorePreviewed(false)}
              >
                Discard them and restore
              </button>
              <button
                type="button"
                className="btn btn--primary"
                data-testid="restore-save-first"
                disabled={restoring}
                onClick={() => void restorePreviewed(true)}
              >
                Save them, then restore
              </button>
            </>
          }
        >
          <p>
            Restoring v{preview.version.sequenceNumber} replaces what&rsquo;s on the canvas. Save your changes first to keep
            them as a version, or discard them.
          </p>
          {restoreError && <p role="alert">{restoreError}</p>}
        </Modal>
      )}

      {sharing && <ShareDialog diagramId={diagram.id} currentUserId={currentUser.id} onClose={() => setSharing(false)} />}

      {showDetails && (
        <Modal
          label="Diagram details"
          testId="diagram-details"
          onClose={() => setShowDetails(false)}
          footer={
            // canvas-96h: the dialog had no visible way out (only Escape). An unsaved description
            // draft is kept for when it's reopened, so closing never loses typing.
            <button type="button" className="btn btn--secondary" data-testid="diagram-details-close" onClick={() => setShowDetails(false)}>
              Close
            </button>
          }
        >
          <dl>
            <dt>Owner</dt>
            <dd data-testid="diagram-details-owner">{diagram.ownerName}</dd>
            <dt>Created</dt>
            <dd data-testid="diagram-details-created">{new Date(diagram.createdAt).toLocaleString()}</dd>
          </dl>
          <div className="field">
            <label className="field__label" htmlFor="diagram-description-input">
              Description
            </label>
            <textarea
              id="diagram-description-input"
              data-testid="diagram-description-input"
              value={descriptionValue}
              onChange={(e) => {
                setDescriptionDraft(e.target.value);
                setDescriptionSaved(false);
              }}
              rows={4}
              style={{ width: '100%' }}
            />
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn--primary btn--compact"
              data-testid="diagram-description-save"
              disabled={!descriptionDirty || savingDescription}
              onClick={handleSaveDescription}
            >
              {savingDescription ? 'Saving…' : 'Save'}
            </button>
            {descriptionDirty && (
              <span className="meta" data-testid="diagram-description-status">
                Unsaved changes
              </span>
            )}
            {!descriptionDirty && descriptionSaved && (
              <span className="meta" data-testid="diagram-description-status">
                Saved
              </span>
            )}
          </div>
          {descriptionError && (
            <p role="alert" data-testid="diagram-description-error">
              {descriptionError}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
});
