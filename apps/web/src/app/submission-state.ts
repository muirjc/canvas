import type { SubmissionStatusDto } from './api';

/** What the doc bar shows for a diagram's approval state (canvas-3s5.1; Phase 2 enriches it). */
export type SubmissionChip =
  | { kind: 'not-submitted'; label: string }
  | { kind: 'in-review'; label: string; prNumber: number; prUrl: string }
  | { kind: 'changed'; label: string; prNumber: number; prUrl: string }
  | { kind: 'approved'; label: string; prUrl: string }
  | { kind: 'rejected'; label: string; prUrl: string };

export function deriveChip(status: SubmissionStatusDto): SubmissionChip {
  const current = status.current;
  if (!current) return { kind: 'not-submitted', label: 'Not submitted' };
  if (current.state === 'merged') {
    return { kind: 'approved', label: `Approved (version ${current.submittedVersionSequence})`, prUrl: current.prUrl };
  }
  if (current.state === 'closed') return { kind: 'rejected', label: 'Rejected', prUrl: current.prUrl };
  if (status.changesSinceSubmitting) {
    return { kind: 'changed', label: 'Changes since submitting', prNumber: current.prNumber, prUrl: current.prUrl };
  }
  return { kind: 'in-review', label: `In review · PR #${current.prNumber}`, prNumber: current.prNumber, prUrl: current.prUrl };
}

/** The button is hidden unless GitHub is on and the diagram's project is linked. */
export function isSubmitVisible(status: SubmissionStatusDto | null): status is SubmissionStatusDto {
  return Boolean(status && status.enabled && status.link);
}

export interface SubmitButtonState {
  label: string;
  disabled: boolean;
  /** Why it is disabled (shown as the tooltip and linked via aria-describedby). */
  reason: string | null;
  /** True when the push goes to an already-open pull request. */
  updatesOpenPr: boolean;
}

export function deriveSubmitButton(status: SubmissionStatusDto, hasUnsavedChanges: boolean): SubmitButtonState {
  const open = status.current?.state === 'open' ? status.current : null;
  const label = open ? `Push update to PR #${open.prNumber}` : 'Submit for approval';
  let reason: string | null = null;
  if (status.canSubmit.reason === 'no_edit_access') {
    reason = 'You need edit access to submit this diagram.';
  } else if (hasUnsavedChanges) {
    reason = 'Save your changes first — only the saved version is submitted.';
  } else if (status.canSubmit.reason === 'must_fix') {
    const n = status.canSubmit.mustFixCount;
    reason = `Fix ${n} must-fix issue${n === 1 ? '' : 's'} before submitting — see the Issues tab.`;
  } else if (!status.canSubmit.allowed) {
    reason = 'This diagram cannot be submitted right now.';
  }
  return { label, disabled: reason !== null, reason, updatesOpenPr: open !== null };
}

/** Where a diagram's files land for a folder, mirroring the server's slug rule (preview only). */
export function previewPath(folder: string, diagramName = '<diagram-name>'): string {
  const clean = folder.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return `${clean || '<folder>'}/${diagramName}/README.md`;
}
