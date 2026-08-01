import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';

/**
 * A small, deterministic rule-based "NLU" used only when `AI_PROVIDER=mock` (server.ts) — lets
 * E2E tests exercise the real HTTP/tool-execution/persistence pipeline end to end without a real
 * provider (research.md §8), by recognizing a few fixed phrasings E2E specs are written against.
 * Not used by contract tests, which construct their own narrowly-scoped `MockLanguageModelV4`
 * per test instead.
 */
function noToolCallResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
}

function toolCallResult(toolName: string, input: Record<string, unknown>): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call' as const, toolCallId: `mock-${Date.now()}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  const message = [...options.prompt].reverse().find((m) => m.role === 'user');
  if (!message) return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

function systemText(options: LanguageModelV4CallOptions): string {
  return options.prompt.find((m) => m.role === 'system')?.content ?? '';
}

/** Maps a shape's label (as mentioned in natural language) to its id, by reading the
 * `describeModel()` summary embedded in the system prompt (diagram-chat.service.ts). */
function findIdByLabel(system: string, label: string): string | undefined {
  const match = system.match(new RegExp(`- (\\S+): "${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i'));
  return match?.[1];
}

const SHAPE_WORDS = ['rectangle', 'rounded-rectangle', 'circle', 'diamond', 'cylinder'] as const;

const COLOR_WORDS: Record<string, string> = {
  red: '#c0392b',
  green: '#27ae60',
  blue: '#2980b9',
  yellow: '#f1c40f',
  orange: '#e67e22',
  purple: '#8e44ad',
  black: '#000000',
  white: '#ffffff',
  gray: '#7f8c8d',
  grey: '#7f8c8d',
};

export function createMockLanguageModel() {
  return new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      // A tool result already came back this turn — finish with a short confirmation instead of
      // calling another tool, keeping each user message to exactly one tool call.
      if (options.prompt[options.prompt.length - 1]?.role === 'tool') {
        return noToolCallResult('Done.');
      }

      const text = lastUserText(options);
      const system = systemText(options);

      const addMatch = text.match(/add (?:an? )?(?:(\S+) )?shape (?:called|named) ['"]?([^'".]+)['"]?/i);
      if (addMatch) {
        const shape = SHAPE_WORDS.includes(addMatch[1] as (typeof SHAPE_WORDS)[number])
          ? addMatch[1]
          : 'rectangle';
        return toolCallResult('addNode', { shape, label: addMatch[2].trim() });
      }

      const connectMatch = text.match(/connect ['"]?([^'".]+?)['"]? to ['"]?([^'".]+)['"]?/i);
      if (connectMatch) {
        const sourceId = findIdByLabel(system, connectMatch[1].trim());
        const targetId = findIdByLabel(system, connectMatch[2].trim());
        if (sourceId && targetId) {
          return toolCallResult('addEdge', { sourceId, targetId });
        }
        return toolCallResult('addEdge', { sourceId: sourceId ?? connectMatch[1].trim(), targetId: targetId ?? connectMatch[2].trim() });
      }

      const removeMatch = text.match(/remove (?:the )?shape (?:called |named )?['"]?([^'".]+)['"]?/i);
      if (removeMatch) {
        const nodeId = findIdByLabel(system, removeMatch[1].trim()) ?? removeMatch[1].trim();
        return toolCallResult('removeNode', { nodeId });
      }

      const renameMatch = text.match(/rename ['"]?([^'".]+?)['"]? to ['"]?([^'".]+)['"]?/i);
      if (renameMatch) {
        const nodeId = findIdByLabel(system, renameMatch[1].trim()) ?? renameMatch[1].trim();
        return toolCallResult('updateNodeLabel', { nodeId, label: renameMatch[2].trim() });
      }

      const colorWords = Object.keys(COLOR_WORDS).join('|');
      const colorMatch = text.match(
        new RegExp(`(?:make|color) (?:the )?['"]?([^'".]+?)['"]? ?(?:node |shape )?(${colorWords})\\b`, 'i'),
      );
      if (colorMatch) {
        const nodeId = findIdByLabel(system, colorMatch[1].trim()) ?? colorMatch[1].trim();
        return toolCallResult('updateNodeStyle', { nodeId, fillColor: COLOR_WORDS[colorMatch[2].toLowerCase()] });
      }

      return noToolCallResult("I'm not sure how to help with that.");
    },
  });
}
