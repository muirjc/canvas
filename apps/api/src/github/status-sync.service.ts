import { getDb } from '../db/client.js';
import {
  GitHubAccessError,
  GitHubApiError,
  GitHubRateLimitError,
  SUBMIT_PERMISSIONS,
  type CheckSummary,
  type GitHubClient,
  type ReviewSummary,
} from './github-client.js';
import { recordPullState } from './submission.service.js';

/**
 * canvas-3s5.2: keeps Canvas's view of each open pull request current -- merged (approved),
 * closed (rejected), or still open with its review and check state. Canvas polls (webhooks can't
 * reach it behind the IP allow-list): on demand from the editor (throttled) and from a scheduled
 * job (`npm run github-sync`).
 */
export class SubmissionNotOpenError extends Error {}

/** A refresh within this long of the last one reuses it instead of asking GitHub again. */
export const REFRESH_THROTTLE_MS = 30_000;

export type ReviewState = 'none' | 'pending' | 'approved' | 'changes_requested';
export type ChecksState = 'none' | 'pending' | 'success' | 'failure' | 'unavailable';

export interface StatusDetail {
  checks: CheckSummary[];
  reviews: { login: string; state: string }[];
  requestedReviewers: string[];
}

/** Each reviewer's latest decision (a comment doesn't replace an approval or a change request). */
export function summarizeReviews(reviews: ReviewSummary[], requestedReviewers: string[]): { state: ReviewState; latest: { login: string; state: string }[] } {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') latest.set(review.login, review.state);
  }
  const decisions = [...latest.entries()].filter(([, state]) => state !== 'DISMISSED').map(([login, state]) => ({ login, state }));
  let state: ReviewState = 'none';
  if (decisions.some((d) => d.state === 'CHANGES_REQUESTED')) state = 'changes_requested';
  else if (requestedReviewers.length > 0) state = 'pending';
  else if (decisions.some((d) => d.state === 'APPROVED')) state = 'approved';
  return { state, latest: decisions };
}

export function summarizeChecks(checks: CheckSummary[]): ChecksState {
  if (checks.length === 0) return 'none';
  if (checks.some((c) => c.state === 'failure')) return 'failure';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return 'success';
}

export type SyncOutcome = 'open' | 'merged' | 'closed' | 'error' | 'skipped' | 'rateLimited';

/** Syncs one submission with GitHub. Errors are recorded on the row (and the link), not thrown. */
export async function syncSubmission(client: GitHubClient, submissionId: string): Promise<SyncOutcome> {
  const db = getDb();
  const row = await db.selectFrom('diagram_submissions').selectAll().where('id', '=', submissionId).executeTakeFirst();
  if (!row || row.state !== 'open' || row.pr_number === null) return 'skipped';
  const repo = { owner: row.repo_owner, name: row.repo_name };
  try {
    // Not narrowed to permissions: Checks / Commit statuses may not have been granted, and the
    // pull request is still worth syncing without them.
    const token = await client.installationToken(Number(row.installation_id), [Number(row.repo_id)]);
    const pull = await client.getPullRequest(token, repo, row.pr_number);
    const state = await recordPullState(row.id, pull, row.last_pushed_commit_sha);
    if (state !== 'open') return state;

    const reviews = summarizeReviews(await client.listReviews(token, repo, pull.number), pull.requestedReviewers);
    let checks: CheckSummary[] = [];
    let checksState: ChecksState;
    try {
      checks = await client.listChecks(token, repo, pull.headSha);
      checksState = summarizeChecks(checks);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || ![403, 404].includes(error.status)) throw error;
      checksState = 'unavailable';
    }
    const detail: StatusDetail = { checks, reviews: reviews.latest, requestedReviewers: pull.requestedReviewers };
    await db
      .updateTable('diagram_submissions')
      .set({ review_state: reviews.state, checks_state: checksState, status_detail: JSON.stringify(detail), last_synced_at: new Date(), last_sync_error: null })
      .where('id', '=', row.id)
      .execute();
    return 'open';
  } catch (error) {
    // canvas-3s5.4: GitHub asked us to wait. Recorded on the submission, but it's not lost access.
    if (error instanceof GitHubRateLimitError) {
      await db.updateTable('diagram_submissions').set({ last_synced_at: new Date(), last_sync_error: error.message }).where('id', '=', row.id).execute();
      return 'rateLimited';
    }
    // A cached installation token outlives the repository being removed from the installation (or
    // deleted/transferred): GitHub then answers 404 for the pull request rather than failing the
    // token request, so a 404 here is lost access too.
    const lostAccess = error instanceof GitHubAccessError || (error instanceof GitHubApiError && error.status === 404);
    const message =
      error instanceof GitHubApiError && error.status === 404 && !(error instanceof GitHubAccessError)
        ? 'GitHub cannot find this repository or pull request (is the Canvas GitHub App still installed on it?).'
        : error instanceof Error
          ? error.message
          : String(error);
    await db.updateTable('diagram_submissions').set({ last_synced_at: new Date(), last_sync_error: message }).where('id', '=', row.id).execute();
    // Lost access is the admin's to fix: flag the link on the GitHub admin page.
    if (lostAccess && row.github_link_id) {
      await db
        .updateTable('github_links')
        .set({ last_checked_at: new Date(), last_check_error: `Needs attention: ${message}` })
        .where('id', '=', row.github_link_id)
        .execute();
    }
    return 'error';
  }
}

/** The editor's refresh: syncs the diagram's open submission unless it was synced moments ago. */
export async function refreshDiagramSubmission(client: GitHubClient, diagramId: string): Promise<{ synced: boolean }> {
  const row = await getDb()
    .selectFrom('diagram_submissions')
    .select(['id', 'last_synced_at', 'pr_number'])
    .where('diagram_id', '=', diagramId)
    .where('state', '=', 'open')
    .executeTakeFirst();
  if (!row || row.pr_number === null) return { synced: false };
  const last = row.last_synced_at ? new Date(row.last_synced_at as unknown as string).getTime() : 0;
  if (Date.now() - last < REFRESH_THROTTLE_MS) return { synced: false };
  await syncSubmission(client, row.id);
  return { synced: true };
}

/** The scheduled job: every open submission not synced within `minAgeMs`, oldest first. */
export async function syncOpenSubmissions(client: GitHubClient, minAgeMs = 60_000): Promise<Record<SyncOutcome, number>> {
  const cutoff = new Date(Date.now() - minAgeMs);
  const rows = await getDb()
    .selectFrom('diagram_submissions')
    .select('id')
    .where('state', '=', 'open')
    .where('pr_number', 'is not', null)
    .where((eb) => eb.or([eb('last_synced_at', 'is', null), eb('last_synced_at', '<', cutoff)]))
    .orderBy('last_synced_at')
    .execute();
  const counts: Record<SyncOutcome, number> = { open: 0, merged: 0, closed: 0, error: 0, skipped: 0, rateLimited: 0 };
  for (const [index, { id }] of rows.entries()) {
    const outcome = await syncSubmission(client, id);
    counts[outcome]++;
    // canvas-3s5.4: stop the batch rather than keep calling a GitHub that asked us to wait; the
    // rest are picked up on the next run (oldest-synced first).
    if (outcome === 'rateLimited') {
      counts.skipped += rows.length - index - 1;
      break;
    }
  }
  return counts;
}

/** Closes the diagram's open pull request from Canvas, with a comment saying who withdrew it. */
export async function withdrawSubmission(client: GitHubClient, diagramId: string, user: { id: string; name: string }): Promise<void> {
  const row = await getDb()
    .selectFrom('diagram_submissions')
    .selectAll()
    .where('diagram_id', '=', diagramId)
    .where('state', '=', 'open')
    .executeTakeFirst();
  if (!row || row.pr_number === null) throw new SubmissionNotOpenError('This diagram has no open pull request to withdraw.');
  const repo = { owner: row.repo_owner, name: row.repo_name };
  const token = await client.installationToken(Number(row.installation_id), [Number(row.repo_id)], SUBMIT_PERMISSIONS);
  const current = await client.getPullRequest(token, repo, row.pr_number);
  if (current.state !== 'open') {
    // Merged or closed on GitHub in the meantime: record that instead.
    await recordPullState(row.id, current, row.last_pushed_commit_sha);
    throw new SubmissionNotOpenError(`Pull request #${row.pr_number} was already ${current.merged ? 'merged' : 'closed'} on GitHub.`);
  }
  const name = user.name.replace(/[\r\n]+/g, ' ').replace(/@/g, '@​').slice(0, 100);
  await client.addPullRequestComment(token, repo, row.pr_number, `Withdrawn in Canvas by ${name}.`);
  const closed = await client.updatePullRequest(token, repo, row.pr_number, { state: 'closed' });
  await recordPullState(row.id, closed, row.last_pushed_commit_sha, { withdrawnBy: user.id });
}
