import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requireDiagramAccess, requireProjectAccess } from '../auth/access-control.middleware.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import { DiagramNotFoundError, getDiagram } from '../diagrams/diagram.service.js';
import { projectExists } from '../projects/project.access.js';
import { accessAtLeast, resolveDiagramAccess } from '../sharing/sharing.service.js';
import type { AppConfig } from '../config.js';
import { GitHubAccessError, GitHubApiError, GitHubClient, GitHubRateLimitError, GitHubUnavailableError } from './github-client.js';
import { InvalidRepoPathError } from './folder-path.js';
import {
  getLinkForProject,
  GitHubDisabledError,
  GitHubLinkConflictError,
  GitHubLinkInvalidError,
  GitHubLinkNotFoundError,
  listInstalledRepositories,
  listLinks,
  removeLink,
  setLink,
  testLink,
} from './github-link.service.js';
import {
  checkSubmittable,
  getLatestSubmission,
  submitDiagram,
  SubmissionBlockedError,
  SubmissionConflictError,
  SubmissionInProgressError,
  SubmissionLinkChangedError,
  SubmissionNotLinkedError,
} from './submission.service.js';
import { submissionFingerprint } from './submission-files.js';

/**
 * canvas-3s5.1: GitHub approval. Admins link projects to repositories; anyone with edit access to
 * a diagram in a linked project can submit it as a pull request.
 */
function handleError(error: unknown, reply: FastifyReply, request: FastifyRequest): FastifyReply {
  if (error instanceof GitHubDisabledError) return reply.code(409).send({ error: error.message, code: 'github_disabled' });
  if (error instanceof DiagramNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof GitHubLinkNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof GitHubLinkInvalidError || error instanceof InvalidRepoPathError) return reply.code(400).send({ error: error.message });
  if (error instanceof GitHubLinkConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof SubmissionNotLinkedError) return reply.code(409).send({ error: error.message, code: 'not_linked' });
  if (error instanceof SubmissionBlockedError) return reply.code(422).send({ error: error.message, code: 'must_fix', violations: error.violations });
  if (error instanceof SubmissionInProgressError) return reply.code(409).send({ error: error.message, code: 'in_progress' });
  if (error instanceof SubmissionLinkChangedError) return reply.code(409).send({ error: error.message, code: 'link_changed' });
  if (error instanceof SubmissionConflictError) return reply.code(409).send({ error: error.message, code: 'conflict' });
  if (error instanceof GitHubRateLimitError) return reply.code(503).send({ error: error.message, code: 'github_rate_limited' });
  if (error instanceof GitHubAccessError) return reply.code(502).send({ error: error.message, code: 'github_access' });
  if (error instanceof GitHubUnavailableError) return reply.code(502).send({ error: error.message, code: 'github_unavailable' });
  if (error instanceof GitHubApiError) {
    request.log.warn({ status: error.status, path: error.path, message: error.message }, 'GitHub API error');
    return reply.code(502).send({ error: `GitHub refused the request: ${error.message}`, code: 'github_error' });
  }
  throw error;
}

const projectParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;
const schema = (extra: object = {}) => ({ tags: ['GitHub'], security: [{ cookieAuth: [] }], ...extra });

export async function registerGitHubRoutes(app: FastifyInstance, config: AppConfig, fetchImpl?: typeof fetch): Promise<void> {
  const client = config.github ? new GitHubClient(config.github, fetchImpl) : null;
  const requireClient = (): GitHubClient => {
    if (!client) throw new GitHubDisabledError();
    return client;
  };
  const admin = requireRole('admin');

  app.get('/admin/github/status', { preHandler: admin, schema: schema() }, async (request, reply) => {
    if (!client) return reply.send({ enabled: false, installations: [] });
    try {
      const installations = await client.listInstallations();
      return reply.send({ enabled: true, appId: client.appId, apiUrl: client.apiUrl, installations });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.log.warn({ message }, 'GitHub status check failed');
      return reply.send({ enabled: true, appId: client.appId, apiUrl: client.apiUrl, installations: [], error: message });
    }
  });

  app.get('/admin/github/repositories', { preHandler: admin, schema: schema() }, async (request, reply) => {
    try {
      return reply.send({ repositories: await listInstalledRepositories(requireClient()) });
    } catch (error) {
      return handleError(error, reply, request);
    }
  });

  app.get('/admin/github/links', { preHandler: admin, schema: schema() }, async (_request, reply) => reply.send({ links: await listLinks() }));

  app.post<{ Params: { id: string } }>(
    '/admin/github/links/:id/test',
    { preHandler: admin, schema: schema({ params: projectParams, description: 'Checks the link of the project with this id.' }) },
    async (request, reply) => {
      try {
        return reply.send(await testLink(requireClient(), request.params.id));
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { repoId: number; folder: string; baseBranch?: string } }>(
    '/projects/:id/github-link',
    {
      preHandler: admin,
      schema: schema({
        params: projectParams,
        body: {
          type: 'object',
          required: ['repoId', 'folder'],
          additionalProperties: false,
          properties: {
            repoId: { type: 'integer', minimum: 1 },
            folder: { type: 'string', minLength: 1, maxLength: 300 },
            baseBranch: { type: 'string', maxLength: 250 },
          },
        },
      }),
    },
    async (request, reply) => {
      try {
        if (!(await projectExists(request.params.id))) return reply.code(404).send({ error: 'Project not found' });
        const link = await setLink(requireClient(), { projectId: request.params.id, userId: request.session.user!.id, ...request.body });
        await recordAudit({
          event: 'github_link_set',
          actorUserId: request.session.user!.id,
          ip: clientIp(request),
          detail: { projectId: link.projectId, repo: link.repoFullName, folder: link.folder, baseBranch: link.baseBranch },
        });
        return reply.send({ link });
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/projects/:id/github-link', { preHandler: admin, schema: schema({ params: projectParams }) }, async (request, reply) => {
    try {
      const link = await removeLink(request.params.id);
      await recordAudit({
        event: 'github_link_removed',
        actorUserId: request.session.user!.id,
        ip: clientIp(request),
        detail: { projectId: link.projectId, repo: link.repoFullName, folder: link.folder },
      });
      return reply.code(204).send();
    } catch (error) {
      return handleError(error, reply, request);
    }
  });

  // What a project member needs to know: whether submitting is possible, and where it goes.
  app.get<{ Params: { id: string } }>(
    '/projects/:id/github-link',
    { preHandler: [requireAuth, requireProjectAccess('view', 'id')], schema: schema({ params: projectParams }) },
    async (request, reply) => {
      if (!(await projectExists(request.params.id))) return reply.code(404).send({ error: 'Project not found' });
      const link = client ? await getLinkForProject(request.params.id) : null;
      return reply.send({
        enabled: Boolean(client),
        link: link ? { repoFullName: link.repoFullName, folder: link.folder, baseBranch: link.baseBranch } : null,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/submissions',
    { preHandler: requireDiagramAccess('edit'), schema: schema({ params: projectParams, description: 'Submits the saved diagram to GitHub for approval.' }) },
    async (request, reply) => {
      try {
        const user = request.session.user!;
        const result = await submitDiagram(requireClient(), request.params.id, { id: user.id, name: user.name, email: user.email }, config.publicUrl);
        return reply.code(result.outcome === 'created' ? 201 : 200).send(result);
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/submission',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: projectParams }) },
    async (request, reply) => {
      try {
        const diagram = await getDiagram(request.params.id);
        const link = client ? await getLinkForProject(diagram.projectId) : null;
        const latest = await getLatestSubmission(diagram.id);
        const level = await resolveDiagramAccess(request.session.user!.id, diagram.id);
        const { blocking, warnings } = await checkSubmittable(diagram.diagramTypeId, diagram.dslFamily, diagram.dslContent);
        const fingerprint = submissionFingerprint(diagram.dslContent, diagram.name, diagram.description);

        let reason: string | null = null;
        if (!client) reason = 'github_disabled';
        else if (!link) reason = 'not_linked';
        else if (!accessAtLeast(level, 'edit')) reason = 'no_edit_access';
        else if (blocking.length > 0) reason = 'must_fix';

        const { fingerprint: submittedFingerprint, ...current } = latest ?? { fingerprint: null };
        return reply.send({
          enabled: Boolean(client),
          link: link ? { repoFullName: link.repoFullName, folder: link.folder, baseBranch: link.baseBranch } : null,
          current: latest ? current : null,
          changesSinceSubmitting: latest ? submittedFingerprint !== fingerprint : false,
          canSubmit: { allowed: reason === null, reason, mustFixCount: blocking.length, warningCount: warnings.length },
        });
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );
}
