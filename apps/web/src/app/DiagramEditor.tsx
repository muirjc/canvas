import { useState } from 'react';
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

let iconNodeCounter = 0;
function nextIconNodeId(): string {
  iconNodeCounter += 1;
  return `icon${Date.now().toString(36)}${iconNodeCounter}`;
}

export interface DiagramEditorProps {
  diagram: DiagramDto;
}

function initialModelFromDsl(diagram: DiagramDto): DiagramModel {
  // Parsing here reuses the exact same diagram-core parser the server validated with, so the
  // canvas and the stored DSL start out guaranteed consistent.
  const family = getDslFamily(diagram.dslFamily);
  if (!family) return createEmptyDiagramModel(diagram.diagramTypeId);
  const result = family.parse(diagram.dslContent);
  return isParseSuccess(result) ? result.model : createEmptyDiagramModel(diagram.diagramTypeId);
}

export function DiagramEditor({ diagram: initialDiagram }: DiagramEditorProps) {
  const [diagram, setDiagram] = useState(initialDiagram);
  const [model, setModel] = useState<DiagramModel>(() => initialModelFromDsl(diagram));
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [violations, setViolations] = useState(diagram.lastValidationResult);
  const [versionRefreshToken, setVersionRefreshToken] = useState(0);
  const [sharing, setSharing] = useState(false);
  const { dsl, parseErrors, applyDsl } = useDslSync(model, setModel, diagram.dslFamily);

  const handleRestored = async () => {
    const { diagram: restored } = await api.getDiagram(diagram.id);
    setDiagram(restored);
    setModel(initialModelFromDsl(restored));
    setViolations(restored.lastValidationResult);
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
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    }
  };

  return (
    <div>
      <h2>{diagram.name}</h2>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <Palette diagramTypeId={diagram.diagramTypeId} onSelectIcon={handleSelectIcon} />
        <Canvas model={model} onChange={setModel} />
        <DslPanel dsl={dsl} parseErrors={parseErrors} onApply={applyDsl} />
      </div>
      <button type="button" data-testid="save-diagram" onClick={handleSave}>
        Save
      </button>
      <span data-testid="save-status">{saveStatus}</span>
      <ExportMenu diagramId={diagram.id} diagramName={diagram.name} />
      <button type="button" data-testid="open-share-dialog" onClick={() => setSharing(true)}>
        Share
      </button>
      {sharing && <ShareDialog diagramId={diagram.id} onClose={() => setSharing(false)} />}
      <ViolationsPanel violations={violations} />
      <VersionHistory diagramId={diagram.id} refreshToken={versionRefreshToken} onRestored={handleRestored} />
      <ChatPanel diagramId={diagram.id} currentDslContent={dsl} onDiagramUpdated={applyDsl} />
    </div>
  );
}
