import { useEffect, useState } from 'react';
import { api, ApiError, type SubmissionDto, type SubmissionHistoryItemDto } from './api';
import { relativeTime } from './submission-state';
import type { UseSubmission } from './useSubmission';
import { Icon, type IconName } from '../ui/Icon';
import { Modal } from '../ui/Modal';

const CHECK_ICON: Record<string, { icon: IconName; label: string; cls: string }> = {
  success: { icon: 'check', label: 'Passed', cls: 'approval-state--ok' },
  failure: { icon: 'close', label: 'Failed', cls: 'approval-state--bad' },
  pending: { icon: 'history', label: 'Running', cls: 'approval-state--wait' },
};
const checkInfo = (state: string) => CHECK_ICON[state] ?? { icon: 'circle' as IconName, label: state === 'skipped' ? 'Skipped' : 'Neutral', cls: '' };

const REVIEW_LABEL: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested' };
const shortSha = (sha: string) => sha.slice(0, 7);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

export interface ApprovalPanelProps {
  diagramId: string;
  submission: UseSubmission;
  /** Changes after each save so the history list re-reads. */
  refreshToken: number;
}

/** canvas-3s5.2: the editor's Approval tab -- review state, checks, approved version, history. */
export function ApprovalPanel({ diagramId, submission, refreshToken }: ApprovalPanelProps) {
  const { status, syncNow, syncing, setStatus } = submission;
  const [history, setHistory] = useState<SubmissionHistoryItemDto[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const current = status?.current ?? null;
  const open = current?.state === 'open' && !current.withdrawnAt ? current : null;
  const approved = status?.approved ?? null;
  const lastSyncedAt = current?.lastSyncedAt;
  const currentId = current?.id;
  const currentState = current?.state;

  // Keep "Last checked ... ago" honest between polls.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Re-read history on a save, and whenever the latest PR changes state or gets a new push.
  useEffect(() => {
    let cancelled = false;
    api
      .listSubmissions(diagramId)
      .then(({ submissions }) => {
        if (!cancelled) {
          setHistory(submissions);
          setHistoryError(false);
        }
      })
      .catch(() => !cancelled && setHistoryError(true));
    return () => {
      cancelled = true;
    };
  }, [diagramId, refreshToken, currentId, currentState, current?.lastSubmittedAt, current?.withdrawnAt]);

  if (!status) return <p className="state" data-testid="approval-loading">Loading…</p>;

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.withdrawSubmission(diagramId));
      setWithdrawing(false);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'not_open' ? 'This pull request is no longer open.' : (err as Error).message);
      if (err instanceof ApiError && err.status === 409) {
        setWithdrawing(false);
        await submission.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const detail = open?.statusDetail ?? null;
  const reviewsText = (s: SubmissionDto) =>
    s.reviewState === 'approved' ? 'Approved' : s.reviewState === 'changes_requested' ? 'Changes requested' : s.reviewState === 'pending' ? 'Waiting for review' : 'No reviews yet';

  return (
    <div className="stack approval" data-testid="approval-panel">
      {!current && !approved && (
        <p className="state" data-testid="approval-empty">
          This diagram has not been submitted for approval yet.
        </p>
      )}

      {current && (
        <section className="card stack" aria-labelledby="approval-current-heading" data-testid="approval-current">
          <h2 id="approval-current-heading" className="section-label">
            {open ? 'Open pull request' : current.withdrawnAt ? 'Withdrawn pull request' : 'Latest pull request'}
          </h2>
          <p>
            <a href={current.prUrl} target="_blank" rel="noopener noreferrer" data-testid="approval-pr-link">
              PR #{current.prNumber} on {current.repoFullName}
            </a>{' '}
            <span className="meta" data-testid="approval-pr-state">
              {current.withdrawnAt ? 'withdrawn' : current.state}
            </span>
          </p>
          <dl className="approval__facts">
            <dt>Branch</dt>
            <dd className="mono">{current.branch}</dd>
            <dt>Path</dt>
            <dd className="mono">{current.path}</dd>
            {current.withdrawnAt && (
              <>
                <dt>Withdrawn</dt>
                <dd data-testid="approval-withdrawn">
                  {when(current.withdrawnAt)}
                  {current.withdrawnBy ? ` by ${current.withdrawnBy}` : ''}
                </dd>
              </>
            )}
          </dl>

          {open && (
            <>
              <div data-testid="approval-reviews">
                <h3 className="section-label">Reviewers</h3>
                <p data-testid="approval-review-summary">{reviewsText(open)}</p>
                {detail && (detail.reviews.length > 0 || detail.requestedReviewers.length > 0) ? (
                  <ul>
                    {detail.reviews.map((r) => (
                      <li key={`r-${r.login}`} data-testid={`approval-review-${r.login}`}>
                        @{r.login} <strong>{REVIEW_LABEL[r.state] ?? r.state}</strong>
                      </li>
                    ))}
                    {detail.requestedReviewers.map((login) => (
                      <li key={`q-${login}`} data-testid={`approval-requested-${login}`}>
                        @{login} <span className="meta">review requested</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="meta">No reviewers have been requested.</p>
                )}
              </div>

              <div data-testid="approval-checks">
                <h3 className="section-label">Checks</h3>
                {detail && detail.checks.length > 0 ? (
                  <ul className="approval__checks">
                    {detail.checks.map((c) => {
                      const info = checkInfo(c.state);
                      return (
                        <li key={c.name} data-testid={`approval-check-${c.name}`} data-state={c.state}>
                          <span className={`approval-state ${info.cls}`}>
                            <Icon name={info.icon} size={12} />
                            <span className="visually-hidden">{info.label}: </span>
                          </span>{' '}
                          {c.url ? (
                            <a href={c.url} target="_blank" rel="noopener noreferrer">
                              {c.name}
                            </a>
                          ) : (
                            c.name
                          )}{' '}
                          <span className="meta">{info.label.toLowerCase()}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="meta">{open.checksState === 'unavailable' ? 'Checks are not available for this repository.' : 'No checks reported.'}</p>
                )}
              </div>

              <div className="row">
                <span className="meta" data-testid="approval-last-checked">
                  Last checked {relativeTime(lastSyncedAt)}
                </span>
                <span className="spacer" />
                <button type="button" className="btn btn--secondary btn--compact" data-testid="approval-refresh" disabled={syncing} onClick={() => void syncNow()}>
                  {syncing ? 'Checking…' : 'Refresh'}
                </button>
              </div>
              {open.lastSyncError && (
                <p role="status" className="state state--error" data-testid="approval-sync-error">
                  <Icon name="warning" className="state__icon" />
                  Could not read the latest status from GitHub: {open.lastSyncError}
                </p>
              )}
              {status.canWithdraw && (
                <div>
                  <button
                    type="button"
                    className="btn btn--tertiary-danger btn--compact"
                    data-testid="approval-withdraw"
                    onClick={() => {
                      setError(null);
                      setWithdrawing(true);
                    }}
                  >
                    Withdraw submission
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {approved && (
        <section className="card stack" aria-labelledby="approval-approved-heading" data-testid="approval-approved">
          <h2 id="approval-approved-heading" className="section-label">
            Approved version
          </h2>
          <p>
            <strong>Version {approved.submittedVersionSequence}</strong>
            {approved.mergedBy ? <> merged by @{approved.mergedBy}</> : ' merged'}
            {approved.mergedAt && <> on {when(approved.mergedAt)}</>}
          </p>
          <p>
            <a href={approved.prUrl} target="_blank" rel="noopener noreferrer" data-testid="approval-approved-link">
              PR #{approved.prNumber} on {approved.repoFullName}
            </a>
          </p>
          {approved.mergedHeadMatches === false && (
            <p role="alert" className="state state--error" data-testid="approval-head-mismatch">
              <Icon name="warning" className="state__icon" />
              Merged with changes made on GitHub — the approved files differ from what Canvas submitted.
            </p>
          )}
        </section>
      )}

      <section className="stack" aria-labelledby="approval-history-heading" data-testid="approval-history">
        <h2 id="approval-history-heading" className="section-label">
          Submission history
        </h2>
        {historyError ? (
          <p className="meta" data-testid="approval-history-error">Could not load the history.</p>
        ) : history === null ? (
          <p className="meta">Loading…</p>
        ) : history.length === 0 ? (
          <p className="meta" data-testid="approval-history-empty">No submissions yet.</p>
        ) : (
          <ul className="stack">
            {history.map((s) => (
              <li key={s.id} className="card" data-testid={`approval-history-item-${s.id}`}>
                <p>
                  <a href={s.prUrl} target="_blank" rel="noopener noreferrer">
                    PR #{s.prNumber}
                  </a>{' '}
                  <span className="meta">{s.withdrawnAt ? 'withdrawn' : s.state === 'merged' ? 'merged' : s.state}</span>
                </p>
                <ul>
                  {s.pushes.map((p) => (
                    <li key={`${p.versionSequence}-${p.commitSha}`} className="meta">
                      Version {p.versionSequence} · <span className="mono">{shortSha(p.commitSha)}</span>
                      {p.pushedBy ? ` · ${p.pushedBy}` : ''} · {when(p.pushedAt)}
                      {p.warningCount > 0 ? ` · ${p.warningCount} warning${p.warningCount === 1 ? '' : 's'}` : ''}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      {withdrawing && (
        <Modal
          label="Withdraw submission"
          role="alertdialog"
          testId="approval-withdraw-confirm"
          onClose={() => setWithdrawing(false)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="approval-withdraw-cancel" onClick={() => setWithdrawing(false)}>
                Keep open
              </button>
              <button type="button" className="btn btn--danger" data-testid="approval-withdraw-confirm-button" disabled={busy} onClick={() => void withdraw()}>
                {busy ? 'Withdrawing…' : 'Withdraw'}
              </button>
            </>
          }
        >
          <p>
            Withdraw this submission? Pull request #{open?.prNumber} is closed on GitHub and the diagram goes back to not being in review. You can
            submit it again later.
          </p>
          {error && (
            <p role="alert" className="field__error" data-testid="approval-withdraw-error">
              {error}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
