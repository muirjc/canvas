import { useEffect, useRef, type ReactNode } from 'react';

export interface ModalProps {
  /** Accessible name for the dialog. */
  label: string;
  /** Visible title. Defaults to `label`; pass `null` to omit the header entirely. */
  title?: ReactNode;
  /** `alertdialog` for destructive confirmations. Must be set explicitly — `<dialog>` implies
   *  `dialog`, which would silently downgrade ConfirmDialog's existing semantics. */
  role?: 'dialog' | 'alertdialog';
  /** Widen for content-heavy dialogs (Import, Share). */
  wide?: boolean;
  testId?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Modal dialog built on the native `<dialog>` element.
 *
 * `showModal()` gives us, natively and correctly: focus moved into the dialog, focus trapped
 * while open, background content made inert, Escape dismissal, and a `::backdrop` for the scrim.
 * That is the whole of FR-017 without hand-written key handling — using the platform capability
 * rather than reimplementing it (research §3, Constitution VI).
 *
 * The one thing that must be wired by hand is the `cancel` event: when the browser closes the
 * dialog natively (Escape), React state would otherwise still believe it is open, and the
 * dialog could never be reopened.
 */
export function Modal({
  label,
  title,
  role = 'dialog',
  wide = false,
  testId,
  onClose,
  children,
  footer,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    // Capture the opener before showModal moves focus. Native focus restoration is unreliable
    // here because React unmounts the <dialog> on close, so we restore explicitly on unmount —
    // the browser still provides the actual focus trap, inertness, and Escape handling.
    openerRef.current = document.activeElement as HTMLElement | null;

    // Opening via showModal (rather than the `open` attribute) is what activates focus
    // trapping, inertness, and ::backdrop. The `open` attribute alone gives none of it.
    if (!dialog.open) dialog.showModal();

    // Deliberately NOT preventDefault: the native close is what restores focus to the control
    // that opened the dialog. Suppressing it and unmounting from React instead leaves focus on
    // <body>, silently failing FR-017's last clause. We only mirror the close into React state.
    const handleCancel = () => onClose();
    dialog.addEventListener('cancel', handleCancel);

    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      // Closing before unmount matters for the button-driven path (Cancel/Confirm), where React
      // would otherwise rip a still-open modal out of the DOM and strand focus.
      if (dialog.open) dialog.close();
      // Return focus to whatever opened us (FR-017). Guard against the opener having been
      // removed meanwhile — e.g. a dialog whose confirm action replaces the whole screen.
      const opener = openerRef.current;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [onClose]);

  const heading = title === undefined ? label : title;

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' modal--wide' : ''}`}
      role={role}
      aria-label={label}
      aria-modal="true"
      data-testid={testId}
    >
      {heading !== null && (
        <div className="modal__header">
          <h2 className="modal__title">{heading}</h2>
        </div>
      )}
      <div className="modal__body">{children}</div>
      {footer && <div className="modal__footer">{footer}</div>}
    </dialog>
  );
}
