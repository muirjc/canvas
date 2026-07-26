import { useEffect, useState } from 'react';
import { api, type StandardDto, type StandardRulesDto } from '../app/api';

const KNOWN_SHAPES = ['rectangle', 'rounded-rectangle', 'circle', 'diamond', 'cylinder', 'person', 'icon'];

export interface StandardsEditorProps {
  diagramTypeId: string;
}

function emptyRules(): StandardRulesDto {
  return { allowedShapeIds: [], mandatoryShapeIds: [], allowedIconLibraryRefs: [], colorPalette: [] };
}

/**
 * Admin console: define an organization-wide diagramming Standard for a diagram type
 * (FR-011), publish it (making it active — FR-012), or retire it (FR-014).
 */
export function StandardsEditor({ diagramTypeId }: StandardsEditorProps) {
  const [rules, setRules] = useState<StandardRulesDto>(emptyRules());
  const [colorRole, setColorRole] = useState('');
  const [colorHex, setColorHex] = useState('#000000');
  const [standards, setStandards] = useState<StandardDto[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    api.listStandards(diagramTypeId).then(({ standards }) => setStandards(standards));
  };

  useEffect(refresh, [diagramTypeId]);

  const toggleShape = (list: 'allowedShapeIds' | 'mandatoryShapeIds', shape: string) => {
    setRules((prev) => ({
      ...prev,
      [list]: prev[list].includes(shape) ? prev[list].filter((s) => s !== shape) : [...prev[list], shape],
    }));
  };

  const addColorEntry = () => {
    if (!colorRole) return;
    setRules((prev) => ({ ...prev, colorPalette: [...prev.colorPalette, { role: colorRole, colorHex }] }));
    setColorRole('');
  };

  const createAndPublish = async () => {
    try {
      const { standard } = await api.createStandard(diagramTypeId, rules);
      await api.publishStandard(standard.id);
      setMessage(`Published standard v${standard.version} for ${diagramTypeId}.`);
      setRules(emptyRules());
      refresh();
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  return (
    <div>
      <h2>Standards — {diagramTypeId}</h2>

      <fieldset>
        <legend>Allowed shapes (empty = unrestricted)</legend>
        {KNOWN_SHAPES.map((shape) => (
          <label key={shape} data-testid={`allowed-shape-${shape}`}>
            <input
              type="checkbox"
              checked={rules.allowedShapeIds.includes(shape)}
              onChange={() => toggleShape('allowedShapeIds', shape)}
            />
            {shape}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Mandatory shapes (must appear at least once)</legend>
        {KNOWN_SHAPES.map((shape) => (
          <label key={shape} data-testid={`mandatory-shape-${shape}`}>
            <input
              type="checkbox"
              checked={rules.mandatoryShapeIds.includes(shape)}
              onChange={() => toggleShape('mandatoryShapeIds', shape)}
            />
            {shape}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Approved color per role</legend>
        <input
          data-testid="color-role-input"
          aria-label="Node role for this color rule"
          placeholder="role, e.g. person"
          value={colorRole}
          onChange={(e) => setColorRole(e.target.value)}
        />
        <input
          data-testid="color-hex-input"
          aria-label="Approved color for this role"
          type="color"
          value={colorHex}
          onChange={(e) => setColorHex(e.target.value)}
        />
        <button type="button" data-testid="add-color-entry" onClick={addColorEntry}>
          Add
        </button>
        <ul>
          {rules.colorPalette.map((entry, index) => (
            <li key={index}>
              {entry.role}: {entry.colorHex}
            </li>
          ))}
        </ul>
      </fieldset>

      <button type="button" data-testid="create-publish-standard" onClick={createAndPublish}>
        Create &amp; Publish Standard
      </button>
      {message && <p data-testid="standards-editor-message">{message}</p>}

      <h3>History</h3>
      <ul data-testid="standards-history">
        {standards.map((standard) => (
          <li key={standard.id}>
            v{standard.version} — {standard.status}
            {standard.status === 'published' && (
              <button type="button" onClick={() => api.retireStandard(standard.id).then(refresh)}>
                Retire
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
