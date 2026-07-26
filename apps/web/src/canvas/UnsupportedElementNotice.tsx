import type { ParseError } from '@canvas/diagram-core';

export interface UnsupportedElementNoticeProps {
  errors: ParseError[];
}

/**
 * FR-005 / FR-019: surfaces exactly which line/content could not be interpreted, instead of
 * silently dropping unsupported elements or showing a generic failure message.
 */
export function UnsupportedElementNotice({ errors }: UnsupportedElementNoticeProps) {
  if (errors.length === 0) return null;
  return (
    <div role="alert" data-testid="unsupported-element-notice" style={{ color: '#b00020' }}>
      <p>The DSL could not be applied — the following could not be interpreted:</p>
      <ul>
        {errors.map((error, index) => (
          <li key={index} data-testid="unsupported-element-item">
            Line {error.line}: <code>{error.content}</code> — {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
