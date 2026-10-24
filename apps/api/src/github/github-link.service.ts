import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { GitHubAccessError, GitHubApiError, type GitHubClient, type RepositorySummary } from './github-client.js';
import { normalizeFolder } from './folder-path.js';

/**
 * canvas-3s5.1: an admin links a project to a GitHub repository + folder; diagrams in that project
 * can then be submitted there as pull requests. Explicit per project (no inheritance). Only
 * repositories the Canvas GitHub App is installed on can be linked.
 */
export class GitHubDisabledError extends Error {
  constructor() {
    super('GitHub is not set up for this Canvas (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).');
  }
}
export class GitHubLinkInvalidError extends Error {}
export class GitHubLinkConflictError extends Error {}
export class GitHubLinkNotFoundError extends Error {}

export interface GitHubLink {
  id: string;
  projectId: string;
  projectName: string | null;
  repoId: number;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  installationId: number;
  baseBranch: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
}

export type InstalledRepository = RepositorySummary & { installationId: number };

function linkQuery() {
  return getDb()
    .selectFrom('github_links as l')
    .leftJoin('projects as p', 'p.id', 'l.project_id')
    .select([
      'l.id',
      'l.project_id',
      'p.name as project_name',
      'l.repo_id',
      'l.repo_owner',
      'l.repo_name',
      'l.installation_id',
      'l.base_branch',
      'l.folder',
      'l.created_at',
      'l.updated_at',
      'l.last_checked_at',
      'l.last_check_error',
    ]);
}

type LinkRow = Awaited<ReturnType<ReturnType<typeof linkQuery>['executeTakeFirstOrThrow']>>;

function toLink(row: LinkRow): GitHubLink {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    repoId: Number(row.repo_id),
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoFullName: `${row.repo_owner}/${row.repo_name}`,
    installationId: Number(row.installation_id),
    baseBranch: row.base_branch,
    folder: row.folder,
    createdAt: row.created_at as unknown as string,
    updatedAt: row.updated_at as unknown as string,
    lastCheckedAt: (row.last_checked_at as unknown as string | null) ?? null,
    lastCheckError: row.last_check_error,
  };
}

export async function getLinkForProject(projectId: string): Promise<GitHubLink | null> {
  const row = await linkQuery().where('l.project_id', '=', projectId).executeTakeFirst();
  return row ? toLink(row) : null;
}

export async function listLinks(): Promise<GitHubLink[]> {
  const rows = await linkQuery().where('p.deleted_at', 'is', null).orderBy('p.name').execute();
  return rows.map(toLink);
}

/** Every repository the App can reach, across its installations. */
export async function listInstalledRepositories(client: GitHubClient): Promise<InstalledRepository[]> {
  const installations = await client.listInstallations();
  const repos: InstalledRepository[] = [];
  for (const installation of installations) {
    for (const repo of await client.listInstallationRepositories(installation.id)) repos.push({ ...repo, installationId: installation.id });
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export interface SetLinkInput {
  projectId: string;
  repoId: number;
  folder: string;
  baseBranch?: string;
  userId: string;
}

export async function setLink(client: GitHubClient, input: SetLinkInput): Promise<GitHubLink> {
  const folder = normalizeFolder(input.folder);
  const repo = (await listInstalledRepositories(client)).find((r) => r.id === input.repoId);
  if (!repo) throw new GitHubLinkInvalidError('The Canvas GitHub App is not installed on that repository.');
  const baseBranch = input.baseBranch?.trim() || repo.defaultBranch;
  const token = await client.installationToken(repo.installationId, [repo.id]);
  if (!(await client.getBranchSha(token, repo, baseBranch))) {
    throw new GitHubLinkInvalidError(`The repository has no branch "${baseBranch}".`);
  }

  // Two projects writing into the same folder, or one inside the other, could overwrite each other's diagrams.
  const others = await getDb().selectFrom('github_links').select(['folder', 'project_id']).where('repo_id', '=', repo.id).where('project_id', '!=', input.projectId).execute();
  const clash = others.find((o) => o.folder === folder || o.folder.startsWith(`${folder}/`) || folder.startsWith(`${o.folder}/`));
  if (clash) throw new GitHubLinkConflictError(`Another project already uses "${clash.folder}" in ${repo.fullName}; choose a separate folder.`);

  const db = getDb();
  const existing = await db.selectFrom('github_links').select('id').where('project_id', '=', input.projectId).executeTakeFirst();
  const values = {
    repo_id: repo.id,
    repo_owner: repo.owner,
    repo_name: repo.name,
    installation_id: repo.installationId,
    base_branch: baseBranch,
    folder,
    last_checked_at: new Date(),
    last_check_error: null,
  };
  if (existing) {
    await db.updateTable('github_links').set({ ...values, updated_at: new Date() }).where('id', '=', existing.id).execute();
  } else {
    await db
      .insertInto('github_links')
      .values({ id: randomUUID(), project_id: input.projectId, created_by_user_id: input.userId, ...values })
      .execute();
  }
  return (await getLinkForProject(input.projectId))!;
}

export async function removeLink(projectId: string): Promise<GitHubLink> {
  const link = await getLinkForProject(projectId);
  if (!link) throw new GitHubLinkNotFoundError('This project is not linked to GitHub.');
  await getDb().deleteFrom('github_links').where('id', '=', link.id).execute();
  return link;
}

export interface LinkCheck {
  id: 'installation' | 'repository' | 'branch' | 'contents' | 'pull_requests';
  label: string;
  ok: boolean;
  detail?: string;
}

/** Checks the link still works: App installed, repository reachable, branch present, permissions granted. */
export async function testLink(client: GitHubClient, projectId: string): Promise<{ ok: boolean; checks: LinkCheck[] }> {
  const link = await getLinkForProject(projectId);
  if (!link) throw new GitHubLinkNotFoundError('This project is not linked to GitHub.');
  const checks: LinkCheck[] = [];
  const fail = (id: LinkCheck['id'], label: string, error: unknown) =>
    checks.push({ id, label, ok: false, detail: error instanceof Error ? error.message : String(error) });

  try {
    const installation = await client.getInstallation(link.installationId);
    checks.push({ id: 'installation', label: `App installed on ${installation.account}`, ok: true });
    for (const [id, label] of [
      ['contents', 'Permission: Contents (read and write)'],
      ['pull_requests', 'Permission: Pull requests (read and write)'],
    ] as const) {
      const granted = installation.permissions[id] === 'write';
      checks.push({ id, label, ok: granted, ...(granted ? {} : { detail: `Granted: ${installation.permissions[id] ?? 'none'}` }) });
    }
    try {
      const token = await client.installationToken(link.installationId, [link.repoId]);
      const repo = await client.getRepository(token, link.repoId);
      checks.push({ id: 'repository', label: `Repository ${repo.fullName} reachable`, ok: true });
      if (repo.owner !== link.repoOwner || repo.name !== link.repoName) {
        await getDb().updateTable('github_links').set({ repo_owner: repo.owner, repo_name: repo.name }).where('id', '=', link.id).execute();
      }
      const branch = await client.getBranchSha(token, repo, link.baseBranch);
      checks.push({ id: 'branch', label: `Branch ${link.baseBranch} exists`, ok: Boolean(branch) });
    } catch (error) {
      fail('repository', 'Repository reachable', error);
    }
  } catch (error) {
    fail('installation', 'App installed', error instanceof GitHubApiError && error.status === 404 ? new GitHubAccessError(404, 'The App is no longer installed.', error.path) : error);
  }

  const ok = checks.every((c) => c.ok);
  const firstProblem = checks.find((c) => !c.ok);
  await getDb()
    .updateTable('github_links')
    .set({ last_checked_at: new Date(), last_check_error: firstProblem ? `${firstProblem.label}${firstProblem.detail ? `: ${firstProblem.detail}` : ''}` : null })
    .where('id', '=', link.id)
    .execute();
  return { ok, checks };
}
