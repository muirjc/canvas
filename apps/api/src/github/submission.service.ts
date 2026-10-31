import { randomUUID } from 'node:crypto';
import { getDslFamily, toPortableMermaid, type Violation } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { computeValidation, getDiagram } from '../diagrams/diagram.service.js';
import { exportSvg } from '../export/export.service.js';
import { getActiveStandard } from '../standards/standard.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { GitHubApiError, SUBMIT_PERMISSIONS, type GitHubClient, type OpenPullRequest, type PullRequestSummary } from './github-client.js';
import { getLinkForProject, type GitHubLink } from './github-link.service.js';
import { slugify } from './folder-path.js';
import { validatorBundle } from './validator-bundle.js';
import { documentEmbedUpdates } from './document-embeds.js';
import {
  buildCommitMessage,
  buildPrBody,
  buildPrTitle,
  buildSubmissionFiles,
  submissionFingerprint,
  type SubmissionInput,
} from './submission-files.js';

/**
 * canvas-3s5.1: submitting a diagram to its project's linked GitHub repository as a pull request.
 * One open pull request per diagram; submitting again while it is open pushes a new commit to it
 * (never a force-push). Merged = approved, closed unmerged = rejected (status sync is Phase 2).
 */
export class SubmissionNotLinkedError extends Error {}
export class SubmissionBlockedError extends Error {
  constructor(readonly violations: Violation[]) {
    super(`Fix the ${violations.length} Must fix issue${violations.length === 1 ? '' : 's'} before submitting.`);
  }
}
export class SubmissionInProgressError extends Error {
  constructor() {
    super('This diagram is already being submitted; try again in a moment.');
  }
}
/** The open pull request is in a different repository or folder than the project's link now. */
export class SubmissionLinkChangedError extends Error {}
/** The open pull request's branch moved in a way Canvas can't build on (e.g. force-pushed). */
export class SubmissionConflictError extends Error {}

/** A lock older than this is from a request that died; it no longer blocks. */
const LOCK_TIMEOUT_MS = 2 * 60_000;

export interface Submitter {
  id: string;
  name: string;
  email: string;
}

export interface SubmissionView {
  id: string;
  state: 'open' | 'merged' | 'closed';
  prNumber: number | null;
  prUrl: string | null;
  repoFullName: string;
  baseBranch: string;
  branch: string;
  path: string;
  submittedVersionSequence: number | null;
  submittedBy: string | null;
  firstSubmittedAt: string;
  lastSubmittedAt: string;
  reviewState: string;
  checksState: string;
  mergedAt: string | null;
  mergedBy: string | null;
  closedAt: string | null;
  /** canvas-3s5.2: false when GitHub merged something other than what Canvas last pushed. */
  mergedHeadMatches: boolean | null;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  /** canvas-3s5.2: checks, reviewers' latest decisions and outstanding review requests. */
  statusDetail: { checks: { name: string; state: string; url: string | null }[]; reviews: { login: string; state: string }[]; requestedReviewers: string[] } | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface SubmissionPush {
  versionSequence: number;
  commitSha: string;
  pushedBy: string | null;
  pushedAt: string;
  warningCount: number;
}

export interface SubmitResult {
  outcome: 'created' | 'updated' | 'upToDate';
  submission: SubmissionView | null;
  warnings: Violation[];
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string } | null;
  return e?.code === '23505' || e?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function submissionQuery() {
  return getDb()
    .selectFrom('diagram_submissions as s')
    .leftJoin('users as u', 'u.id', 's.submitted_by_user_id')
    .leftJoin('users as w', 'w.id', 's.withdrawn_by_user_id')
    .selectAll('s')
    .select(['u.name as submitted_by_name', 'w.name as withdrawn_by_name']);
}
type SubmissionRow = Awaited<ReturnType<ReturnType<typeof submissionQuery>['executeTakeFirstOrThrow']>>;

function toView(row: SubmissionRow): SubmissionView {
  const ts = (v: unknown) => (v as string | null) ?? null;
  return {
    id: row.id,
    state: row.state,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    repoFullName: `${row.repo_owner}/${row.repo_name}`,
    baseBranch: row.base_branch,
    branch: row.branch,
    path: row.path,
    submittedVersionSequence: row.submitted_version_sequence,
    submittedBy: row.submitted_by_name,
    firstSubmittedAt: row.first_submitted_at as unknown as string,
    lastSubmittedAt: row.last_submitted_at as unknown as string,
    reviewState: row.review_state,
    checksState: row.checks_state,
    mergedAt: ts(row.merged_at),
    mergedBy: row.merged_by_login,
    closedAt: ts(row.closed_at),
    mergedHeadMatches: row.merged_head_matches === null ? null : Boolean(row.merged_head_matches),
    withdrawnAt: ts(row.withdrawn_at),
    withdrawnBy: row.withdrawn_by_name,
    statusDetail: parseDetail(row.status_detail),
    lastSyncedAt: ts(row.last_synced_at),
    lastSyncError: row.last_sync_error,
  };
}

function parseDetail(text: string | null): SubmissionView['statusDetail'] {
  if (!text) return null;
  try {
    return JSON.parse(text) as SubmissionView['statusDetail'];
  } catch {
    return null;
  }
}

/** The most recent approved (merged) submission, if any. */
export async function getApprovedSubmission(diagramId: string): Promise<SubmissionView | null> {
  const row = await submissionQuery().where('s.diagram_id', '=', diagramId).where('s.state', '=', 'merged').orderBy('s.merged_at', 'desc').executeTakeFirst();
  return row ? toView(row) : null;
}

/** Every pull request opened for the diagram, newest first, each with its pushes (newest first). */
export async function listSubmissionHistory(diagramId: string): Promise<(SubmissionView & { pushes: SubmissionPush[] })[]> {
  const rows = await submissionQuery().where('s.diagram_id', '=', diagramId).where('s.pr_number', 'is not', null).orderBy('s.first_submitted_at', 'desc').execute();
  if (rows.length === 0) return [];
  const pushes = await getDb()
    .selectFrom('diagram_submission_pushes as p')
    .leftJoin('users as u', 'u.id', 'p.pushed_by_user_id')
    .select(['p.submission_id', 'p.version_sequence', 'p.commit_sha', 'p.pushed_at', 'p.warning_count', 'u.name as pushed_by'])
    .where(
      'p.submission_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('p.pushed_at', 'desc')
    .execute();
  return rows.map((row) => ({
    ...toView(row),
    pushes: pushes
      .filter((p) => p.submission_id === row.id)
      .map((p) => ({ versionSequence: p.version_sequence, commitSha: p.commit_sha, pushedBy: p.pushed_by, pushedAt: p.pushed_at as unknown as string, warningCount: p.warning_count })),
  }));
}

export interface DiagramSubmissionBadge {
  state: 'open' | 'merged' | 'closed';
  prNumber: number | null;
  prUrl: string | null;
  reviewState: string;
  checksState: string;
  submittedVersionSequence: number | null;
  changesSinceSubmitting: boolean;
  withdrawn: boolean;
}

/** Each submitted diagram's latest submission in a project, for the project page's badges. */
export async function projectSubmissionBadges(projectId: string): Promise<Record<string, DiagramSubmissionBadge>> {
  const rows = await getDb()
    .selectFrom('diagram_submissions as s')
    .innerJoin('diagrams as d', 'd.id', 's.diagram_id')
    .innerJoin('diagram_versions as v', 'v.id', 'd.current_version_id')
    .select([
      's.diagram_id',
      's.state',
      's.pr_number',
      's.pr_url',
      's.review_state',
      's.checks_state',
      's.submitted_version_sequence',
      's.submitted_fingerprint',
      's.withdrawn_at',
      's.last_submitted_at',
      'd.name',
      'd.description',
      'v.dsl_content',
    ])
    .where('d.project_id', '=', projectId)
    .where('d.deleted_at', 'is', null)
    .where('s.pr_number', 'is not', null)
    .orderBy('s.last_submitted_at', 'asc')
    .execute();
  const badges: Record<string, DiagramSubmissionBadge> = {};
  // Ascending, so the latest submission per diagram wins -- except an open one always does.
  for (const r of rows) {
    if (badges[r.diagram_id]?.state === 'open') continue;
    badges[r.diagram_id] = {
      state: r.state,
      prNumber: r.pr_number,
      prUrl: r.pr_url,
      reviewState: r.review_state,
      checksState: r.checks_state,
      submittedVersionSequence: r.submitted_version_sequence,
      changesSinceSubmitting: r.submitted_fingerprint !== submissionFingerprint(r.dsl_content, r.name, r.description),
      withdrawn: r.withdrawn_at !== null,
    };
  }
  return badges;
}

async function getSubmissionView(id: string): Promise<SubmissionView> {
  return toView(await submissionQuery().where('s.id', '=', id).executeTakeFirstOrThrow());
}

/** The diagram's latest submission (open, else most recent). */
export async function getLatestSubmission(diagramId: string): Promise<(SubmissionView & { fingerprint: string | null }) | null> {
  const row = await submissionQuery()
    .where('s.diagram_id', '=', diagramId)
    .where('s.pr_number', 'is not', null)
    .orderBy('s.last_submitted_at', 'desc')
    .executeTakeFirst();
  return row ? { ...toView(row), fingerprint: row.submitted_fingerprint } : null;
}

async function currentVersionSequence(diagramId: string): Promise<number> {
  const row = await getDb()
    .selectFrom('diagrams as d')
    .innerJoin('diagram_versions as v', 'v.id', 'd.current_version_id')
    .innerJoin('diagram_types as t', 't.id', 'd.diagram_type_id')
    .select(['v.sequence_number'])
    .where('d.id', '=', diagramId)
    .executeTakeFirstOrThrow();
  return row.sequence_number;
}

async function diagramTypeName(diagramTypeId: string): Promise<string> {
  const row = await getDb().selectFrom('diagram_types').select('name').where('id', '=', diagramTypeId).executeTakeFirst();
  return row?.name ?? diagramTypeId;
}

/** Validates the saved diagram against the current standard. Must fix issues block submitting. */
export async function checkSubmittable(diagramTypeId: string, dslFamily: string, dslContent: string): Promise<{ blocking: Violation[]; warnings: Violation[] }> {
  const family = getDslFamily(dslFamily);
  const parsed = family?.parse(dslContent);
  if (!parsed || 'errors' in parsed) {
    return { blocking: [{ elementId: 'diagram', rule: 'parse', message: 'The diagram has syntax errors.', severity: 'error', elementType: 'diagram' }], warnings: [] };
  }
  const { violations } = await computeValidation(diagramTypeId, parsed.model);
  return { blocking: violations.filter((v) => v.severity === 'error'), warnings: violations.filter((v) => v.severity !== 'error') };
}

/** The folder a diagram's files go in: the one it was first submitted to under this link's
 *  repository + folder, else a new one named after it (made unique if another diagram has it). */
async function choosePath(diagramId: string, diagramName: string, link: GitHubLink): Promise<{ path: string; slug: string }> {
  const db = getDb();
  const previous = await db
    .selectFrom('diagram_submissions')
    .select('path')
    .where('diagram_id', '=', diagramId)
    .where('repo_id', '=', link.repoId)
    .where('path', 'like', `${link.folder}/%`)
    .orderBy('first_submitted_at', 'desc')
    .executeTakeFirst();
  if (previous && !previous.path.slice(link.folder.length + 1).includes('/')) {
    return { path: previous.path, slug: previous.path.slice(link.folder.length + 1) };
  }
  let slug = slugify(diagramName);
  const taken = await db
    .selectFrom('diagram_submissions')
    .select('diagram_id')
    .where('repo_id', '=', link.repoId)
    .where('path', '=', `${link.folder}/${slug}`)
    .where('diagram_id', '!=', diagramId)
    .executeTakeFirst();
  if (taken) slug = `${slug.slice(0, 51)}-${diagramId.replace(/-/g, '').slice(0, 8)}`;
  return { path: `${link.folder}/${slug}`, slug };
}

/**
 * Takes the per-diagram lock: the open submission row itself. A new submission inserts a
 * provisional open row (the partial unique index allows one per diagram); an existing one is
 * claimed by setting `submitting_since`, unless another request holds it.
 */
async function lockSubmission(
  diagramId: string,
  create: () => Record<string, unknown>,
): Promise<{ id: string; provisional: boolean }> {
  const db = getDb();
  const now = new Date();
  const open = await db.selectFrom('diagram_submissions').select('id').where('diagram_id', '=', diagramId).where('state', '=', 'open').executeTakeFirst();
  if (open) {
    const claimed = await db
      .updateTable('diagram_submissions')
      .set({ submitting_since: now })
      .where('id', '=', open.id)
      .where((eb) => eb.or([eb('submitting_since', 'is', null), eb('submitting_since', '<', new Date(now.getTime() - LOCK_TIMEOUT_MS))]))
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) throw new SubmissionInProgressError();
    return { id: open.id, provisional: false };
  }
  const id = randomUUID();
  try {
    await db
      .insertInto('diagram_submissions')
      .values({ id, diagram_id: diagramId, state: 'open', first_submitted_at: now, last_submitted_at: now, submitting_since: now, ...create() } as never)
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) throw new SubmissionInProgressError();
    throw error;
  }
  return { id, provisional: true };
}

async function releaseLock(id: string, provisional: boolean): Promise<void> {
  const db = getDb();
  if (provisional) await db.deleteFrom('diagram_submissions').where('id', '=', id).where('pr_number', 'is', null).execute();
  await db.updateTable('diagram_submissions').set({ submitting_since: null }).where('id', '=', id).execute();
}

/**
 * Records what GitHub says about a pull request Canvas thought was open. Merged = approved (and
 * whether GitHub merged exactly what Canvas last pushed); closed unmerged = rejected. Both are
 * audited; returns the new state.
 */
export async function recordPullState(
  submissionId: string,
  pull: PullRequestSummary,
  submittedSha: string | null,
  extra: { withdrawnBy?: string } = {},
): Promise<'open' | 'merged' | 'closed'> {
  const db = getDb();
  if (pull.state === 'open') {
    await db.updateTable('diagram_submissions').set({ head_sha: pull.headSha, last_synced_at: new Date(), last_sync_error: null }).where('id', '=', submissionId).execute();
    return 'open';
  }
  const state = pull.merged ? 'merged' : 'closed';
  const now = new Date();
  const changed = await db
    .updateTable('diagram_submissions')
    .set({
      state,
      head_sha: pull.headSha,
      merged_at: pull.mergedAt ? new Date(pull.mergedAt) : null,
      merged_by_login: pull.mergedBy,
      merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
      merged_head_matches: pull.merged ? pull.headSha === submittedSha : null,
      closed_at: pull.closedAt ? new Date(pull.closedAt) : now,
      ...(extra.withdrawnBy ? { withdrawn_at: now, withdrawn_by_user_id: extra.withdrawnBy } : {}),
      submitting_since: null,
      last_synced_at: now,
      last_sync_error: null,
    })
    .where('id', '=', submissionId)
    .where('state', '=', 'open')
    .executeTakeFirst();
  if (Number(changed.numUpdatedRows) > 0) {
    const row = await db.selectFrom('diagram_submissions').select(['diagram_id', 'repo_owner', 'repo_name', 'submitted_version_sequence']).where('id', '=', submissionId).executeTakeFirstOrThrow();
    await recordAudit({
      event: extra.withdrawnBy ? 'diagram_submission_withdrawn' : pull.merged ? 'diagram_submission_merged' : 'diagram_submission_closed',
      actorUserId: extra.withdrawnBy ?? null,
      detail: {
        diagramId: row.diagram_id,
        repo: `${row.repo_owner}/${row.repo_name}`,
        pullRequest: pull.number,
        versionSequence: row.submitted_version_sequence,
        ...(pull.merged ? { mergedBy: pull.mergedBy, headMatches: pull.headSha === submittedSha } : {}),
      },
    });
  }
  return state;
}

/**
 * An open pull request this Canvas opened for the diagram that no submission row records: opened
 * by a bot (the App), from a canvas/<id8>- branch in the same repository, carrying the diagram's
 * marker in its description, and not a pull request Canvas already knows about.
 */
async function findUnrecordedPull(
  client: GitHubClient,
  token: string,
  submission: { repo_owner: string; repo_name: string; repo_id: number | string; base_branch: string },
  diagramId: string,
): Promise<OpenPullRequest | null> {
  const repo = { owner: submission.repo_owner, name: submission.repo_name };
  const prefix = `canvas/${diagramId.replace(/-/g, '').slice(0, 8)}-`;
  const marker = `<!-- canvas:diagram=${diagramId} -->`;
  const known = new Set(
    (
      await getDb()
        .selectFrom('diagram_submissions')
        .select('pr_number')
        .where('repo_id', '=', Number(submission.repo_id))
        .where('pr_number', 'is not', null)
        .execute()
    ).map((r) => r.pr_number),
  );
  const candidates = (await client.listOpenPullRequests(token, repo, submission.base_branch)).filter(
    (p) =>
      p.author.endsWith('[bot]') &&
      p.headRef.startsWith(prefix) &&
      p.headRepo?.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase() &&
      p.body.includes(marker) &&
      !known.has(p.number),
  );
  // Newest first from GitHub; if somehow there are several, adopt the newest.
  return candidates[0] ?? null;
}

export async function submitDiagram(client: GitHubClient, diagramId: string, submitter: Submitter, canvasPublicUrl: string): Promise<SubmitResult> {
  const diagram = await getDiagram(diagramId);
  const link = await getLinkForProject(diagram.projectId);
  if (!link) throw new SubmissionNotLinkedError("This diagram's project is not linked to a GitHub repository. Ask an admin to link it.");

  const { blocking, warnings } = await checkSubmittable(diagram.diagramTypeId, diagram.dslFamily, diagram.dslContent);
  if (blocking.length > 0) throw new SubmissionBlockedError(blocking);

  const db = getDb();
  // A pull request Canvas thinks is open may have been merged or closed on GitHub since; find out
  // before deciding whether to push to it or open a new one.
  const token = await client.installationToken(link.installationId, [link.repoId], SUBMIT_PERMISSIONS);
  const existing = await db.selectFrom('diagram_submissions').selectAll().where('diagram_id', '=', diagramId).where('state', '=', 'open').executeTakeFirst();
  // A lock older than LOCK_TIMEOUT_MS is from a request that died, so the pull request is synced too.
  const lockIsLive = existing?.submitting_since != null && new Date(existing.submitting_since as unknown as string).getTime() > Date.now() - LOCK_TIMEOUT_MS;
  if (existing && existing.pr_number !== null && !lockIsLive) {
    if (Number(existing.repo_id) !== link.repoId || !existing.path.startsWith(`${link.folder}/`)) {
      throw new SubmissionLinkChangedError(
        `Pull request #${existing.pr_number} is open in ${existing.repo_owner}/${existing.repo_name}, but this project is now linked elsewhere. Close or merge that pull request first.`,
      );
    }
    const pull = await client.getPullRequest(token, { owner: existing.repo_owner, name: existing.repo_name }, existing.pr_number);
    await recordPullState(existing.id, pull, existing.last_pushed_commit_sha);
  }

  const repo = await client.getRepository(token, link.repoId);
  if (repo.owner !== link.repoOwner || repo.name !== link.repoName) {
    await db.updateTable('github_links').set({ repo_owner: repo.owner, repo_name: repo.name }).where('id', '=', link.id).execute();
  }
  const { path, slug } = await choosePath(diagramId, diagram.name, link);
  const previousCount = await db.selectFrom('diagram_submissions').select((eb) => eb.fn.countAll<number>().as('n')).where('diagram_id', '=', diagramId).executeTakeFirstOrThrow();
  const branch = `canvas/${diagramId.replace(/-/g, '').slice(0, 8)}-${slug.slice(0, 40).replace(/-+$/, '')}-r${Number(previousCount.n) + 1}`;

  const lock = await lockSubmission(diagramId, () => ({
    github_link_id: link.id,
    repo_id: link.repoId,
    repo_owner: repo.owner,
    repo_name: repo.name,
    installation_id: link.installationId,
    base_branch: link.baseBranch,
    path,
    branch,
    submitted_by_user_id: submitter.id,
  }));

  try {
    let submission = await db.selectFrom('diagram_submissions').selectAll().where('id', '=', lock.id).executeTakeFirstOrThrow();
    // canvas-3s5.5: a pull request Canvas opened but failed to record (the request died after
    // GitHub created it) is adopted rather than duplicated.
    if (submission.pr_number === null) {
      const orphan = await findUnrecordedPull(client, token, submission, diagramId);
      if (orphan) {
        await db.updateTable('diagram_submissions').set({ pr_number: orphan.number, pr_url: orphan.url, branch: orphan.headRef }).where('id', '=', lock.id).execute();
        submission = await db.selectFrom('diagram_submissions').selectAll().where('id', '=', lock.id).executeTakeFirstOrThrow();
      }
    }
    const versionSequence = await currentVersionSequence(diagramId);
    const standard = await getActiveStandard(diagram.diagramTypeId);
    const canvasUrl = `${canvasPublicUrl}/?diagramId=${encodeURIComponent(diagramId)}`;
    const input: SubmissionInput = {
      diagramId,
      name: diagram.name,
      description: diagram.description,
      diagramTypeId: diagram.diagramTypeId,
      diagramTypeName: await diagramTypeName(diagram.diagramTypeId),
      dslFamily: diagram.dslFamily,
      dslContent: diagram.dslContent,
      portableMermaid: toPortableMermaid(diagram.dslContent, { stripFrontMatter: true }),
      // canvas-n85n: white behind the drawing, so it stays readable in GitHub's dark mode.
      svg: await exportSvg(diagram.dslFamily, diagram.dslContent, diagram.diagramTypeId, { background: '#ffffff' }),
      versionSequence,
      standard: standard ? { id: standard.id, version: standard.version, name: standard.name, description: standard.description, rules: standard.rules } : null,
      path: submission.path,
      slug: submission.path.slice(submission.path.lastIndexOf('/') + 1),
      canvasUrl,
      validator: validatorBundle(),
    };
    const files = buildSubmissionFiles(input);
    const target = { owner: submission.repo_owner, name: submission.repo_name };
    const isUpdate = submission.pr_number !== null;

    const parentSha = isUpdate
      ? await client.getBranchSha(token, target, submission.branch)
      : await client.getBranchSha(token, target, submission.base_branch);
    if (!parentSha) {
      throw isUpdate
        ? new SubmissionConflictError(`The branch for pull request #${submission.pr_number} was deleted on GitHub. Close the pull request so Canvas can open a new one.`)
        : new SubmissionNotLinkedError(`The linked branch "${submission.base_branch}" no longer exists in ${target.owner}/${target.name}.`);
    }
    const parentTree = await client.getCommitTreeSha(token, target, parentSha);
    // canvas-finl: documents that embed this diagram are updated in the same commit.
    const embeds = await documentEmbedUpdates(client, token, target, parentTree, {
      mmdPath: `${input.path}/${input.slug}.mmd`,
      mmdText: input.portableMermaid,
      svgPath: `${input.path}/${input.slug}.svg`,
    });
    const tree = await client.createTree(token, target, parentTree, [...files, ...embeds.files]);
    const fingerprint = submissionFingerprint(diagram.dslContent, diagram.name, diagram.description);

    if (tree === parentTree) {
      // Nothing to commit: the repository already has exactly these files.
      await releaseLock(lock.id, lock.provisional);
      return { outcome: 'upToDate', submission: isUpdate ? await getSubmissionView(lock.id) : null, warnings };
    }

    const commit = await client.createCommit(token, target, buildCommitMessage(input, submitter, isUpdate), tree, parentSha);
    const now = new Date();
    let pull: PullRequestSummary;
    let branchName = submission.branch;
    if (isUpdate) {
      try {
        await client.fastForwardBranch(token, target, submission.branch, commit);
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 422) {
          throw new SubmissionConflictError(`Pull request #${submission.pr_number} changed on GitHub while submitting; try again.`);
        }
        throw error;
      }
      pull = await client.updatePullRequest(token, target, submission.pr_number!, { title: buildPrTitle(input), body: buildPrBody(input, warnings, submitter.name, embeds.documents) });
    } else {
      // A branch left over from an attempt that failed before its pull request was opened.
      if (!(await client.createBranch(token, target, branchName, commit))) {
        branchName = `${branchName}-${randomUUID().slice(0, 4)}`;
        if (!(await client.createBranch(token, target, branchName, commit))) throw new SubmissionConflictError('Could not create a branch for this submission; try again.');
      }
      pull = await client.createPullRequest(token, target, { title: buildPrTitle(input), head: branchName, base: submission.base_branch, body: buildPrBody(input, warnings, submitter.name, embeds.documents) });
    }

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('diagram_submissions')
        .set({
          branch: branchName,
          pr_number: pull.number,
          pr_url: pull.url,
          submitted_version_sequence: versionSequence,
          submitted_fingerprint: fingerprint,
          last_pushed_commit_sha: commit,
          head_sha: commit,
          submitted_by_user_id: submitter.id,
          last_submitted_at: now,
          ...(isUpdate ? {} : { first_submitted_at: now }),
          submitting_since: null,
        })
        .where('id', '=', lock.id)
        .execute();
      await trx
        .insertInto('diagram_submission_pushes')
        .values({ id: randomUUID(), submission_id: lock.id, version_sequence: versionSequence, commit_sha: commit, pushed_by_user_id: submitter.id, pushed_at: now, warning_count: warnings.length })
        .execute();
      await recordAudit(
        {
          event: 'diagram_submitted',
          actorUserId: submitter.id,
          detail: { diagramId, repo: `${target.owner}/${target.name}`, pullRequest: pull.number, versionSequence, update: isUpdate },
        },
        trx,
      );
    });
    return { outcome: isUpdate ? 'updated' : 'created', submission: await getSubmissionView(lock.id), warnings };
  } catch (error) {
    await releaseLock(lock.id, lock.provisional);
    throw error;
  }
}
