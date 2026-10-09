import { useState } from 'react';
import { dslFamilies } from '@canvas/diagram-core';
import { api, ApiError, type DiagramTypeDto } from '../app/api';
import { Modal } from '../ui/Modal';

export const PERSONAS = ['Business', 'Enterprise', 'Solution', 'Technical'] as const;

export interface DiagramTypeDialogProps {
  /** Present when editing an existing custom type. */
  diagramType?: DiagramTypeDto;
  onSaved: (diagramType: DiagramTypeDto) => void;
  onClose: () => void;
}

function issuesOf(error: unknown): string[] {
  if (error instanceof ApiError) {
    const details = error.details as { issues?: { path: string; message: string }[] } | undefined;
    if (details?.issues?.length) return details.issues.map((i) => i.message);
    return [error.message];
  }
  return [(error as Error).message];
}

/** Create a custom diagram type, or edit one (builtin types are not editable here). */
export function DiagramTypeDialog({ diagramType, onSaved, onClose }: DiagramTypeDialogProps) {
  const editing = Boolean(diagramType);
  const [name, setName] = useState(diagramType?.name ?? '');
  const [dslFamily, setDslFamily] = useState(diagramType?.dslFamily ?? 'flowchart');
  const [personas, setPersonas] = useState<string[]>(diagramType?.personas ?? []);
  const [description, setDescription] = useState(diagramType?.description ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // Server returns 409 when the family can't change (diagrams already exist); lock from then on.
  const [familyLocked, setFamilyLocked] = useState(false);

  const togglePersona = (persona: string) =>
    setPersonas((prev) => (prev.includes(persona) ? prev.filter((p) => p !== persona) : [...prev, persona]));

  const localErrors: string[] = [];
  if (!name.trim()) localErrors.push('Name is required.');
  if (personas.length === 0) localErrors.push('Choose at least one persona.');

  const submit = async () => {
    if (localErrors.length > 0) {
      setErrors(localErrors);
      return;
    }
    setSaving(true);
    setErrors([]);
    try {
      const input = { name: name.trim(), dslFamily, personas, description: description.trim() || null };
      const result =
        editing && diagramType
          ? await api.updateDiagramType(diagramType.id, input)
          : await api.createDiagramType(input);
      onSaved(result.diagramType);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setFamilyLocked(true);
      setErrors(issuesOf(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      label={editing ? 'Edit diagram type' : 'New diagram type'}
      testId="diagram-type-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--secondary" data-testid="diagram-type-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="diagram-type-save"
            disabled={saving}
            onClick={submit}
          >
            {editing ? 'Save changes' : 'Create diagram type'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="diagram-type-name">
          Name
        </label>
        <input
          id="diagram-type-name"
          data-testid="diagram-type-name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="diagram-type-family">
          Diagram family
        </label>
        <select
          id="diagram-type-family"
          data-testid="diagram-type-family"
          value={dslFamily}
          disabled={familyLocked}
          onChange={(e) => setDslFamily(e.target.value)}
        >
          {Object.keys(dslFamilies).map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
        <span className="meta">
          {familyLocked
            ? 'The family is locked because diagrams of this type already exist.'
            : 'Decides the syntax and which shapes are available. Cannot be changed once diagrams exist.'}
        </span>
      </div>
      <fieldset className="field">
        <legend className="field__label">Available to personas</legend>
        <div className="cluster">
          {PERSONAS.map((persona) => (
            <label key={persona} className="cluster cluster--tight">
              <input
                type="checkbox"
                data-testid={`diagram-type-persona-${persona}`}
                checked={personas.includes(persona)}
                onChange={() => togglePersona(persona)}
              />
              {persona}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label className="field__label" htmlFor="diagram-type-description">
          Description (optional)
        </label>
        <textarea
          id="diagram-type-description"
          data-testid="diagram-type-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {errors.length > 0 && (
        <ul className="field__error" role="alert" data-testid="diagram-type-errors">
          {errors.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
