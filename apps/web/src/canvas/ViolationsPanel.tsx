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
      <p data-testid="violations-panel-empty" style={{ color: '#2e7d32' }}>
        No standards violations.
      </p>
    );
  }
  return (
    <div data-testid="violations-panel" role="status">
      <p>
        {violations.length} standards violation{violations.length === 1 ? '' : 's'}:
      </p>
      <ul>
        {violations.map((violation, index) => (
          <li key={index} data-testid="violation-item" data-element-id={violation.elementId} data-rule={violation.rule}>
            <strong>{violation.elementId}</strong> ({violation.rule}): {violation.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
