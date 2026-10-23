import { useState } from 'react';
import { ExpandingTextarea, type ExpandingTextareaProps } from './ExpandingTextarea';
import { Icon } from './Icon';
import { Modal } from './Modal';

export interface ExpandableTextFieldProps extends ExpandingTextareaProps {
  /** Names the box for the Expand button and the editor's title, e.g. "System prompt for Ada". */
  label: string;
  /** Base for the test ids: `<testId>` (the box), `<testId>-expand`, `<testId>-editor`,
   *  `<testId>-editor-text`, `<testId>-editor-save`, `<testId>-editor-done`. */
  testId: string;
  /** When given, the editor offers Save (the same save as the page's own button). Boxes for
   *  something not created yet (it needs other fields) only get Done. */
  onSave?: () => void;
  saveDisabled?: boolean;
  saving?: boolean;
}

/**
 * canvas-cyq: an ExpandingTextarea (compact at rest, grows while in use) plus an Expand button
 * that opens the same text in a large editor -- for long persona prompts and reference material.
 * Both edit the one value, so nothing is lost switching between them.
 */
export function ExpandableTextField({ label, testId, onSave, saveDisabled, saving, onChange, value, ...rest }: ExpandableTextFieldProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  return (
    <div className="expandable-field">
      <ExpandingTextarea {...rest} data-testid={testId} aria-label={rest['aria-label'] ?? (rest.id ? undefined : label)} value={value} onChange={onChange} />
      <button
        type="button"
        className="btn btn--secondary btn--compact expandable-field__expand"
        data-testid={`${testId}-expand`}
        aria-label={`Expand: ${label}`}
        title="Open in a larger editor"
        onClick={() => setEditorOpen(true)}
      >
        <Icon name="expand" />
        Expand
      </button>
      {editorOpen && (
        <Modal
          label={label}
          wide
          testId={`${testId}-editor`}
          onClose={() => setEditorOpen(false)}
          footer={
            <>
              <span className="meta" aria-live="polite">
                {value.length.toLocaleString()} characters
              </span>
              {onSave && (
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid={`${testId}-editor-save`}
                  disabled={saveDisabled || saving}
                  onClick={onSave}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
              <button type="button" className="btn btn--secondary" data-testid={`${testId}-editor-done`} onClick={() => setEditorOpen(false)}>
                Done
              </button>
            </>
          }
        >
          <textarea
            className="expandable-field__editor"
            data-testid={`${testId}-editor-text`}
            aria-label={label}
            value={value}
            onChange={onChange}
            autoFocus
          />
        </Modal>
      )}
    </div>
  );
}
