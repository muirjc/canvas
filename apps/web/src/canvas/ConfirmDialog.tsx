export interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Small reusable confirmation control (research.md §3, feature 002): a custom in-app dialog
 * rather than `window.confirm()`, consistent with every other interactive surface in this app
 * and testable/auditable by the same axe-core pass the rest of the UI goes through.
 */
export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Confirm action" data-testid="confirm-dialog">
      <p>{message}</p>
      <button type="button" data-testid="confirm-dialog-confirm" onClick={onConfirm}>
        Confirm
      </button>
      <button type="button" data-testid="confirm-dialog-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
