import type { FastifyInstance, FastifyReply } from 'fastify';
import type { LanguageModel } from 'ai';
import { requireDiagramAccess } from '../auth/access-control.middleware.js';
import { getAiSettings } from './ai-settings.service.js';
import { DslParseError, getChatMessages, sendChatMessage } from './diagram-chat.service.js';

export interface DiagramChatRoutesOptions {
  /** Test injection point (research.md §8); production omits this and each call resolves the
   * configured provider itself. */
  languageModel?: LanguageModel;
}

function handleError(error: unknown, reply: FastifyReply): void {
  if (error instanceof DslParseError) {
    reply.code(422).send({ error: error.message });
    return;
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
    Body: { message: string; currentDslContent: string; personaId?: string };
  }>('/diagrams/:id/chat/messages', { preHandler: requireDiagramAccess('edit') }, async (request, reply) => {
    const settings = await getAiSettings();
    if (!settings.chatEnabled) {
      reply.code(503).send({ error: 'AI chat is currently disabled by an administrator.' });
      return;
    }

    const { message, currentDslContent, personaId } = request.body;
    if (!message || !currentDslContent) {
      reply.code(400).send({ error: 'message and currentDslContent are required' });
      return;
    }

    try {
      const result = await sendChatMessage({
        diagramId: request.params.id,
        message,
        currentDslContent,
        personaId,
        model: options.languageModel,
      });
      reply.send(result);
    } catch (error) {
      handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/chat/messages',
    { preHandler: requireDiagramAccess('edit') },
    async (request, reply) => {
      reply.send({ messages: await getChatMessages(request.params.id) });
    },
  );
}
