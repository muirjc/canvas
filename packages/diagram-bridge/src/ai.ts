import { asSchema, safeValidateTypes } from '@ai-sdk/provider-utils';
import {
  createDiagramTools,
  type ToolCallOutcome,
} from '../../../apps/api/src/ai/diagram-tools.js';
import { getDiagramTypePrimer } from '../../../apps/api/src/ai/diagram-type-primers.js';
import { buildStandardPrompt } from '../../../apps/api/src/ai/standard-prompt.js';
import { describeModel } from '../../../apps/api/src/ai/describe-model.js';
import type { DiagramModel, StandardRules } from './ai-core.js';

/**
 * canvas-1bty.12: the AI chat's diagram knowledge for the Python service. The tools the model may call,
 * and what they do, stay in TypeScript (apps/api/src/ai/diagram-tools.ts) until diagram-core itself is
 * ported (phase 11): Python runs the conversation with the provider and asks here for the tool list,
 * each tool call's result, and the diagram-specific sections of the system prompt. One copy, so both
 * services offer the model exactly the same tools.
 */

type Tools = Record<
  string,
  {
    description?: string;
    inputSchema: unknown;
    execute?: (input: never, options: never) => unknown;
  }
>;

function toolsFor(family: string, rules: StandardRules | undefined, model: DiagramModel) {
  const state = { model, outcomes: [] as ToolCallOutcome[] };
  const tools = createDiagramTools(
    {
      getModel: () => state.model,
      setModel: (next) => {
        state.model = next;
      },
      recordOutcome: (outcome) => state.outcomes.push(outcome),
    },
    family,
    rules,
  ) as unknown as Tools;
  return { tools, state };
}

const EMPTY_MODEL = { nodes: [], edges: [], containers: [] } as unknown as DiagramModel;

/** The tools offered for a family under a standard, as the JSON Schema the AI SDK sends providers. */
export async function listTools(family: string, rules: StandardRules | undefined) {
  const { tools } = toolsFor(family, rules, EMPTY_MODEL);
  return Promise.all(
    Object.entries(tools).map(async ([name, t]) => ({
      name,
      description: t.description ?? '',
      inputSchema: await asSchema(t.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema,
    })),
  );
}

export type ToolRun =
  | { ok: true; model: DiagramModel; output: unknown; outcomes: ToolCallOutcome[] }
  | { ok: false; error: string };

/**
 * Runs one tool call against `model`. Input that doesn't fit the tool's schema, an unknown tool and an
 * error inside the tool come back as `{ ok: false, error }`, the text the AI SDK reports to the model as
 * that call's failed result (the turn goes on).
 */
export async function runTool(
  family: string,
  rules: StandardRules | undefined,
  model: DiagramModel,
  name: string,
  input: unknown,
): Promise<ToolRun> {
  const { tools, state } = toolsFor(family, rules, model);
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
  if (!tool?.execute) {
    return {
      ok: false,
      error: `Model tried to call unavailable tool '${name}'. Available tools: ${Object.keys(tools).join(', ')}.`,
    };
  }
  // As the AI SDK checks a tool call's input (InvalidToolInputError's message).
  const parsed = await safeValidateTypes({
    value: input,
    schema: asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]),
  });
  if (!parsed.success) {
    return { ok: false, error: `Invalid input for tool ${name}: ${parsed.error.message}` };
  }
  try {
    const output = await tool.execute(
      parsed.value as never,
      { toolCallId: 'bridge', messages: [] } as never,
    );
    return { ok: true, model: state.model, output, outcomes: state.outcomes };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The diagram-specific system prompt sections (diagram-chat.service.ts buildSystemPrompt). */
export function promptSections(
  family: string,
  rules: StandardRules | undefined,
  model: DiagramModel,
) {
  return {
    primer: getDiagramTypePrimer(family)?.summary ?? null,
    standard: (rules ? buildStandardPrompt(rules, family) : undefined) ?? null,
    currentDiagram: describeModel(model, rules),
  };
}
