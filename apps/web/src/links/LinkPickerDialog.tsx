// canvas-8uh1.3: choose the diagram an element opens. Find one (any project; the project's own first, the
// type one level down first when there is one -- a C4 System offers Container diagrams), or make a new one for
// the element in this diagram's project. The caller writes the link (setDiagramLink) and remembers the target.
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type DiagramSummaryDto, type DiagramTypeDto, type ProjectDto } from '../app/api';
import { SUGGESTED_LINK_TYPES, type LinkTarget } from '../app/diagram-links';
import { Modal } from '../ui/Modal';

export interface LinkPickerDialogProps {
  /** The diagram being edited (never offered as its own link). */
  diagramId: string;
  diagramTypeId: string;
  projectId: string;
  elementLabel: string;
  /** The diagram the element links to now, if any. */
  currentTargetId?: string;
  onPick: (diagramId: string, target: LinkTarget) => void;
  onClose: () => void;
  /** canvas-8uh1.6: 'frame' = choose a diagram to draw in a new frame (the same search; the wording changes). */
  mode?: 'link' | 'frame';
}

export function LinkPickerDialog({ diagramId, diagramTypeId, projectId, elementLabel, currentTargetId, onPick, onClose, mode = 'link' }: LinkPickerDialogProps) {
  const framing = mode === 'frame';
  const suggested = SUGGESTED_LINK_TYPES[diagramTypeId] ?? [];
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [types, setTypes] = useState<DiagramTypeDto[]>([]);
  const [searchProjectId, setSearchProjectId] = useState(projectId);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState(suggested[0] ?? '');
  const [results, setResults] = useState<DiagramSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState(elementLabel);
  const [newType, setNewType] = useState(suggested[0] ?? diagramTypeId);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .listProjects()
      .then(({ projects: list }) => setProjects(list))
      .catch(() => setProjects([]));
    api
      .listDiagramTypes()
      .then(({ diagramTypes }) => setTypes(diagramTypes))
      .catch(() => setTypes([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    const timer = window.setTimeout(() => {
      api
        .searchProjectDiagrams(searchProjectId, { query: query.trim() || undefined, type: typeFilter || undefined })
        .then(({ diagrams }) => !cancelled && setResults(diagrams.filter((d) => d.id !== diagramId)))
        .catch(() => !cancelled && setResults([]));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchProjectId, query, typeFilter, diagramId]);

  const typeName = useMemo(() => new Map(types.map((t) => [t.id, t.name])), [types]);
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name;
  // Suggested types first, then the rest by name.
  const orderedTypes = [...types].sort((a, b) => Number(suggested.includes(b.id)) - Number(suggested.includes(a.id)) || a.name.localeCompare(b.name));
  const thisProject = projects?.find((p) => p.id === projectId);
  // Only once the project list says this person may add diagrams to the project (the API checks again).
  const canCreate = thisProject !== undefined && (thisProject.accessLevel === undefined || ['edit', 'manage'].includes(thisProject.accessLevel));

  const pick = (diagram: DiagramSummaryDto) =>
    onPick(diagram.id, { status: 'available', name: diagram.name, diagramTypeId: diagram.diagramTypeId, projectId: diagram.projectId, projectName: projectName(diagram.projectId) });

  const createAndLink = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const { diagram } = await api.createDiagram(projectId, { name, diagramTypeId: newType });
      onPick(diagram.id, { status: 'available', name: diagram.name, diagramTypeId: diagram.diagramTypeId, projectId: diagram.projectId, projectName: projectName(diagram.projectId) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't create the diagram.");
      setCreating(false);
    }
  };

  return (
    <Modal
      label={framing ? 'Embed a diagram' : `Link ${elementLabel} to a diagram`}
      testId="link-picker"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--secondary" data-testid="link-picker-cancel" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <div className="stack">
        <p className="meta">
          {framing ? 'Choose a diagram to draw in a frame on this one. The frame shows its latest saved version.' : <>Choose the diagram that opens from &ldquo;{elementLabel}&rdquo;.</>}
        </p>
        <div className="cluster">
          <div className="field">
            <label className="field__label" htmlFor="link-picker-project">
              Project
            </label>
            <select id="link-picker-project" data-testid="link-picker-project" value={searchProjectId} onChange={(e) => setSearchProjectId(e.target.value)}>
              {(projects ?? []).length === 0 && <option value={projectId}>This project</option>}
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === projectId ? `${p.name} (this project)` : p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="link-picker-type">
              Type
            </label>
            <select id="link-picker-type" data-testid="link-picker-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">Any type</option>
              {orderedTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {suggested.includes(t.id) ? `${t.name} (suggested)` : t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="link-picker-search">
              Name
            </label>
            <input id="link-picker-search" data-testid="link-picker-search" type="search" value={query} placeholder="Search by name" onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        {results === null ? (
          <p className="meta" role="status" data-testid="link-picker-loading">
            Searching…
          </p>
        ) : results.length === 0 ? (
          <p className="meta" role="status" data-testid="link-picker-empty">
            No diagrams match.
          </p>
        ) : (
          <ul className="link-picker__results" aria-label="Matching diagrams" data-testid="link-picker-results">
            {results.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className="btn btn--tertiary link-picker__result"
                  data-testid={`link-picker-result-${d.id}`}
                  aria-current={d.id === currentTargetId ? 'true' : undefined}
                  onClick={() => pick(d)}
                >
                  <span className="link-picker__name">{d.name}</span>
                  <span className="meta">{typeName.get(d.diagramTypeId) ?? d.diagramTypeId}</span>
                  {d.id === currentTargetId && <span className="badge">Linked now</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {canCreate && (
          <fieldset className="link-picker__new" aria-describedby="link-picker-new-hint">
            <legend className="section-label">Or make a new diagram for it</legend>
            <div className="cluster">
              <div className="field">
                <label className="field__label" htmlFor="link-picker-new-name">
                  Name
                </label>
                <input id="link-picker-new-name" data-testid="link-picker-new-name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="link-picker-new-type">
                  Type
                </label>
                <select id="link-picker-new-type" data-testid="link-picker-new-type" value={newType} onChange={(e) => setNewType(e.target.value)}>
                  {orderedTypes.length === 0 && <option value={newType}>{newType}</option>}
                  {orderedTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {suggested.includes(t.id) ? `${t.name} (suggested)` : t.name}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn btn--primary" data-testid="link-picker-create" disabled={creating || !newName.trim()} onClick={() => void createAndLink()}>
                {creating ? 'Creating…' : framing ? 'Create and embed' : 'Create and link'}
              </button>
            </div>
            <p className="meta" id="link-picker-new-hint">
              {framing ? 'It goes in this diagram’s project, empty; its frame fills in once it is saved.' : 'It goes in this diagram’s project, empty, and opens when you follow the link.'}
            </p>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="state state--error" data-testid="link-picker-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
