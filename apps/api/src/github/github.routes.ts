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
  getApprovedSubmission,
  getLatestSubmission,
  listSubmissionHistory,
  projectSubmissionBadges,
  submitDiagram,
  SubmissionBlockedError,
  SubmissionConflictError,
  SubmissionInProgressError,
  SubmissionLinkChangedError,
  SubmissionNotLinkedError,
} from './submission.service.js';
import { submissionFingerprint } from './submission-files.js';
import { exampleWorkflow, validatorBundle } from './validator-bundle.js';
import { envelope, errorResponse, listEnvelope, noContent, objectResponse } from '../contract/schemas.js';
import { refreshDiagramSubmission, SubmissionNotOpenError, withdrawSubmission } from './status-sync.service.js';

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
  if (error instanceof SubmissionNotOpenError) return reply.code(409).send({ error: error.message, code: 'not_open' });
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

// canvas-1bty.11: response shapes (src/contract/schemas.ts), so the Python service answers the same.
const errors = { '4xx': errorResponse, '5xx': errorResponse };
const submissionStatusResponse = { 200: { $ref: 'SubmissionStatus#' }, ...errors };
const violations = { type: 'array', items: { type: 'object', additionalProperties: true } } as const;
const statusResponse = {
  type: 'object',
  required: ['enabled', 'installations'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    appId: { type: 'string' },
    apiUrl: { type: 'string' },
    installations: { type: 'array', items: { $ref: 'GitHubInstallation#' } },
    validatorAvailable: { type: 'boolean' },
    error: { type: 'string' },
  },
};
const linkTest = objectResponse({
  ok: { type: 'boolean' },
  checks: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'label', 'ok'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', enum: ['installation', 'repository', 'branch', 'contents', 'pull_requests'] },
        label: { type: 'string' },
        ok: { type: 'boolean' },
        detail: { type: 'string' },
      },
    },
  },
});
const submitResult = objectResponse({
  outcome: { type: 'string', enum: ['created', 'updated', 'upToDate'] },
  submission: { anyOf: [{ $ref: 'Submission#' }, { type: 'null' }] },
  warnings: violations,
});

export async function registerGitHubRoutes(app: FastifyInstance, config: AppConfig, fetchImpl?: typeof fetch): Promise<void> {
  const client = config.github ? new GitHubClient(config.github, fetchImpl) : null;
  const requireClient = (): GitHubClient => {
    if (!client) throw new GitHubDisabledError();
    return client;
  };
  const admin = requireRole('admin');

  app.get('/admin/github/status', { preHandler: admin, schema: schema({ response: { 200: statusResponse, ...errors } }) }, async (request, reply) => {
    if (!client) return reply.send({ enabled: false, installations: [] });
    try {
      const installations = await client.listInstallations();
      return reply.send({ enabled: true, appId: client.appId, apiUrl: client.apiUrl, installations, validatorAvailable: validatorBundle() !== null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      request.log.warn({ message }, 'GitHub status check failed');
      return reply.send({ enabled: true, appId: client.appId, apiUrl: client.apiUrl, installations: [], error: message, validatorAvailable: validatorBundle() !== null });
    }
  });

  app.get('/admin/github/repositories', { preHandler: admin, schema: schema({ response: { 200: listEnvelope('repositories', 'GitHubRepository'), ...errors } }) }, async (request, reply) => {
    try {
      return reply.send({ repositories: await listInstalledRepositories(requireClient()) });
    } catch (error) {
      return handleError(error, reply, request);
    }
  });

  // canvas-3s5.3: the example workflow that runs the committed validator in the repository's CI.
  app.get('/admin/github/workflow-example',
    {
      preHandler: admin,
      schema: schema({
        response: { 200: { description: 'The example workflow', content: { 'text/yaml': { schema: { type: 'string' } } } }, ...errors },
      }),
    }, async (_request, reply) => {
    const workflow = exampleWorkflow();
    if (!workflow) return reply.code(404).send({ error: 'The example workflow is not available (packages/validator-cli has not been built).' });
    return reply
      .header('content-type', 'text/yaml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="canvas-diagrams.yml"')
      .send(workflow);
  });

  app.get('/admin/github/links', { preHandler: admin, schema: schema({ response: { 200: listEnvelope('links', 'GitHubLink'), ...errors } }) }, async (_request, reply) => reply.send({ links: await listLinks() }));

  app.post<{ Params: { id: string } }>(
    '/admin/github/links/:id/test',
    { preHandler: admin, schema: schema({ params: projectParams, description: 'Checks the link of the project with this id.', response: { 200: linkTest, ...errors } }) },
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
        response: { 200: envelope('link', 'GitHubLink'), ...errors },
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

  app.delete<{ Params: { id: string } }>('/projects/:id/github-link', { preHandler: admin, schema: schema({ params: projectParams, response: { 204: noContent, ...errors } }) }, async (request, reply) => {
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
    {
      preHandler: [requireAuth, requireProjectAccess('view', 'id')],
      schema: schema({
        params: projectParams,
        response: { 200: objectResponse({ enabled: { type: 'boolean' }, link: { anyOf: [{ $ref: 'GitHubLinkSummary#' }, { type: 'null' }] } }), ...errors },
      }),
    },
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
    { preHandler: requireDiagramAccess('edit'), schema: schema({ params: projectParams, description: 'Submits the saved diagram to GitHub for approval.', response: { 200: submitResult, 201: submitResult, ...errors } }) },
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

  /** What the editor shows: where submitting goes, the latest pull request, the approved version. */
  async function submissionStatus(diagramId: string, userId: string) {
    const diagram = await getDiagram(diagramId);
    const link = client ? await getLinkForProject(diagram.projectId) : null;
    const latest = await getLatestSubmission(diagram.id);
    const approved = await getApprovedSubmission(diagram.id);
    const level = await resolveDiagramAccess(userId, diagram.id);
    const { blocking, warnings } = await checkSubmittable(diagram.diagramTypeId, diagram.dslFamily, diagram.dslContent);
    const fingerprint = submissionFingerprint(diagram.dslContent, diagram.name, diagram.description);

    let reason: string | null = null;
    if (!client) reason = 'github_disabled';
    else if (!link) reason = 'not_linked';
    else if (!accessAtLeast(level, 'edit')) reason = 'no_edit_access';
    else if (blocking.length > 0) reason = 'must_fix';

    const { fingerprint: submittedFingerprint, ...current } = latest ?? { fingerprint: null };
    return {
      enabled: Boolean(client),
      link: link ? { repoFullName: link.repoFullName, folder: link.folder, baseBranch: link.baseBranch } : null,
      current: latest ? current : null,
      approved,
      changesSinceSubmitting: latest ? submittedFingerprint !== fingerprint : false,
      canSubmit: { allowed: reason === null, reason, mustFixCount: blocking.length, warningCount: warnings.length },
      canWithdraw: Boolean(client) && latest?.state === 'open' && accessAtLeast(level, 'edit'),
    };
  }

  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/submission',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: projectParams, response: submissionStatusResponse }) },
    async (request, reply) => {
      try {
        return reply.send(await submissionStatus(request.params.id, request.session.user!.id));
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  // canvas-3s5.2: ask GitHub now (throttled per pull request), then answer like GET.
  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/submission/refresh',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: projectParams, response: submissionStatusResponse }) },
    async (request, reply) => {
      try {
        await getDiagram(request.params.id);
        if (client) await refreshDiagramSubmission(client, request.params.id);
        return reply.send(await submissionStatus(request.params.id, request.session.user!.id));
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/submission/withdraw',
    { preHandler: requireDiagramAccess('edit'), schema: schema({ params: projectParams, description: "Closes the diagram's open pull request.", response: submissionStatusResponse }) },
    async (request, reply) => {
      try {
        await getDiagram(request.params.id);
        const user = request.session.user!;
        await withdrawSubmission(requireClient(), request.params.id, { id: user.id, name: user.name });
        return reply.send(await submissionStatus(request.params.id, user.id));
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/submissions',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: projectParams, response: { 200: listEnvelope('submissions', 'Submission'), ...errors } }) },
    async (request, reply) => {
      try {
        await getDiagram(request.params.id);
        return reply.send({ submissions: await listSubmissionHistory(request.params.id) });
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  // Badges on a project's diagram list.
  app.get<{ Params: { id: string } }>(
    '/projects/:id/submission-statuses',
    {
      preHandler: [requireAuth, requireProjectAccess('view', 'id')],
      schema: schema({
        params: projectParams,
        response: { 200: objectResponse({ statuses: { type: 'object', additionalProperties: { $ref: 'SubmissionBadge#' } } }), ...errors },
      }),
    },
    async (request, reply) => {
      if (!(await projectExists(request.params.id))) return reply.code(404).send({ error: 'Project not found' });
      return reply.send({ statuses: await projectSubmissionBadges(request.params.id) });
    },
  );
}
