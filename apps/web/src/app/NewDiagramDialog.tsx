import { useEffect, useState } from 'react';
import { api, type DiagramTypeDto } from './api';
import { Modal } from '../ui/Modal';

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
    <Modal
      label="New diagram"
      title="Choose a diagram type"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--secondary" data-testid="cancel-new-diagram" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="confirm-new-diagram"
            disabled={!selected}
            onClick={() => selected && onCreate(selected)}
          >
            Create
          </button>
        </>
      }
    >
      <ul className="choice-list">
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
              <span>
                {type.name} <small className="meta">({type.personas.join(', ')})</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
