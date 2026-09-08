import { useEffect, useState } from 'react';
import { templateCompilers } from '@canvas/diagram-core';
import { api, ApiError, type DiagramDto, type DiagramTypeDto } from '../app/api';
import { UnsupportedElementNotice } from '../canvas/UnsupportedElementNotice';
import { Modal } from '../ui/Modal';

export interface ImportTemplateDialogProps {
  projectId: string;
  persona?: string;
  onImported: (diagram: DiagramDto) => void;
  onCancel: () => void;
}

/** Paste/upload a Markdown template to compile it into a new diagram (mirrors ImportDialog's
 *  raw-DSL import, but the source is a template document and the diagram type must be one with a
 *  registered template compiler — see `@canvas/diagram-core`'s `templateCompilers`). */
export function ImportTemplateDialog({ projectId, persona, onImported, onCancel }: ImportTemplateDialogProps) {
  const [types, setTypes] = useState<DiagramTypeDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('Imported Diagram');
  const [templateContent, setTemplateContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parseErrors, setParseErrors] = useState<{ line: number; content: string; message: string }[]>([]);

  useEffect(() => {
    api.listDiagramTypes(persona).then(({ diagramTypes }) => setTypes(diagramTypes.filter((t) => t.id in templateCompilers)));
  }, [persona]);

  const handleFileUpload = async (file: File) => {
    setTemplateContent(await file.text());
  };

  const handleImport = async () => {
    if (!selected) return;
    setError(null);
    setParseErrors([]);
    try {
      const { diagram } = await api.importTemplate(projectId, { name, diagramTypeId: selected, templateContent });
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
      label="Import from template"
      title="Import from Template"
      wide
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--secondary" data-testid="cancel-import-template" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="confirm-import-template"
            disabled={!selected || !templateContent}
            onClick={handleImport}
          >
            Import
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="import-template-name">
          Name
        </label>
        <input
          id="import-template-name"
          data-testid="import-template-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <ul className="choice-list">
        {types.map((type) => (
          <li key={type.id}>
            <label>
              <input
                type="radio"
                name="templateDiagramType"
                value={type.id}
                checked={selected === type.id}
                onChange={() => setSelected(type.id)}
                data-testid={`template-type-${type.id}`}
              />
              <span>
                {type.name} <small className="meta">({type.personas.join(', ')})</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="field">
        <input
          data-testid="import-template-file"
          aria-label="Upload a template file"
          type="file"
          accept=".md,.txt,text/markdown,text/plain"
          onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
        />
      </div>
      <textarea
        className="import-textarea"
        data-testid="import-template-textarea"
        aria-label="Paste template source"
        placeholder="Paste template Markdown here…"
        value={templateContent}
        onChange={(e) => setTemplateContent(e.target.value)}
        rows={12}
      />
      {error && (
        <p role="alert" data-testid="import-template-error">
          {error}
        </p>
      )}
      <UnsupportedElementNotice errors={parseErrors} />
    </Modal>
  );
}
