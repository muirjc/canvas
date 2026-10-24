import { useState } from 'react';
import type { Violation } from '@canvas/diagram-core';
import { api, ApiError, type SubmitResultDto } from './api';
import type { UseSubmission } from './useSubmission';
import { deriveChip, deriveSubmitButton, isSubmitVisible } from './submission-state';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

export interface SubmitForApprovalProps {
  diagramId: string;
  hasUnsavedChanges: boolean;
  /** Shared with the Approval tab (see useSubmission), which also owns polling. */
  submission: UseSubmission;
}

/**
 * canvas-3s5.1: the doc bar's "Submit for approval" button and status chip. Renders nothing at
 * all unless GitHub is enabled and the diagram's project is linked, so non-GitHub users see no
 * change. Phase 2: status and polling live in useSubmission.
 */
export function SubmitForApproval({ diagramId, hasUnsavedChanges, submission }: SubmitForApprovalProps) {
  const { status, reload: refresh } = submission;
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mustFix, setMustFix] = useState<Violation[]>([]);
  const [result, setResult] = useState<SubmitResultDto | null>(null);

  if (!isSubmitVisible(status)) return null;
  const button = deriveSubmitButton(status, hasUnsavedChanges);
  const chip = deriveChip(status);
  const link = status.link!;
  const current = status.current?.state === 'open' ? status.current : null;

  const closeConfirm = () => {
    setConfirming(false);
    setError(null);
    setMustFix([]);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setMustFix([]);
    try {
      const outcome = await api.submitDiagram(diagramId);
      setResult(outcome);
      setConfirming(false);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'must_fix' && Array.isArray(err.details)) {
        setMustFix(err.details as Violation[]);
      }
      setError(err instanceof ApiError ? err.message : (err as Error).message);
      if (err instanceof ApiError && err.status === 409) void refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const chipContent =
    chip.kind === 'not-submitted' ? (
      chip.label
    ) : (
      <a href={chip.prUrl} target="_blank" rel="noopener noreferrer" data-testid="submission-chip-link">
        {chip.label}
      </a>
    );

  return (
    <>
      <span className={`submission-chip submission-chip--${chip.kind}`} data-testid="submission-chip" data-state={chip.kind}>
        {chipContent}
      </span>
      <button
        type="button"
        className="btn btn--secondary btn--compact"
        data-testid="submission-submit"
        disabled={button.disabled}
        title={button.reason ?? undefined}
        aria-describedby={button.reason ? 'submission-submit-reason' : undefined}
        onClick={() => setConfirming(true)}
      >
        <Icon name="upload" />
        {button.label}
      </button>
      {button.reason && (
        <span id="submission-submit-reason" className="visually-hidden">
          {button.reason}
        </span>
      )}

      {confirming && (
        <Modal
          label={button.label}
          testId="submission-confirm"
          onClose={closeConfirm}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="submission-cancel" onClick={closeConfirm}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary" data-testid="submission-confirm-submit" disabled={submitting} onClick={() => void submit()}>
                {submitting ? 'Submitting…' : button.label}
              </button>
            </>
          }
        >
          <dl>
            <dt>Repository</dt>
            <dd data-testid="submission-confirm-repo">{link.repoFullName}</dd>
            <dt>Branch</dt>
            <dd>{current ? `PR #${current.prNumber} (${current.branch})` : `new branch, opened against ${link.baseBranch}`}</dd>
            <dt>Folder</dt>
            <dd className="mono" data-testid="submission-confirm-path">
              {current ? current.path : link.folder}
            </dd>
          </dl>
          <p data-testid="submission-confirm-action">
            {current
              ? `This pushes the saved diagram as a new commit to open pull request #${current.prNumber}.`
              : 'This opens a new pull request for review. Merging it records the diagram as approved.'}
          </p>
          <p className="meta" data-testid="submission-confirm-warnings">
            {status.canSubmit.warningCount === 0
              ? 'No warnings will be listed in the pull request.'
              : `${status.canSubmit.warningCount} warning${status.canSubmit.warningCount === 1 ? '' : 's'} will be listed in the pull request.`}
          </p>
          {error && (
            <div role="alert" className="field__error" data-testid="submission-error">
              <p>{error}</p>
              {mustFix.length > 0 && (
                <ul data-testid="submission-violations">
                  {mustFix.map((v, i) => (
                    <li key={`${v.elementId}-${v.rule}-${i}`}>{v.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Modal>
      )}

      {result && (
        <Modal
          label="Submission result"
          title={
            result.outcome === 'created'
              ? `Created pull request #${result.submission.prNumber}`
              : result.outcome === 'updated'
                ? `Updated pull request #${result.submission.prNumber}`
                : 'Already up to date'
          }
          testId="submission-result"
          onClose={() => setResult(null)}
          footer={
            <button type="button" className="btn btn--primary" data-testid="submission-result-close" onClick={() => setResult(null)}>
              Close
            </button>
          }
        >
          <p data-testid="submission-result-message">
            {result.outcome === 'upToDate'
              ? `Nothing has changed since the last submission, so pull request #${result.submission.prNumber} was left as it is.`
              : result.outcome === 'created'
                ? `A pull request was opened in ${result.submission.repoFullName}.`
                : `A new commit was pushed to the open pull request in ${result.submission.repoFullName}.`}
          </p>
          <p>
            <a href={result.submission.prUrl} target="_blank" rel="noopener noreferrer" data-testid="submission-result-link">
              Open pull request #{result.submission.prNumber} on GitHub
            </a>
          </p>
        </Modal>
      )}
    </>
  );
}
