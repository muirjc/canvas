import type { Severity, StandardRules, Violation } from '@canvas/diagram-core';
import { Icon } from '../ui/Icon';

export type { Violation };

export interface ViolationsPanelProps {
  violations: Violation[];
  /** canvas-tfr: used to show element kinds by their label rather than their id. */
  rules?: StandardRules;
  /** canvas-tfr: selects the offending element on the canvas. Diagram-level issues aren't clickable. */
  onSelectElement?: (elementId: string) => void;
  /** True while the list reflects live edits rather than the last saved check. */
  live?: boolean;
}

const SEVERITY_ORDER: Severity[] = ['error', 'warning', 'info'];
const SEVERITY_LABEL: Record<Severity, string> = { error: 'Must fix', warning: 'Warning', info: 'Info' };

function severityOf(v: Violation): Severity {
  return (SEVERITY_ORDER as string[]).includes(v.severity) ? v.severity : 'warning';
}

/**
 * FR-013/FR-024: shows every standards violation for the current diagram, specific to the
 * element and rule involved — never a generic pass/fail. Soft-flag only: this never blocks
 * saving or exporting, it's purely informational ("Must fix" included).
 *
 * canvas-tfr: grouped by severity, labelled with the element kind, and each element-level issue
 * selects that element on the canvas.
 */
export function ViolationsPanel({ violations, rules, onSelectElement, live }: ViolationsPanelProps) {
  if (violations.length === 0) {
    return (
      <div className="panel">
        <div className="panel__body">
          <p className="state state--success" data-testid="violations-panel-empty">
            <Icon name="check" className="state__icon" />
            No standards violations.
          </p>
        </div>
      </div>
    );
  }
  const kindLabel = (kindId?: string) => (kindId ? rules?.elementKinds?.find((k) => k.id === kindId)?.label ?? kindId : undefined);
  const groups = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: violations.filter((v) => severityOf(v) === severity),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="panel" data-testid="violations-panel" role="status">
      <div className="panel__header">
        {violations.length} standards violation{violations.length === 1 ? '' : 's'}
        {live && <span className="meta"> · live</span>}
      </div>
      <div className="panel__body panel__body--flush">
        {groups.map((group) => (
          <section key={group.severity} data-testid={`violations-group-${group.severity}`}>
            <h3 className="section-label violation-group__label">
              {SEVERITY_LABEL[group.severity]} ({group.items.length})
            </h3>
            <ul className="violation-list">
              {group.items.map((violation, index) => {
                const clickable = Boolean(onSelectElement) && violation.elementType !== 'diagram' && violation.elementId !== '(diagram)';
                const content = (
                  <>
                    <Icon name="warning" className={`violation__icon violation__icon--${group.severity}`} />
                    <span>
                      {violation.elementId !== '(diagram)' && <span className="mono">{violation.elementId}</span>}
                      {violation.kindId && <span className="meta"> {kindLabel(violation.kindId)}</span>}
                      <span className="section-label violation__rule">{violation.rule}</span>
                      <span className="violation__message">{violation.message}</span>
                    </span>
                  </>
                );
                return (
                  <li
                    key={`${violation.elementId}-${violation.rule}-${index}`}
                    className={`violation violation--${group.severity}`}
                    data-testid="violation-item"
                    data-element-id={violation.elementId}
                    data-rule={violation.rule}
                    data-severity={group.severity}
                  >
                    {clickable ? (
                      <button
                        type="button"
                        className="violation__select"
                        data-testid={`violation-select-${violation.elementId}`}
                        title="Select this element on the canvas"
                        onClick={() => onSelectElement!(violation.elementId)}
                      >
                        {content}
                      </button>
                    ) : (
                      content
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
