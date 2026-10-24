import { useEffect, useState } from 'react';
import { api, type DiagramTypeDto } from './api';
import { Modal } from '../ui/Modal';
import { useDiagramTypeFilter } from './diagram-type-filter';

export interface NewDiagramDialogProps {
  persona?: string;
  /** The signed-in user's personas: their types are listed first, the rest behind a checkbox. */
  userPersonas?: string[];
  onCreate: (diagramTypeId: string) => void;
  onCancel: () => void;
}

/** Persona-scoped diagram type picker (Constitution III / FR-006, FR-007). */
export function NewDiagramDialog({ persona, userPersonas, onCreate, onCancel }: NewDiagramDialogProps) {
  const [types, setTypes] = useState<DiagramTypeDto[]>([]);
  const [chosen, setSelected] = useState<string | null>(null);
  const filter = useDiagramTypeFilter(types, userPersonas);
  // A choice hidden by the persona filter (e.g. "Show all" unticked after choosing) counts as none.
  const selected = chosen && filter.visible.some((t) => t.id === chosen) ? chosen : null;

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
      {filter.control}
      <ul className="choice-list">
        {filter.visible.map((type) => (
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
