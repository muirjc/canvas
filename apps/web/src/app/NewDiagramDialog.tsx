import { useEffect, useState } from 'react';
import { api, type DiagramTypeDto } from './api';

export interface NewDiagramDialogProps {
  persona?: string;
  onCreate: (diagramTypeId: string) => void;
  onCancel: () => void;
}

/** Persona-scoped diagram type picker (Constitution III / FR-006, FR-007). */
export function NewDiagramDialog({ persona, onCreate, onCancel }: NewDiagramDialogProps) {
  const [types, setTypes] = useState<DiagramTypeDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.listDiagramTypes(persona).then(({ diagramTypes }) => setTypes(diagramTypes));
  }, [persona]);

  return (
    <div role="dialog" aria-label="New diagram">
      <h2>Choose a diagram type</h2>
      <ul>
        {types.map((type) => (
          <li key={type.id}>
            <label>
              <input
                type="radio"
                name="diagramType"
                value={type.id}
                checked={selected === type.id}
                onChange={() => setSelected(type.id)}
                data-testid={`diagram-type-${type.id}`}
              />
              {type.name} <small>({type.personas.join(', ')})</small>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" data-testid="cancel-new-diagram" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        data-testid="confirm-new-diagram"
        disabled={!selected}
        onClick={() => selected && onCreate(selected)}
      >
        Create
      </button>
    </div>
  );
}
