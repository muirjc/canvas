import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type GitHubLinkDto,
  type GitHubRepositoryDto,
  type GitHubStatusDto,
  type GitHubTestResultDto,
  type ProjectDto,
} from '../app/api';
import { previewPath } from '../app/submission-state';
import { Modal } from '../ui/Modal';

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error).message);

/**
 * canvas-3s5.1: admin page for the GitHub approval integration -- app status, the projects linked
 * to a repository folder, and the link/test/remove actions.
 */
export function GitHubAdminPage() {
  const [status, setStatus] = useState<GitHubStatusDto | null>(null);
  const [links, setLinks] = useState<GitHubLinkDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ link: GitHubLinkDto | null } | null>(null);
  const [removing, setRemoving] = useState<GitHubLinkDto | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, GitHubTestResultDto | { error: string } | 'running'>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, l] = await Promise.all([api.getGitHubStatus(), api.listGitHubLinks()]);
      setStatus(s);
      setLinks(l.links);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = async (projectId: string) => {
    setTests((t) => ({ ...t, [projectId]: 'running' }));
    try {
      const result = await api.testGitHubLink(projectId);
      setTests((t) => ({ ...t, [projectId]: result }));
      void load();
    } catch (err) {
      setTests((t) => ({ ...t, [projectId]: { error: errorText(err) } }));
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveError(null);
    try {
      await api.removeGitHubLink(removing.projectId);
      setRemoving(null);
      await load();
    } catch (err) {
      setRemoveError(errorText(err));
    }
  };

  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="stack">
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        GitHub
      </h1>
      <p className="meta">
        Link a project to a GitHub repository so its diagrams can be submitted as pull requests for approval.
      </p>
      {loadError && (
        <p role="alert" className="field__error" data-testid="github-load-error">
          {loadError}
        </p>
      )}

      <section className="card stack" aria-labelledby="github-app-heading" data-testid="github-app-status">
        <h2 id="github-app-heading" className="section-label">
          GitHub App
        </h2>
        {!status ? (
          <p className="state">Loading…</p>
        ) : !status.enabled ? (
          <div data-testid="github-not-configured">
            <p>GitHub is not configured, so diagrams cannot be submitted for approval.</p>
            <p className="meta">
              Create a GitHub App and set <code className="mono">GITHUB_APP_ID</code> and{' '}
              <code className="mono">GITHUB_APP_PRIVATE_KEY</code> for the API, then restart it. Setup steps are in{' '}
              <code className="mono">docs/admin-guide/github.md</code>.
            </p>
          </div>
        ) : status.error ? (
          <p role="alert" className="field__error" data-testid="github-status-error">
            Canvas could not reach GitHub with this App: {status.error}
          </p>
        ) : (
          <div>
            <p data-testid="github-connected">
              Connected{status.appId !== undefined && <> as App <span className="mono">{String(status.appId)}</span></>}
              {status.apiUrl && <span className="meta"> · {status.apiUrl}</span>}
            </p>
            {status.installations.length === 0 ? (
              <p className="meta" data-testid="github-no-installations">
                The App is not installed on any account yet. Install it and choose the repositories to allow.
              </p>
            ) : (
              <ul data-testid="github-installations">
                {status.installations.map((i) => (
                  <li key={i.id} data-testid={`github-installation-${i.id}`}>
                    {i.account} <span className="meta">· {i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="stack" aria-labelledby="github-links-heading">
        <div className="row">
          <h2 id="github-links-heading" className="section-label">
            Linked projects
          </h2>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--primary btn--compact"
            data-testid="github-link-project"
            disabled={!status?.enabled || Boolean(status?.error)}
            title={status?.enabled ? undefined : 'Configure the GitHub App first'}
            onClick={() => setEditing({ link: null })}
          >
            Link a project
          </button>
        </div>
        {links.length === 0 ? (
          <p className="state" data-testid="github-links-empty">
            No projects are linked yet.
          </p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Linked projects">
            <table data-testid="github-links">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Branch</th>
                  <th scope="col">Folder</th>
                  <th scope="col">Open PRs</th>
                  <th scope="col">Last checked</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => {
                  const test = tests[link.projectId];
                  return (
                    <tr key={link.id} data-testid={`github-link-row-${link.projectId}`}>
                      <td>{link.projectName}</td>
                      <td>{link.repoFullName}</td>
                      <td className="mono">{link.baseBranch}</td>
                      <td className="mono">{link.folder}</td>
                      <td data-testid={`github-link-open-prs-${link.projectId}`}>{link.openSubmissionCount ?? 0}</td>
                      <td>
                        {link.lastCheckError ? (
                          <span className="field__error" data-testid={`github-link-problem-${link.projectId}`}>
                            Problem: {link.lastCheckError}
                          </span>
                        ) : link.lastCheckedAt ? (
                          <time dateTime={link.lastCheckedAt}>{formatter.format(new Date(link.lastCheckedAt))}</time>
                        ) : (
                          <span className="meta">Never</span>
                        )}
                      </td>
                      <td>
                        <div className="row">
                          <button
                            type="button"
                            className="btn btn--secondary btn--compact"
                            data-testid={`github-link-test-${link.projectId}`}
                            disabled={test === 'running'}
                            aria-label={`Test link for ${link.projectName}`}
                            onClick={() => void runTest(link.projectId)}
                          >
                            {test === 'running' ? 'Testing…' : 'Test'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--compact"
                            data-testid={`github-link-edit-${link.projectId}`}
                            aria-label={`Edit link for ${link.projectName}`}
                            onClick={() => setEditing({ link })}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn--danger btn--compact"
                            data-testid={`github-link-remove-${link.projectId}`}
                            aria-label={`Remove link for ${link.projectName}`}
                            onClick={() => {
                              setRemoveError(null);
                              setRemoving(link);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {links.map((link) => {
          const test = tests[link.projectId];
          if (!test || test === 'running') return null;
          return (
            <div key={link.id} className="card" role="status" data-testid={`github-test-result-${link.projectId}`}>
              <h3 className="section-label">Checks for {link.projectName}</h3>
              {'error' in test ? (
                <p role="alert" className="field__error">
                  {test.error}
                </p>
              ) : (
                <ul>
                  {test.checks.map((c) => (
                    <li key={c.id} data-testid={`github-check-${link.projectId}-${c.id}`}>
                      <strong>{c.ok ? 'Passed' : 'Failed'}:</strong> {c.label}
                      {c.detail && <span className="meta"> — {c.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      {editing && (
        <LinkDialog
          link={editing.link}
          linkedProjectIds={links.map((l) => l.projectId)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {removing && (
        <Modal
          label="Remove GitHub link"
          role="alertdialog"
          testId="github-remove-confirm"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="github-remove-cancel" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" data-testid="github-remove-confirm-button" onClick={() => void confirmRemove()}>
                Remove link
              </button>
            </>
          }
        >
          <p>
            Remove the link between <strong>{removing.projectName}</strong> and {removing.repoFullName}? Diagrams in this project can no
            longer be submitted. Pull requests already opened are not affected.
          </p>
          {(removing.openSubmissionCount ?? 0) > 0 && (
            <p data-testid="github-remove-open-prs">
              {removing.openSubmissionCount} open pull request{removing.openSubmissionCount === 1 ? '' : 's'} stay
              {removing.openSubmissionCount === 1 ? 's' : ''} open on GitHub, and Canvas keeps tracking{' '}
              {removing.openSubmissionCount === 1 ? 'it' : 'them'}.
            </p>
          )}
          {removeError && (
            <p role="alert" className="field__error" data-testid="github-remove-error">
              {removeError}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

interface LinkDialogProps {
  link: GitHubLinkDto | null;
  linkedProjectIds: string[];
  onClose: () => void;
  onSaved: () => void;
}

function LinkDialog({ link, linkedProjectIds, onClose, onSaved }: LinkDialogProps) {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [repos, setRepos] = useState<GitHubRepositoryDto[] | null>(null);
  const [projectId, setProjectId] = useState(link?.projectId ?? '');
  const [repoId, setRepoId] = useState(link ? String(link.repoId) : '');
  const [branch, setBranch] = useState(link?.baseBranch ?? '');
  const [folder, setFolder] = useState(link?.folder ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.listProjects().then(({ projects }) => setProjects(projects)).catch((e) => setError(errorText(e)));
    api.listGitHubRepositories().then(({ repositories }) => setRepos(repositories)).catch((e) => setError(errorText(e)));
  }, []);

  const available = (projects ?? []).filter((p) => p.id === link?.projectId || !linkedProjectIds.includes(p.id));
  const repo = repos?.find((r) => String(r.id) === repoId);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId || !repo) return;
    setSaving(true);
    setError(null);
    try {
      await api.setGitHubLink(projectId, { repoId: repo.id, folder, ...(branch.trim() ? { baseBranch: branch.trim() } : {}) });
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  return (
    <Modal label={link ? 'Edit GitHub link' : 'Link a project to GitHub'} testId="github-link-dialog" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <div className="field">
          <label className="field__label" htmlFor="github-link-project-select">
            Project
          </label>
          <select
            id="github-link-project-select"
            data-testid="github-link-project-select"
            value={projectId}
            disabled={Boolean(link)}
            required
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{projects ? 'Choose a project…' : 'Loading…'}</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projects && available.length === 0 && <span className="meta">Every project is already linked.</span>}
        </div>
        <div className="field">
          <label className="field__label" htmlFor="github-link-repo-select">
            Repository
          </label>
          <select
            id="github-link-repo-select"
            data-testid="github-link-repo-select"
            value={repoId}
            required
            onChange={(e) => setRepoId(e.target.value)}
          >
            <option value="">{repos ? 'Choose a repository…' : 'Loading…'}</option>
            {(repos ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
                {r.private ? ' (private)' : ''}
              </option>
            ))}
          </select>
          {repos && repos.length === 0 && (
            <span className="meta">No repositories are available. Install the GitHub App on the repositories to use.</span>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor="github-link-branch">
            Branch
          </label>
          <input
            id="github-link-branch"
            data-testid="github-link-branch"
            value={branch}
            placeholder={repo?.defaultBranch ?? 'Repository default branch'}
            onChange={(e) => setBranch(e.target.value)}
          />
          <span className="meta">Pull requests target this branch. Leave empty for the repository default.</span>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="github-link-folder">
            Folder
          </label>
          <input
            id="github-link-folder"
            data-testid="github-link-folder"
            value={folder}
            required
            placeholder="architecture/diagrams"
            aria-describedby="github-link-folder-preview"
            onChange={(e) => setFolder(e.target.value)}
          />
          <span id="github-link-folder-preview" className="meta" data-testid="github-link-folder-preview">
            Files go to <span className="mono">{previewPath(folder)}</span>
          </span>
        </div>
        {error && (
          <p role="alert" className="field__error" data-testid="github-link-error">
            {error}
          </p>
        )}
        <div className="row">
          <span className="spacer" />
          <button type="button" className="btn btn--secondary" data-testid="github-link-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" data-testid="github-link-save" disabled={saving || !projectId || !repo || !folder.trim()}>
            {saving ? 'Saving…' : 'Save link'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
