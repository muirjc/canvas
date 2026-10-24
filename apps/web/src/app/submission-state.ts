import type { SubmissionBadgeDto, SubmissionStatusDto } from './api';

/** What the doc bar shows for a diagram's approval state (canvas-3s5.1; Phase 2 enriches it). */
export type SubmissionChip =
  | { kind: 'not-submitted'; label: string }
  | { kind: 'in-review'; label: string; prNumber: number; prUrl: string }
  | { kind: 'changed'; label: string; prNumber: number; prUrl: string }
  | { kind: 'approved'; label: string; prUrl: string }
  | { kind: 'rejected'; label: string; prUrl: string }
  | { kind: 'withdrawn'; label: string; prUrl: string };

/** Compact review/check phrases for an open pull request ("changes requested", "checks failing"). */
export function reviewChecksPhrases(reviewState: string | null | undefined, checksState: string | null | undefined): string[] {
  const parts: string[] = [];
  if (reviewState === 'changes_requested') parts.push('changes requested');
  else if (reviewState === 'approved') parts.push('approved, not merged');
  if (checksState === 'failure') parts.push('checks failing');
  else if (checksState === 'pending') parts.push('checks running');
  else if (checksState === 'success' && reviewState !== 'approved') parts.push('checks passing');
  return parts;
}

export function deriveChip(status: SubmissionStatusDto): SubmissionChip {
  const current = status.current;
  if (!current) return { kind: 'not-submitted', label: 'Not submitted' };
  if (current.withdrawnAt) return { kind: 'withdrawn', label: 'Withdrawn', prUrl: current.prUrl };
  if (current.state === 'merged') {
    return { kind: 'approved', label: `Approved (version ${current.submittedVersionSequence})`, prUrl: current.prUrl };
  }
  if (current.state === 'closed') return { kind: 'rejected', label: 'Rejected', prUrl: current.prUrl };
  if (status.changesSinceSubmitting) {
    return { kind: 'changed', label: 'Changes since submitting', prNumber: current.prNumber, prUrl: current.prUrl };
  }
  const label = ['In review', `PR #${current.prNumber}`, ...reviewChecksPhrases(current.reviewState, current.checksState)].join(' · ');
  return { kind: 'in-review', label, prNumber: current.prNumber, prUrl: current.prUrl };
}

/** The project page's per-diagram badge, from GET /projects/:id/submission-statuses. */
export function deriveBadge(b: SubmissionBadgeDto): { kind: SubmissionChip['kind']; label: string } {
  if (b.withdrawn) return { kind: 'withdrawn', label: 'Withdrawn' };
  if (b.state === 'merged') return { kind: 'approved', label: `Approved v${b.submittedVersionSequence ?? '?'}` };
  if (b.state === 'closed') return { kind: 'rejected', label: 'Rejected' };
  if (b.changesSinceSubmitting) return { kind: 'changed', label: 'Changes since submitting' };
  return { kind: 'in-review', label: 'In review' };
}

/** Polling runs only while a pull request is open (and the tab is visible; checked by the hook). */
export function shouldPoll(status: SubmissionStatusDto | null): boolean {
  return Boolean(status && status.enabled && status.link && status.current?.state === 'open' && !status.current.withdrawnAt);
}

/** The Approval tab shows only when GitHub is on and the project is linked or the diagram has history. */
export function isApprovalTabVisible(status: SubmissionStatusDto | null, hasHistory = false): boolean {
  return Boolean(status && status.enabled && (status.link || status.current || status.approved || hasHistory));
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
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
