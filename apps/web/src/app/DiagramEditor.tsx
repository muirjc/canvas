import { useEffect, useRef, useState } from 'react';
import { createEmptyDiagramModel, getDslFamily, isParseSuccess, type DiagramModel } from '@canvas/diagram-core';
import { Canvas } from '../canvas/Canvas';
import { DslPanel } from '../canvas/DslPanel';
import { ExportMenu } from '../canvas/ExportMenu';
import { ViolationsPanel } from '../canvas/ViolationsPanel';
import { useDslSync } from '../canvas/useDslSync';
import { ChatPanel } from '../ai/ChatPanel';
import { Palette } from '../palette/Palette';
import { VersionHistory } from '../projects/VersionHistory';
import { ShareDialog } from '../projects/ShareDialog';
import { api, type DiagramDto, type IconDto } from './api';
import { Icon } from '../ui/Icon';
import { RailTabs } from '../ui/RailTabs';

let iconNodeCounter = 0;
function nextIconNodeId(): string {
  iconNodeCounter += 1;
  return `icon${Date.now().toString(36)}${iconNodeCounter}`;
}

export interface DiagramEditorProps {
  diagram: DiagramDto;
  /**
   * Reports whether the open diagram has edits that have not been saved, so the shell can warn
   * before a project switch discards them (feature 007, FR-013d).
   */
  onUnsavedChangesChange?: (hasUnsavedChanges: boolean) => void;
}

function initialModelFromDsl(diagram: DiagramDto): DiagramModel {
  // Parsing here reuses the exact same diagram-core parser the server validated with, so the
  // canvas and the stored DSL start out guaranteed consistent.
  const family = getDslFamily(diagram.dslFamily);
  if (!family) return createEmptyDiagramModel(diagram.diagramTypeId);
  const result = family.parse(diagram.dslContent);
  return isParseSuccess(result) ? result.model : createEmptyDiagramModel(diagram.diagramTypeId);
}

export function DiagramEditor({ diagram: initialDiagram, onUnsavedChangesChange }: DiagramEditorProps) {
  const [diagram, setDiagram] = useState(initialDiagram);
  const [model, setModel] = useState<DiagramModel>(() => initialModelFromDsl(diagram));
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [violations, setViolations] = useState(diagram.lastValidationResult);
  const [versionRefreshToken, setVersionRefreshToken] = useState(0);
  const [sharing, setSharing] = useState(false);
  // State rather than a ref: the portal target must trigger a re-render once it is attached,
  // otherwise Canvas renders its toolbar in place on the first pass and never moves it.
  const [toolbarContainer, setToolbarContainer] = useState<HTMLDivElement | null>(null);
  const { dsl, parseErrors, applyDsl } = useDslSync(model, setModel, diagram.dslFamily);

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

  useEffect(() => {
    onUnsavedChangesChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onUnsavedChangesChange]);

  // Leaving the editor must not leave a stale "unsaved" flag behind on the shell.
  useEffect(() => () => onUnsavedChangesChange?.(false), [onUnsavedChangesChange]);

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

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      const { diagram: saved } = await api.saveDiagram(diagram.id, dsl);
      setViolations(saved.lastValidationResult);
      setVersionRefreshToken((t) => t + 1);
      setLastSavedDsl(dsl);
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  };

  const statusModifier =
    saveStatus === 'saved' ? 'saved' : saveStatus === 'error' ? 'error' : saveStatus === 'saving' ? 'dirty' : '';

  return (
    <div className="editor">
      <div className="editor__doc-bar" data-testid="doc-bar">
        <span className="editor__title">
          <Icon name="diamond" />
          <span className="editor__title-text">{diagram.name}</span>
        </span>
        <span className="spacer" />
        {/* The dot sits BESIDE `save-status`, never inside it: five existing spec files assert
            that element's text exactly (`toHaveText('saved')`), and SC-003 forbids changing an
            existing assertion. The dot reinforces the word, it never replaces it (FR-006). */}
        <span className={`status ${statusModifier ? `status--${statusModifier}` : ''}`}>
          <span className="status__dot" aria-hidden="true" />
          <span data-testid="save-status">{saveStatus}</span>
        </span>
        <button type="button" className="btn btn--primary btn--compact" data-testid="save-diagram" onClick={handleSave}>
          Save
        </button>
        <ExportMenu diagramId={diagram.id} diagramName={diagram.name} />
        <button
          type="button"
          className="btn btn--secondary btn--compact"
          data-testid="open-share-dialog"
          onClick={() => setSharing(true)}
        >
          <Icon name="share" />
          Share
        </button>
      </div>

      <div className="editor__body">
        <div className="editor__rail-left">
          {/* Canvas portals its diagram-tools toolbar in here, above the icon palette. */}
          <div ref={setToolbarContainer} />
          <Palette diagramTypeId={diagram.diagramTypeId} onSelectIcon={handleSelectIcon} />
        </div>

        <div className="editor__canvas" data-testid="canvas-surface">
          <Canvas model={model} onChange={setModel} dslFamily={diagram.dslFamily} toolbarContainer={toolbarContainer} />
        </div>

        <div className="editor__rail-right">
          <RailTabs
            aria-label="Diagram panels"
            initialTabId="dsl"
            tabs={[
              {
                id: 'dsl',
                label: 'DSL',
                render: () => <DslPanel dsl={dsl} parseErrors={parseErrors} onApply={applyDsl} />,
              },
              {
                id: 'chat',
                label: 'Chat',
                render: () => (
                  <ChatPanel diagramId={diagram.id} currentDslContent={dsl} onDiagramUpdated={applyDsl} />
                ),
              },
              {
                id: 'issues',
                label: 'Issues',
                badge:
                  violations.length > 0 ? (
                    <span className="badge badge--warning">{violations.length}</span>
                  ) : undefined,
                render: () => <ViolationsPanel violations={violations} />,
              },
              {
                id: 'history',
                label: 'History',
                render: () => (
                  <VersionHistory
                    diagramId={diagram.id}
                    refreshToken={versionRefreshToken}
                    onRestored={handleRestored}
                  />
                ),
              },
            ]}
          />
        </div>
      </div>

      {sharing && <ShareDialog diagramId={diagram.id} onClose={() => setSharing(false)} />}
    </div>
  );
}
