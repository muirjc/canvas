import { useEffect, useState } from 'react';
import { api, ApiError, type AiPersonaDto, type DiagramDto } from '../app/api';

export interface CreateViaChatDialogProps {
  projectId: string;
  onCreated: (diagram: DiagramDto) => void;
  onCancel: () => void;
}

function groupByCategory(personas: AiPersonaDto[]): Map<string, AiPersonaDto[]> {
  const groups = new Map<string, AiPersonaDto[]>();
  for (const persona of personas) {
    const list = groups.get(persona.category) ?? [];
    list.push(persona);
    groups.set(persona.category, list);
  }
  return groups;
}

/** "Create via AI Chat" entry point (User Story 1, FR-005): pick a persona, describe the diagram,
 * and hand back a diagram already populated from the AI's first response. */
export function CreateViaChatDialog({ projectId, onCreated, onCancel }: CreateViaChatDialogProps) {
  const [personas, setPersonas] = useState<AiPersonaDto[]>([]);
  const [personaId, setPersonaId] = useState('');
  const [name, setName] = useState('Untitled Diagram');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAiPersonas().then(({ personas }) => setPersonas(personas));
  }, []);

  const handleCreate = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const { diagram } = await api.createDiagram(projectId, { name, diagramTypeId: 'flowchart' });
      const result = await api.sendChatMessage(diagram.id, {
        message: description,
        currentDslContent: diagram.dslContent,
        personaId,
      });
      onCreated({ ...diagram, dslContent: result.updatedDslContent });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const groups = groupByCategory(personas);

  return (
    <div role="dialog" aria-label="Create via AI Chat">
      <h2>Create via AI Chat</h2>
      <label>
        Name
        <input data-testid="ai-create-name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Persona
        <select data-testid="ai-create-persona" value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
          <option value="" disabled>
            Select a persona…
          </option>
          {[...groups.entries()].map(([category, categoryPersonas]) => (
            <optgroup key={category} label={category}>
              {categoryPersonas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <textarea
        data-testid="ai-create-description"
        aria-label="Describe the diagram you want"
        placeholder="Describe the diagram you want…"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={6}
        cols={60}
      />
      <div>
        <button type="button" data-testid="ai-create-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="ai-create-confirm"
          disabled={!personaId || !description || submitting}
          onClick={handleCreate}
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </div>
      {error && (
        <p role="alert" data-testid="ai-create-error">
          {error}
        </p>
      )}
    </div>
  );
}
