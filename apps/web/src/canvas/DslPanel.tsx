import { useEffect, useMemo, useRef, useState } from 'react';
import { getDslFamily, isParseSuccess, validate, type ParseError, type StandardRules, type Violation } from '@canvas/diagram-core';
import { UnsupportedElementNotice } from './UnsupportedElementNotice';
import { findElementLine, lineRange } from '../standards/locate-in-dsl';

export interface DslPanelProps {
  dsl: string;
  parseErrors: ParseError[];
  onApply: (dslText: string) => void;
  /** canvas-tfr: the active standard -- the draft text is checked against it as you type. */
  rules?: StandardRules;
  dslFamily?: string;
}

const SEVERITY_LABEL: Record<string, string> = { error: 'Must fix', warning: 'Warning', info: 'Info' };

/** Editable Mermaid DSL text panel (FR-003): edits here update the canvas via onApply. */
export function DslPanel({ dsl, parseErrors, onApply, rules, dslFamily }: DslPanelProps) {
  const [draft, setDraft] = useState(dsl);
  const [checkedDraft, setCheckedDraft] = useState(dsl);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the draft in sync when the canvas changes the model (and thus the derived DSL),
  // but don't clobber in-progress typing.
  useEffect(() => {
    setDraft(dsl);
  }, [dsl]);

  // canvas-tfr: debounce so the check runs when typing pauses, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setCheckedDraft(draft), 300);
    return () => clearTimeout(timer);
  }, [draft]);

  // canvas-tfr: the "code" channel of standards enforcement -- hand-written DSL is never blocked
  // (Apply and Save stay enabled), but whatever breaks the standard is flagged with its line.
  const standardIssues = useMemo((): { violation: Violation; line?: number }[] | undefined => {
    if (!rules || !dslFamily) return undefined;
    const family = getDslFamily(dslFamily);
    if (!family) return undefined;
    const parsed = family.parse(checkedDraft);
    if (!isParseSuccess(parsed)) return undefined;
    return validate(parsed.model, rules).map((violation) => ({
      violation,
      line: violation.elementId === '(diagram)' ? undefined : findElementLine(checkedDraft, violation.elementId, parsed.model),
    }));
  }, [rules, dslFamily, checkedDraft]);

  const selectLine = (line: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end } = lineRange(draft, line);
    textarea.focus();
    textarea.setSelectionRange(start, end);
  };

  return (
    <div className="panel">
      <div className="panel__body panel__body--flush dsl-panel">
        <textarea
          ref={textareaRef}
          className="dsl-panel__editor"
          data-testid="dsl-panel"
          aria-label="Mermaid DSL for this diagram"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
        <UnsupportedElementNotice errors={parseErrors} />
        {standardIssues && standardIssues.length > 0 && (
          <div className="dsl-standards" data-testid="dsl-standards-check" role="status">
            <p className="section-label">Standards check ({standardIssues.length})</p>
            <ul className="violation-list">
              {standardIssues.map(({ violation, line }, index) => (
                <li
                  key={`${violation.elementId}-${violation.rule}-${index}`}
                  className={`violation violation--${violation.severity}`}
                  data-testid="dsl-standards-issue"
                  data-rule={violation.rule}
                  data-line={line ?? ''}
                >
                  {line !== undefined ? (
                    <button
                      type="button"
                      className="violation__select"
                      data-testid={`dsl-standards-line-${line}`}
                      title={`Select line ${line}`}
                      onClick={() => selectLine(line)}
                    >
                      <span className="mono">L{line}</span>
                      <span>
                        <span className="section-label violation__rule">
                          {SEVERITY_LABEL[violation.severity] ?? violation.severity} · {violation.rule}
                        </span>
                        <span className="violation__message">{violation.message}</span>
                      </span>
                    </button>
                  ) : (
                    <span>
                      <span className="section-label violation__rule">
                        {SEVERITY_LABEL[violation.severity] ?? violation.severity} · {violation.rule}
                      </span>
                      <span className="violation__message">{violation.message}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="panel__footer">
        <button
          type="button"
          className="btn btn--primary btn--compact"
          data-testid="apply-dsl"
          onClick={() => onApply(draft)}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
