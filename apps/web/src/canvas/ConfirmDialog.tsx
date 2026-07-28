import { Modal } from '../ui/Modal';

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
    <Modal
      // `alertdialog` must be passed explicitly: <dialog> implies `dialog`, which would quietly
      // downgrade this control's semantics (contracts/ui-contract.md §2).
      role="alertdialog"
      label="Confirm action"
      title={null}
      testId="confirm-dialog"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--secondary" data-testid="confirm-dialog-cancel" onClick={onCancel}>
            Cancel
          </button>
          {/* Danger variant, and the message names the object being affected (FR-018). */}
          <button type="button" className="btn btn--danger" data-testid="confirm-dialog-confirm" onClick={onConfirm}>
            Confirm
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
