import { useState } from 'react';
import { api, ApiError, type DiagramDto } from '../app/api';
import { UnsupportedElementNotice } from '../canvas/UnsupportedElementNotice';
import { Modal } from '../ui/Modal';

export interface ImportDialogProps {
  projectId: string;
  onImported: (diagram: DiagramDto) => void;
  onCancel: () => void;
}

/** Paste/upload an existing Mermaid diagram to continue editing it (FR-018, FR-019). */
export function ImportDialog({ projectId, onImported, onCancel }: ImportDialogProps) {
  const [name, setName] = useState('Imported Diagram');
  const [dslContent, setDslContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parseErrors, setParseErrors] = useState<{ line: number; content: string; message: string }[]>([]);

  const handleFileUpload = async (file: File) => {
    setDslContent(await file.text());
  };

  const handleImport = async () => {
    setError(null);
    setParseErrors([]);
    try {
      const { diagram } = await api.importDiagram(projectId, { name, dslContent });
      onImported(diagram);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setParseErrors(err.details as { line: number; content: string; message: string }[]);
      } else {
        setError((err as Error).message);
      }
    }
  };

  return (
    <Modal
      label="Import diagram"
      title="Import a Mermaid Diagram"
      wide
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--secondary" data-testid="cancel-import" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="confirm-import"
            disabled={!dslContent}
            onClick={handleImport}
          >
            Import
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="import-name">
          Name
        </label>
        <input id="import-name" data-testid="import-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <input
          data-testid="import-file"
          aria-label="Upload a Mermaid diagram file"
          type="file"
          accept=".mmd,.txt,text/plain"
          onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
        />
      </div>
      <textarea
        className="import-textarea"
        data-testid="import-textarea"
        aria-label="Paste Mermaid diagram source"
        placeholder="Paste Mermaid DSL here…"
        value={dslContent}
        onChange={(e) => setDslContent(e.target.value)}
        rows={12}
      />
      {error && (
        <p role="alert" data-testid="import-error">
          {error}
        </p>
      )}
      <UnsupportedElementNotice errors={parseErrors} />
    </Modal>
  );
}
