import { randomUUID } from 'node:crypto';
import { generateText, stepCountIs, type LanguageModel } from 'ai';
import { getDslFamily, isParseSuccess, validate, type DiagramModel, type StandardRules } from '@canvas/diagram-core';
import { getActiveStandard } from '../standards/standard.service.js';
import { buildStandardPrompt } from './standard-prompt.js';
import { getDb } from '../db/client.js';
import { getPersona } from './persona.service.js';
import { listReferenceMaterialForFamily } from './persona-reference-material.service.js';
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

/**
 * canvas-s3o: Create with AI's planning phase. Turns in `plan` mode get NO drawing tools -- with tools
 * available a model tends to draw on its first reply, skipping the persona's clarifying questions --
 * and this section tells it what the phase is for. The user ends it with the dialog's Create diagram
 * button, which sends a normal (`build`) turn.
 */
export type ChatMode = 'plan' | 'build';
export const PLANNING_INSTRUCTIONS = [
  'The user is describing a NEW diagram in the "Create with AI" dialog. Nothing is drawn in this phase -- you have no drawing tools yet.',
  'Follow your clarifying-question practice: if anything that materially changes the diagram is unclear (scope, audience, level of detail, notation), ask concise numbered questions, offering a default for each.',
  'When you have enough, play back in a few lines what you will build -- the diagram type, scope, the main elements, and your key assumptions -- and tell the user to click "Create diagram" when they are happy, or to reply with changes.',
  'Do not output the diagram itself (no Mermaid, code or element lists longer than a short outline) in this phase.',
].join('\n');

const DEFAULT_SYSTEM_PROMPT = 'You are an assistant that helps create and edit flowchart diagrams.';

async function getOrCreateDiagramChat(
  diagramId: string,
  personaId: string | undefined,
): Promise<{ id: string; personaId: string | null }> {
  const db = getDb();
  const existing = await db
    .selectFrom('diagram_chats')
    .select(['id', 'persona_id'])
    .where('diagram_id', '=', diagramId)
    .executeTakeFirst();
  if (existing) return { id: existing.id, personaId: existing.persona_id };

  // The persona is fixed at creation (FR-008a) — only the *first* message for a diagram can set
  // it; this INSERT is the one place personaId is ever written.
  const inserted = await db
    .insertInto('diagram_chats')
    .values({ id: randomUUID(), diagram_id: diagramId, persona_id: personaId ?? null })
    .returning(['id', 'persona_id'])
    .executeTakeFirstOrThrow();
  return { id: inserted.id, personaId: inserted.persona_id };
}

/** FR-015/Story 4: full conversation history for a diagram, oldest first. Empty array (not an
 * error) for a diagram with no chat activity yet. */
export async function getChatMessages(diagramId: string): Promise<ChatMessageRecord[]> {
  const db = getDb();
  const chat = await db
    .selectFrom('diagram_chats')
    .select('id')
    .where('diagram_id', '=', diagramId)
    .executeTakeFirst();
  if (!chat) return [];

  const rows = await db
    .selectFrom('chat_messages')
    .select(['id', 'role', 'content', 'tool_calls', 'created_at'])
    .where('diagram_chat_id', '=', chat.id)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls as ToolCallOutcome[] | null,
    // Matches every other hand-written row-to-record mapper in this codebase: node-postgres
    // returns a native Date for TIMESTAMPTZ (see db/schema.ts's module doc) but this interface's
    // field has always been declared `string` — an existing, pre-this-phase convention, not
    // something newly introduced by converting this one query to Kysely.
    createdAt: r.created_at as unknown as string,
  }));
}

/** A short textual summary of the current diagram, given to the model each turn so it can
 * reference existing shapes/connectors by id (e.g. to remove or rename one). canvas-tfr: under a
 * standard it also shows each element's kind and the violations the diagram currently has. */
function describeModel(model: DiagramModel, rules?: StandardRules): string {
  const nodes =
    model.nodes
      .map((n) => `- ${n.id}: "${n.label}" (${n.shape}${rules && n.role ? `, kind: ${n.role}${n.external ? ' external' : ''}` : ''})`)
      .join('\n') || '(none yet)';
  const edges =
    model.edges.map((e) => `- ${e.id}: ${e.sourceId} -> ${e.targetId}${e.label ? ` ("${e.label}")` : ''}`).join('\n') ||
    '(none yet)';
  let summary = `Current shapes:\n${nodes}\n\nCurrent connectors:\n${edges}`;
  if (rules) {
    const violations = validate(model, rules).slice(0, 10);
    if (violations.length > 0) {
      summary += `\n\nCurrent standard violations:\n${violations.map((v) => `- [${v.severity}] ${v.elementId}: ${v.message}`).join('\n')}`;
    }
  }
  return summary;
}

/** 010-ai-diagram-knowledge, T008/T031 (research.md §2, contracts/api-ai-chat-contract.md):
 * composition order (each appended section under its own `##` heading, canvas-7wx) is persona's
 * own system prompt (or the default) → that family's
 * domain-concept primer → the active standard, if any (canvas-tfr) → the persona's reference-material entries scoped to `dslFamily` or
 * unscoped (User Story 4) → the current diagram's summary. Reference material is never placed
 * ahead of or in place of the persona's own system prompt (FR-008); a persona with no matching
 * entries (including one with none at all, e.g. no `personaId`) behaves identically to before
 * User Story 4 existed. */
async function buildSystemPrompt(
  personaId: string | null,
  personaSystemPrompt: string | undefined,
  dslFamily: string,
  model: DiagramModel,
  rules?: StandardRules,
  mode: ChatMode = 'build',
): Promise<string> {
  // canvas-7wx: the persona's own prompt comes first, untouched. Each section the app appends gets
  // its own `##` heading -- persona prompts are authored in Markdown, and without headings
  // everything appended would read as part of whichever section the persona's prompt ended on.
  const parts = [personaSystemPrompt ?? DEFAULT_SYSTEM_PROMPT];
  const section = (heading: string, body: string) => parts.push(`## ${heading}\n\n${body}`);
  const primer = getDiagramTypePrimer(dslFamily);
  if (primer) section('Diagram type', primer.summary);
  // canvas-tfr: the active standard sits after the generic family primer (it narrows it) and
  // before the persona's reference material and the model summary.
  const standardPrompt = rules ? buildStandardPrompt(rules, dslFamily) : undefined;
  if (standardPrompt) section('Diagram standard', standardPrompt);
  if (personaId) {
    const referenceMaterial = await listReferenceMaterialForFamily(personaId, dslFamily);
    if (referenceMaterial.length > 0) section('Reference material', referenceMaterial.map((entry) => entry.content).join('\n\n'));
  }
  section('Current diagram', describeModel(model, rules));
  if (mode === 'plan') section('Create with AI — planning', PLANNING_INSTRUCTIONS);
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
  /** canvas-tfr: the diagram's type, used to load its active standard. Omitted = no standard. */
  diagramTypeId?: string;
  /** canvas-s3o: 'plan' = Create with AI's planning phase (no drawing tools); default 'build'. */
  mode?: ChatMode;
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

  const standard = input.diagramTypeId ? await getActiveStandard(input.diagramTypeId) : null;
  const rules = standard?.rules;

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
    rules,
  );

  const mode: ChatMode = input.mode ?? 'build';
  const system = await buildSystemPrompt(chat.personaId, persona?.systemPrompt, input.dslFamily, model, rules, mode);

  const result = await generateText({
    model: input.model ?? getLanguageModel(),
    system,
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content }) as const),
      { role: 'user' as const, content: input.message },
    ],
    // canvas-s3o: a planning turn can only talk -- no tools, one step.
    tools: mode === 'plan' ? {} : tools,
    // canvas-tfr: a few extra steps under a standard so the model can fix the newViolations its
    // own edits introduced within the same turn.
    stopWhen: stepCountIs(mode === 'plan' ? 1 : rules ? 8 : 5),
  });

  const updatedDslContent = family.serialize(model);

  const db = getDb();
  await db
    .insertInto('chat_messages')
    .values({ id: randomUUID(), diagram_chat_id: chat.id, role: 'user', content: input.message })
    .execute();
  await db
    .insertInto('chat_messages')
    .values({
      id: randomUUID(),
      diagram_chat_id: chat.id,
      role: 'assistant',
      content: result.text,
      // JSON.stringify is required, not optional — see db/schema.ts's JsonColumn doc.
      tool_calls: JSON.stringify(toolCalls),
    })
    .execute();

  return { assistantMessage: result.text, updatedDslContent, toolCalls };
}
