import { Icon } from '../ui/Icon';

export interface Violation {
  elementId: string;
  rule: string;
  message: string;
  severity: string;
}

export interface ViolationsPanelProps {
  violations: Violation[];
}

/**
 * FR-013/FR-024: shows every standards violation for the current diagram, specific to the
 * element and rule involved — never a generic pass/fail. Soft-flag only: this never blocks
 * saving or exporting, it's purely informational.
 */
export function ViolationsPanel({ violations }: ViolationsPanelProps) {
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
  return (
    <div className="panel" data-testid="violations-panel" role="status">
      <div className="panel__header">
        {violations.length} standards violation{violations.length === 1 ? '' : 's'}
      </div>
      <ul className="panel__body panel__body--flush violation-list">
        {violations.map((violation, index) => (
          <li
            key={index}
            className="violation"
            data-testid="violation-item"
            data-element-id={violation.elementId}
            data-rule={violation.rule}
          >
            <Icon name="warning" className="violation__icon" />
            <span>
              <span className="mono">{violation.elementId}</span>
              <span className="section-label violation__rule">{violation.rule}</span>
              <span className="violation__message">{violation.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
