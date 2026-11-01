import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireDiagramAccess } from '../auth/access-control.middleware.js';
import { getDb } from '../db/client.js';
import { errorResponse, noContent, objectResponse } from '../contract/schemas.js';
import {
  addComment,
  CommentForbiddenError,
  CommentInvalidError,
  CommentNotFoundError,
  deleteComment,
  editComment,
  listThreads,
  markRead,
  MAX_COMMENT_LENGTH,
  setResolved,
  unreadCount,
} from './comment.service.js';

/**
 * canvas-bw4: comments on a diagram. Reading needs view access; posting, replying and resolving
 * need comment access (edit includes it) -- the "comment" share level's whole point. Editing is
 * the author's; deleting is the author's, the diagram owner's or an admin's.
 */
type Params = { id: string; commentId: string };

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof CommentNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof CommentForbiddenError) return reply.code(403).send({ error: error.message });
  if (error instanceof CommentInvalidError) return reply.code(400).send({ error: error.message });
  throw error;
}

async function liveDiagram(id: string): Promise<boolean> {
  const row = await getDb().selectFrom('diagrams').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  return Boolean(row);
}

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;
const commentParams = {
  type: 'object',
  required: ['id', 'commentId'],
  properties: { id: { type: 'string' }, commentId: { type: 'string' } },
} as const;
const schema = (extra: object = {}) => ({ tags: ['Comments'], security: [{ cookieAuth: [] }], ...extra });
const threads = { type: 'array', items: { $ref: 'CommentThread#' } } as const;
const unread = { type: 'integer', minimum: 0 } as const;
const threadsResponse = { 200: objectResponse({ threads }), '4xx': errorResponse };

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/comments',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: idParams, response: { 200: objectResponse({ threads, unread }), '4xx': errorResponse } }) },
    async (request, reply) => {
      if (!(await liveDiagram(request.params.id))) return reply.code(404).send({ error: 'Diagram not found' });
      const userId = request.session.user!.id;
      return reply.send({ threads: await listThreads(request.params.id), unread: await unreadCount(request.params.id, userId) });
    },
  );

  // The tab's badge, without loading every thread.
  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/comments/unread',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: idParams, response: { 200: objectResponse({ unread }), '4xx': errorResponse } }) },
    async (request, reply) => {
      if (!(await liveDiagram(request.params.id))) return reply.code(404).send({ error: 'Diagram not found' });
      return reply.send({ unread: await unreadCount(request.params.id, request.session.user!.id) });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/comments/read',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: idParams, response: { 204: noContent, '4xx': errorResponse } }) },
    async (request, reply) => {
      if (!(await liveDiagram(request.params.id))) return reply.code(404).send({ error: 'Diagram not found' });
      await markRead(request.params.id, request.session.user!.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { body: string; threadRootId?: string; anchor?: { type: 'node' | 'edge' | 'container'; id: string } } }>(
    '/diagrams/:id/comments',
    {
      preHandler: requireDiagramAccess('comment'),
      schema: schema({
        params: idParams,
        body: {
          type: 'object',
          required: ['body'],
          properties: {
            body: { type: 'string', maxLength: MAX_COMMENT_LENGTH + 200 },
            threadRootId: { type: 'string' },
            anchor: {
              type: 'object',
              required: ['type', 'id'],
              properties: { type: { type: 'string', enum: ['node', 'edge', 'container'] }, id: { type: 'string', minLength: 1, maxLength: 200 } },
            },
          },
        },
        response: { 201: objectResponse({ id: { type: 'string' }, threads }), '4xx': errorResponse },
      }),
    },
    async (request, reply) => {
      if (!(await liveDiagram(request.params.id))) return reply.code(404).send({ error: 'Diagram not found' });
      try {
        const id = await addComment({ diagramId: request.params.id, authorId: request.session.user!.id, ...request.body });
        // Your own comment counts as read.
        await markRead(request.params.id, request.session.user!.id);
        return reply.code(201).send({ id, threads: await listThreads(request.params.id) });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.patch<{ Params: Params; Body: { body: string } }>(
    '/diagrams/:id/comments/:commentId',
    {
      preHandler: requireDiagramAccess('comment'),
      schema: schema({
        params: commentParams,
        body: { type: 'object', required: ['body'], properties: { body: { type: 'string', maxLength: MAX_COMMENT_LENGTH + 200 } } },
        response: threadsResponse,
      }),
    },
    async (request, reply) => {
      if (!(await liveDiagram(request.params.id))) return reply.code(404).send({ error: 'Diagram not found' });
      try {
        await editComment({ diagramId: request.params.id, commentId: request.params.commentId, userId: request.session.user!.id, body: request.body.body });
        return reply.send({ threads: await listThreads(request.params.id) });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  // View access is enough to reach this; whether you may delete is decided by the service
  // (author, diagram owner, admin) -- an owner always has edit, an admin always passes.
  app.delete<{ Params: Params }>(
    '/diagrams/:id/comments/:commentId',
    { preHandler: requireDiagramAccess('view'), schema: schema({ params: commentParams, response: threadsResponse }) },
    async (request, reply) => {
      if (!(await liveDiagram(request.params.id))) return reply.code(404).send({ error: 'Diagram not found' });
      try {
        await deleteComment({
          diagramId: request.params.id,
          commentId: request.params.commentId,
          userId: request.session.user!.id,
          isAdmin: request.session.user!.role === 'admin',
        });
        return reply.send({ threads: await listThreads(request.params.id) });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  for (const [path, resolved] of [
    ['resolve', true],
    ['reopen', false],
  ] as const) {
    app.post<{ Params: Params }>(
      `/diagrams/:id/comments/:commentId/${path}`,
      { preHandler: requireDiagramAccess('comment'), schema: schema({ params: commentParams, response: threadsResponse }) },
      async (request, reply) => {
        if (!(await liveDiagram(request.params.id))) return reply.code(404).send({ error: 'Diagram not found' });
        try {
          await setResolved({ diagramId: request.params.id, threadRootId: request.params.commentId, userId: request.session.user!.id, resolved });
          return reply.send({ threads: await listThreads(request.params.id) });
        } catch (error) {
          return handleError(error, reply);
        }
      },
    );
  }
}
