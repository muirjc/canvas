import type { FastifyInstance, FastifyReply } from 'fastify';
import { errorResponse } from '../contract/schemas.js';
import type { LanguageModel } from 'ai';
import { requireDiagramAccess } from '../auth/access-control.middleware.js';
import { canSeeUsage, getAiSettings } from './ai-settings.service.js';
import { diagramUsageTotal } from './ai-usage.service.js';
import { DslParseError, getChatMessages, sendChatMessage } from './diagram-chat.service.js';
import { getDiagram } from '../diagrams/diagram.service.js';

export interface DiagramChatRoutesOptions {
  /** Test injection point (research.md §8); production omits this and each call resolves the
   * configured provider itself. */
  languageModel?: LanguageModel;
}

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof DslParseError) {
    return reply.code(422).send({ error: error.message });
  }
  throw error;
}

/**
 * FR-008b: both routes require `edit`-level access — the conversation is visible to and
 * continuable by every collaborator who could also make the equivalent manual edit, not a wider
 * "anyone who can view" audience.
 */
export async function registerDiagramChatRoutes(
  app: FastifyInstance,
  options: DiagramChatRoutesOptions = {},
): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: { message: string; currentDslContent: string; personaId?: string; mode?: 'plan' | 'build' };
  }>(
    '/diagrams/:id/chat/messages',
    {
      preHandler: requireDiagramAccess('edit'),
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if` --
      // the chatEnabled feature-flag gate below stays in the handler since it's a runtime
      // business-rule check, not a request-shape one.
      schema: {
        tags: ['AI'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['message', 'currentDslContent'],
          properties: {
            message: { type: 'string', minLength: 1 },
            currentDslContent: { type: 'string', minLength: 1 },
            personaId: { type: 'string' },
            // canvas-s3o: Create with AI's planning phase -- the model can talk but not draw.
            mode: { type: 'string', enum: ['plan', 'build'] },
          },
        },
        // canvas-1bty.12: response shapes (src/contract/schemas.ts), so the Python service answers the same.
        response: {
          200: {
            type: 'object',
            required: ['assistantMessage', 'assistantMessageId', 'updatedDslContent', 'toolCalls'],
            additionalProperties: false,
            // usage: only for users who may see token counts.
            properties: {
              assistantMessage: { type: 'string' },
              assistantMessageId: { type: 'string' },
              usage: { $ref: 'TokenCounts#' },
              updatedDslContent: { type: 'string' },
              toolCalls: { type: 'array', items: { $ref: 'ToolCallOutcome#' } },
            },
          },
          '4xx': errorResponse,
          '5xx': errorResponse,
        },
      },
    },
    async (request, reply) => {
      const settings = await getAiSettings();
      if (!settings.chatEnabled) {
        return reply.code(503).send({ error: 'AI chat is currently disabled by an administrator.' });
      }

      const { message, currentDslContent, personaId, mode } = request.body;

      try {
        // 010-ai-diagram-knowledge, T003: resolve the diagram's real dslFamily the same way every
        // other diagram-mutating route already does, instead of leaving sendChatMessage to assume
        // flowchart — research.md §1.
        const diagram = await getDiagram(request.params.id);
        const result = await sendChatMessage({
          diagramId: request.params.id,
          message,
          currentDslContent,
          dslFamily: diagram.dslFamily,
          diagramTypeId: diagram.diagramTypeId,
          personaId,
          mode,
          userId: request.session.user?.id,
          model: options.languageModel,
        });
        // canvas-4k9: token counts only for users allowed to see them (setting; admins always).
        if (!(await canSeeUsage(request.session.user?.role))) delete result.usage;
        return reply.send(result);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/chat/messages',
    {
      preHandler: requireDiagramAccess('edit'),
      schema: {
        tags: ['AI'],
        security: [{ cookieAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['messages'],
            additionalProperties: false,
            // usageTotal: only for users who may see token counts.
            properties: {
              messages: { type: 'array', items: { $ref: 'ChatMessage#' } },
              usageTotal: {
                type: 'object',
                required: ['requests', 'inputTokens', 'outputTokens', 'totalTokens'],
                additionalProperties: false,
                properties: {
                  requests: { type: 'integer' },
                  inputTokens: { type: 'integer' },
                  outputTokens: { type: 'integer' },
                  totalTokens: { type: 'integer' },
                },
              },
            },
          },
          '4xx': errorResponse,
        },
      },
    },
    async (request, reply) => {
      const withUsage = await canSeeUsage(request.session.user?.role);
      const messages = await getChatMessages(request.params.id, { withUsage });
      return reply.send(withUsage ? { messages, usageTotal: await diagramUsageTotal(request.params.id) } : { messages });
    },
  );
}
