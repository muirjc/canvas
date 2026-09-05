import { generateText, stepCountIs, type LanguageModel } from 'ai';
import { getDslFamily, isParseSuccess, type DiagramModel } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';
import { getPersona } from './persona.service.js';
import { createDiagramTools, type ToolCallOutcome } from './diagram-tools.js';
import { getDiagramTypePrimer } from './diagram-type-primers.js';
import { getLanguageModel } from './provider.js';

export class DslParseError extends Error {}

export interface ChatMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallOutcome[] | null;
  createdAt: string;
}

const DEFAULT_SYSTEM_PROMPT = 'You are an assistant that helps create and edit flowchart diagrams.';

async function getOrCreateDiagramChat(
  diagramId: string,
  personaId: string | undefined,
): Promise<{ id: string; personaId: string | null }> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; persona_id: string | null }>(
    'SELECT id, persona_id FROM diagram_chats WHERE diagram_id = $1',
    [diagramId],
  );
  if (rows[0]) return { id: rows[0].id, personaId: rows[0].persona_id };

  // The persona is fixed at creation (FR-008a) — only the *first* message for a diagram can set
  // it; this INSERT is the one place personaId is ever written.
  const inserted = await pool.query<{ id: string; persona_id: string | null }>(
    'INSERT INTO diagram_chats (diagram_id, persona_id) VALUES ($1, $2) RETURNING id, persona_id',
    [diagramId, personaId ?? null],
  );
  return { id: inserted.rows[0].id, personaId: inserted.rows[0].persona_id };
}

/** FR-015/Story 4: full conversation history for a diagram, oldest first. Empty array (not an
 * error) for a diagram with no chat activity yet. */
export async function getChatMessages(diagramId: string): Promise<ChatMessageRecord[]> {
  const pool = getPool();
  const { rows: chatRows } = await pool.query<{ id: string }>(
    'SELECT id FROM diagram_chats WHERE diagram_id = $1',
    [diagramId],
  );
  if (!chatRows[0]) return [];

  const { rows } = await pool.query<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    tool_calls: ToolCallOutcome[] | null;
    created_at: string;
  }>(
    'SELECT id, role, content, tool_calls, created_at FROM chat_messages WHERE diagram_chat_id = $1 ORDER BY created_at',
    [chatRows[0].id],
  );
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, toolCalls: r.tool_calls, createdAt: r.created_at }));
}

/** A short textual summary of the current diagram, given to the model each turn so it can
 * reference existing shapes/connectors by id (e.g. to remove or rename one). */
function describeModel(model: DiagramModel): string {
  const nodes = model.nodes.map((n) => `- ${n.id}: "${n.label}" (${n.shape})`).join('\n') || '(none yet)';
  const edges =
    model.edges.map((e) => `- ${e.id}: ${e.sourceId} -> ${e.targetId}${e.label ? ` ("${e.label}")` : ''}`).join('\n') ||
    '(none yet)';
  return `Current shapes:\n${nodes}\n\nCurrent connectors:\n${edges}`;
}

/** 010-ai-diagram-knowledge, T008 (research.md §2, contracts/api-ai-chat-contract.md): composition
 * order is persona's own system prompt (or the default) → that family's domain-concept primer →
 * (T031 inserts the persona's family-relevant reference-material entries here) → the current
 * diagram's summary. Reference material is never placed ahead of or in place of the persona's own
 * system prompt (FR-008). */
async function buildSystemPrompt(personaSystemPrompt: string | undefined, dslFamily: string, model: DiagramModel): Promise<string> {
  const parts = [personaSystemPrompt ?? DEFAULT_SYSTEM_PROMPT];
  const primer = getDiagramTypePrimer(dslFamily);
  if (primer) parts.push(primer.summary);
  parts.push(describeModel(model));
  return parts.join('\n\n');
}

export interface SendChatMessageInput {
  diagramId: string;
  message: string;
  currentDslContent: string;
  /** 010-ai-diagram-knowledge, T003: the diagram's real DSL family (e.g. "erd", "c4"), resolved
   * by the caller via the same `getDiagram`/`loadDiagramTypeDslFamily` lookup every other
   * diagram-mutating code path already uses (research.md §1) — this function used to hardcode
   * `getDslFamily('flowchart')` regardless of the diagram's actual type, a confirmed live bug
   * (any non-flowchart diagram's chat request threw a 422 DslParseError). Required, not optional:
   * there is no safe default family to fall back to. */
  dslFamily: string;
  personaId?: string;
  /** Test injection point (research.md §8) — production callers omit this and the configured
   * provider (apps/api/src/ai/provider.ts) is used. */
  model?: LanguageModel;
}

export interface SendChatMessageResult {
  assistantMessage: string;
  updatedDslContent: string;
  toolCalls: ToolCallOutcome[];
}

export async function sendChatMessage(input: SendChatMessageInput): Promise<SendChatMessageResult> {
  const family = getDslFamily(input.dslFamily);
  if (!family) {
    throw new DslParseError(`No DSL family registered for: ${input.dslFamily}`);
  }
  const parsed = family.parse(input.currentDslContent);
  if (!isParseSuccess(parsed)) {
    throw new DslParseError('currentDslContent could not be parsed');
  }
  let model = parsed.model;

  const chat = await getOrCreateDiagramChat(input.diagramId, input.personaId);
  const persona = chat.personaId ? await getPersona(chat.personaId) : undefined;
  const history = await getChatMessages(input.diagramId);

  const toolCalls: ToolCallOutcome[] = [];
  const tools = createDiagramTools(
    {
      getModel: () => model,
      setModel: (m) => {
        model = m;
      },
      recordOutcome: (outcome) => toolCalls.push(outcome),
    },
    input.dslFamily,
  );

  const system = await buildSystemPrompt(persona?.systemPrompt, input.dslFamily, model);

  const result = await generateText({
    model: input.model ?? getLanguageModel(),
    system,
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content }) as const),
      { role: 'user' as const, content: input.message },
    ],
    tools,
    stopWhen: stepCountIs(5),
  });

  const updatedDslContent = family.serialize(model);

  const pool = getPool();
  await pool.query('INSERT INTO chat_messages (diagram_chat_id, role, content) VALUES ($1, $2, $3)', [
    chat.id,
    'user',
    input.message,
  ]);
  await pool.query(
    'INSERT INTO chat_messages (diagram_chat_id, role, content, tool_calls) VALUES ($1, $2, $3, $4)',
    [chat.id, 'assistant', result.text, JSON.stringify(toolCalls)],
  );

  return { assistantMessage: result.text, updatedDslContent, toolCalls };
}
