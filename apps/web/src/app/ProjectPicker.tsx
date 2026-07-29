import type { ProjectDto } from './api';

interface ProjectPickerProps {
  projects: ProjectDto[];
  currentProjectId: string | null;
  onSelect: (projectId: string) => void;
}

/**
 * Shows which project the user is working in and lets them change it (FR-008, FR-009).
 *
 * A native <select>, deliberately. The clarified scale is tens of projects with no search or
 * paging (FR-013e), and a native control is keyboard-operable and screen-reader correct without
 * reimplementing any of that — which FR-018 requires and a custom listbox would put at risk for
 * no gain at this scale.
 *
 * With one project there is nothing to choose, so the name is shown as plain text rather than a
 * control offering a decision with a single answer (spec Assumptions).
 */
export function ProjectPicker({ projects, currentProjectId, onSelect }: ProjectPickerProps) {
  const current = projects.find((p) => p.id === currentProjectId);

  if (projects.length <= 1) {
    return (
      <p className="project-context">
        <span className="section-label">Project</span>{' '}
        <span data-testid="project-name">{current?.name ?? '—'}</span>
      </p>
    );
  }

  return (
    <p className="project-context">
      <label className="section-label" htmlFor="project-picker">
        Project
      </label>{' '}
      <select
        id="project-picker"
        data-testid="project-picker"
        value={currentProjectId ?? ''}
        onChange={(event) => onSelect(event.target.value)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id} data-testid="project-picker-option">
            {project.name}
          </option>
        ))}
      </select>{' '}
      <span data-testid="project-name" hidden>
        {current?.name ?? ''}
      </span>
    </p>
  );
}
