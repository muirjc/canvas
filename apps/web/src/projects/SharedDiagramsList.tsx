import type { SharedDiagramDto } from '../app/api';
import { Icon } from '../ui/Icon';

export interface SharedDiagramsListProps {
  diagrams: SharedDiagramDto[];
  onOpenDiagram: (diagramId: string) => void;
}

/**
 * Diagrams shared directly with the signed-in user (feature 008, FR-001). A sibling to
 * `ProjectBrowser`, not a variant of it: rendered by `App.tsx` only when `diagrams` is non-empty
 * (FR-002 — the section is omitted entirely, not shown empty) and independent of which project,
 * if any, is currently in view.
 */
export function SharedDiagramsList({ diagrams, onOpenDiagram }: SharedDiagramsListProps) {
  return (
    <section className="card" data-testid="shared-diagrams">
      <h2 className="section-label">Shared with you</h2>
      <ul className="project-node__list">
        {diagrams.map((diagram) => (
          <li key={diagram.diagramId} className="row" data-testid={`shared-diagram-${diagram.diagramId}`}>
            <Icon name="diamond" />
            <span className="row__main">
              <span className="row__title">{diagram.diagramName}</span>
              <span className="meta">
                {/* Read-only text, deliberately not a link (feature 007's FR-013a, narrowed for
                    this one disclosure) — never the diagram's other diagrams, members, or a way
                    to browse it. */}
                <span data-testid={`shared-diagram-project-${diagram.diagramId}`}>{diagram.projectName}</span>
                {' · '}
                <span data-testid={`shared-diagram-access-${diagram.diagramId}`}>{diagram.accessLevel}</span>
                {' · '}
                Shared by{' '}
                <span data-testid={`shared-diagram-shared-by-${diagram.diagramId}`}>{diagram.sharedByName}</span>
              </span>
            </span>
            <span className="row__actions">
              <button
                type="button"
                className="btn btn--tertiary btn--compact"
                data-testid={`open-shared-diagram-${diagram.diagramId}`}
                onClick={() => onOpenDiagram(diagram.diagramId)}
              >
                Open
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
