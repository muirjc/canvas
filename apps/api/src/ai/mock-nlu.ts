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

/** Resolves an edge id from its (already-resolved) source/target node ids, reading the same
 * `describeModel()` summary's "Current connectors" section (`- <edgeId>: <sourceId> -> <targetId>...`). */
function findEdgeIdBySourceTarget(system: string, sourceId: string, targetId: string): string | undefined {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = system.match(new RegExp(`- (\\S+): ${escape(sourceId)} -> ${escape(targetId)}`));
  return match?.[1];
}

/** 010-ai-diagram-knowledge, T022: `options.tools` is the actual family-conditional tool set
 * offered THIS turn (`createDiagramTools(context, family)`) — checking this before returning a
 * tool call is what makes the "decline an out-of-family request" scenario (FR-004) work with no
 * hand-authored refusal string: the exact same matched phrase, tried against a family where the
 * tool isn't offered, simply has nothing to return here and falls through to the final fallback. */
function toolAvailable(options: LanguageModelV4CallOptions, name: string): boolean {
  return options.tools?.some((t) => t.name === name) ?? false;
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

      // 010-ai-diagram-knowledge, T034: this file's other rules only ever inspect the system
      // prompt to resolve an id from a label (findIdByLabel) — none of them expose its actual
      // content anywhere the frontend/E2E layer can observe, so there was previously no way for
      // an E2E test to confirm persona reference material (composed into the system prompt,
      // diagram-chat.service.ts's buildSystemPrompt) actually reaches the model for one diagram
      // family and not another. Echoing it back verbatim as the assistant's reply, behind an
      // unambiguous fixed phrase, is a test-only introspection hook — not a real capability a
      // real provider would need or have.
      if (/^what do you know about this diagram\??$/i.test(text.trim())) {
        return noToolCallResult(system);
      }

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

      // 010-ai-diagram-knowledge, T022 (User Story 2): one deterministic rule per new
      // diagram-type-specific tool (diagram-tools.ts). Each checks `toolAvailable` before
      // returning — if the phrase matches but this turn's family doesn't offer that tool, the
      // `if` is skipped and execution falls through to the next rule (and ultimately the final
      // fallback below), never returning a tool call that couldn't actually exist.
      const roleMatch = text.match(
        /set (?:the )?role of ['"]?([^'".]+?)['"]? to (person|system|container|component|participant|actor)\b/i,
      );
      if (roleMatch && toolAvailable(options, 'setNodeRole')) {
        const nodeId = findIdByLabel(system, roleMatch[1].trim()) ?? roleMatch[1].trim();
        return toolCallResult('setNodeRole', { nodeId, role: roleMatch[2].toLowerCase() });
      }

      const attributeMatch = text.match(
        /give ['"]?([^'".]+?)['"]? an attribute (\S+) (\S+?)(?: (PK|FK|UK))?$/i,
      );
      if (attributeMatch && toolAvailable(options, 'setEntityAttributes')) {
        const nodeId = findIdByLabel(system, attributeMatch[1].trim()) ?? attributeMatch[1].trim();
        const keys = attributeMatch[4] ? [attributeMatch[4].toUpperCase()] : [];
        return toolCallResult('setEntityAttributes', {
          nodeId,
          attributes: [{ type: attributeMatch[2], name: attributeMatch[3], keys }],
        });
      }

      const VISIBILITY_WORDS: Record<string, string> = { private: '-', public: '+', protected: '#', package: '~' };
      const classMembersMatch = text.match(
        /give ['"]?([^'".]+?)['"]? an? (private|public|protected|package) (\S+) (\S+) attribute and an? (private|public|protected|package) (\S+) method/i,
      );
      if (classMembersMatch && toolAvailable(options, 'setClassMembers')) {
        const nodeId = findIdByLabel(system, classMembersMatch[1].trim()) ?? classMembersMatch[1].trim();
        return toolCallResult('setClassMembers', {
          nodeId,
          members: [
            {
              kind: 'attribute',
              visibility: VISIBILITY_WORDS[classMembersMatch[2].toLowerCase()],
              type: classMembersMatch[3],
              name: classMembersMatch[4],
            },
            {
              kind: 'method',
              visibility: VISIBILITY_WORDS[classMembersMatch[5].toLowerCase()],
              name: classMembersMatch[6],
              params: '',
            },
          ],
        });
      }

      const relationMatch = text.match(
        /make (?:the )?connector between ['"]?([^'".]+?)['"]? and ['"]?([^'".]+?)['"]? an? (inheritance|composition|aggregation|association|dependency|realization)/i,
      );
      if (relationMatch && toolAvailable(options, 'setRelationshipKind')) {
        const sourceId = findIdByLabel(system, relationMatch[1].trim()) ?? relationMatch[1].trim();
        const targetId = findIdByLabel(system, relationMatch[2].trim()) ?? relationMatch[2].trim();
        const edgeId = findEdgeIdBySourceTarget(system, sourceId, targetId);
        if (edgeId) {
          return toolCallResult('setRelationshipKind', { edgeId, umlRelationKind: relationMatch[3].toLowerCase() });
        }
      }

      const groupMatch = text.match(
        /group ['"]?([^'".]+?)['"]? and ['"]?([^'".]+?)['"]? into a (?:container|group|boundary|box) (?:called |named )?['"]?([^'".]+)['"]?/i,
      );
      if (groupMatch && toolAvailable(options, 'groupIntoContainer')) {
        const idA = findIdByLabel(system, groupMatch[1].trim()) ?? groupMatch[1].trim();
        const idB = findIdByLabel(system, groupMatch[2].trim()) ?? groupMatch[2].trim();
        return toolCallResult('groupIntoContainer', { nodeIds: [idA, idB], label: groupMatch[3].trim() });
      }

      const activateMatch = text.match(/^activate ['"]?([^'".]+?)['"]?$/i);
      if (activateMatch && toolAvailable(options, 'activateParticipant')) {
        const participantId = findIdByLabel(system, activateMatch[1].trim()) ?? activateMatch[1].trim();
        return toolCallResult('activateParticipant', { participantId });
      }

      return noToolCallResult("I'm not sure how to help with that.");
    },
  });
}
