import { useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';

export interface ExpandingTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> {
  value: string;
  /** Rows while idle. */
  collapsedRows?: number;
  /** Stay expanded even without focus -- pass "has unsaved changes", so the box doesn't shrink
   *  (and move the Save button) the moment the user clicks Save. */
  keepOpen?: boolean;
}

/**
 * canvas-cyq: a textarea that is compact while idle and grows to fit its content while someone is
 * working in it (focused, or holding unsaved changes) -- up to 70% of the window, then it scrolls
 * inside. Esc leaves it (collapsing it when there's nothing unsaved). The user's resize handle
 * still works.
 */
export function ExpandingTextarea({ collapsedRows = 3, keepOpen = false, value, onFocus, onBlur, onKeyDown, ...rest }: ExpandingTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const expanded = focused || keepOpen;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!expanded) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    const borders = el.offsetHeight - el.clientHeight;
    const max = Math.round(window.innerHeight * 0.7);
    el.style.height = `${Math.min(el.scrollHeight + borders, max)}px`;
  }, [expanded, value]);

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={collapsedRows}
      value={value}
      data-expanded={expanded ? 'true' : 'false'}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.currentTarget.blur();
        onKeyDown?.(e);
      }}
    />
  );
}
