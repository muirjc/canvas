// canvas-8uh1.3: the editor's Links tab. "Links from this diagram": each element that opens another diagram,
// with where it goes and whether it can be opened (Open; Change and Remove for editors). "Used in": the diagrams
// that link here (as last saved), each opening to the element that links.
import { frameStatusText, type DiagramFrame, type FrameContent } from '@canvas/diagram-core';
import type { DiagramUsedInDto } from '../app/api';
import { linkStatusText, type ElementLink, type LinkTarget } from '../app/diagram-links';
import { Icon } from '../ui/Icon';

export interface LinksPanelProps {
  links: ElementLink[];
  targets: Map<string, LinkTarget>;
  usedIn: DiagramUsedInDto[] | null;
  canEdit: boolean;
  onOpen: (diagramId: string) => void;
  onChange: (elementId: string) => void;
  onRemove: (elementId: string) => void;
  onSelectElement: (elementId: string) => void;
  /** canvas-8uh1.6: the diagram's frames and what each shows. */
  frames?: DiagramFrame[];
  frameContents?: Map<string, FrameContent>;
  onRemoveFrame?: (frameId: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  unavailable: 'Not available',
  deleted: 'Deleted (in the bin)',
  missing: 'Diagram no longer exists',
  checking: 'Checking…',
};

export function LinksPanel({
  links,
  targets,
  usedIn,
  canEdit,
  onOpen,
  onChange,
  onRemove,
  onSelectElement,
  frames = [],
  frameContents,
  onRemoveFrame,
}: LinksPanelProps) {
  return (
    <div className="panel" data-testid="links-panel">
      <div className="panel__body stack links-panel">
        <section className="stack" aria-labelledby="links-from-heading">
          <h2 className="section-label" id="links-from-heading">
            Links from this diagram
          </h2>
          {links.length === 0 ? (
            <p className="meta" data-testid="links-from-empty">
              Nothing here opens another diagram yet.
              {canEdit ? ' Select a shape or group and choose Link to diagram.' : ''}
            </p>
          ) : (
            <ul className="links-panel__list">
              {links.map((link) => {
                const target = targets.get(link.diagramId);
                const available = target?.status === 'available';
                return (
                  <li
                    key={link.elementId}
                    className="links-panel__item"
                    data-testid={`link-row-${link.elementId}`}
                    data-status={target?.status ?? 'checking'}
                  >
                    <button
                      type="button"
                      className="btn btn--tertiary btn--compact links-panel__element"
                      title="Select it on the canvas"
                      aria-label={`${link.label}: select it on the canvas`}
                      onClick={() => onSelectElement(link.elementId)}
                    >
                      {link.label}
                    </button>
                    <span className="links-panel__arrow" aria-hidden="true">
                      →
                    </span>
                    {available ? (
                      <span className="links-panel__target">
                        {target.name}
                        {target.projectName && (
                          <span className="meta"> · {target.projectName}</span>
                        )}
                      </span>
                    ) : (
                      <span
                        className="links-panel__target links-panel__target--broken"
                        title={linkStatusText(target)}
                      >
                        {target?.status !== 'checking' && <Icon name="warning" />}
                        {STATUS_LABEL[target?.status ?? 'checking']}
                      </span>
                    )}
                    <span className="links-panel__actions">
                      {available && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--compact"
                          data-testid={`link-open-${link.elementId}`}
                          aria-label={`Open the diagram ${link.label} links to`}
                          onClick={() => onOpen(link.diagramId)}
                        >
                          Open
                        </button>
                      )}
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            className="btn btn--tertiary btn--compact"
                            data-testid={`link-change-${link.elementId}`}
                            aria-label={`Change the link on ${link.label}`}
                            onClick={() => onChange(link.elementId)}
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            className="btn btn--tertiary btn--compact"
                            data-testid={`link-remove-${link.elementId}`}
                            aria-label={`Remove link from ${link.label}`}
                            onClick={() => onRemove(link.elementId)}
                          >
                            Remove link
                          </button>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {frames.length > 0 && (
          <section className="stack" aria-labelledby="frames-heading">
            <h2 className="section-label" id="frames-heading">
              Embedded diagrams
            </h2>
            <ul className="links-panel__list" data-testid="frames-list">
              {frames.map((frame) => {
                const content = frameContents?.get(frame.diagramId);
                const available = content?.status === 'available';
                return (
                  <li
                    key={frame.id}
                    className="links-panel__item"
                    data-testid={`frame-row-${frame.id}`}
                    data-status={content?.status ?? 'checking'}
                  >
                    {available ? (
                      <span className="links-panel__target">{content.name}</span>
                    ) : (
                      <span className="links-panel__target links-panel__target--broken">
                        {content && <Icon name="warning" />}
                        {content ? frameStatusText(content) : 'Checking…'}
                      </span>
                    )}
                    <span className="links-panel__actions">
                      {available && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--compact"
                          data-testid={`frame-row-open-${frame.id}`}
                          aria-label={`Open ${content.name ?? 'the embedded diagram'}`}
                          onClick={() => onOpen(frame.diagramId)}
                        >
                          Open
                        </button>
                      )}
                      {canEdit && onRemoveFrame && (
                        <button
                          type="button"
                          className="btn btn--tertiary btn--compact"
                          data-testid={`frame-row-remove-${frame.id}`}
                          aria-label={`Remove the frame showing ${content?.name ?? 'a diagram'}`}
                          onClick={() => onRemoveFrame(frame.id)}
                        >
                          Remove frame
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section className="stack" aria-labelledby="used-in-heading">
          <h2 className="section-label" id="used-in-heading">
            Used in
          </h2>
          {usedIn === null ? (
            <p className="meta" role="status">
              Loading…
            </p>
          ) : usedIn.length === 0 ? (
            <p className="meta" data-testid="used-in-empty">
              No other diagram links here or embeds this one.
            </p>
          ) : (
            <ul className="links-panel__list" data-testid="used-in-list">
              {usedIn.map((u) => (
                <li key={u.diagramId} className="links-panel__item links-panel__item--used">
                  <button
                    type="button"
                    className="btn btn--tertiary btn--compact"
                    data-testid={`used-in-open-${u.diagramId}`}
                    onClick={() => onOpen(u.diagramId)}
                  >
                    {u.name}
                  </button>
                  <span className="meta">{u.projectName}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="meta">
            Saved diagrams only: a link appears here once the diagram that has it is saved.
          </p>
        </section>
      </div>
    </div>
  );
}
