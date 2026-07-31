import { z } from 'zod';
import { tool } from 'ai';
import {
  addEdge,
  addNode,
  removeEdge,
  removeNode,
  updateEdgeLabel,
  updateNodeLabel,
  type DiagramModel,
} from '@canvas/diagram-core';

export interface ToolCallOutcome {
  tool: string;
  applied: boolean;
  reason?: string;
}

export interface DiagramToolsContext {
  getModel: () => DiagramModel;
  setModel: (model: DiagramModel) => void;
  /** Optional: called with every tool invocation's outcome, in call order — how
   * `diagram-chat.service.ts` builds the `toolCalls` summary in its response (contracts/). */
  recordOutcome?: (outcome: ToolCallOutcome) => void;
}

const FLOWCHART_SHAPES = ['rectangle', 'rounded-rectangle', 'circle', 'diamond', 'cylinder'] as const;

/**
 * The AI-facing tool surface (FR-009), one wrapper per targeted edit operation. Each wrapper
 * calls the same `diagram-core` functions the canvas's manual UI uses (research.md §1). Every
 * tool that references an existing element (all but `addNode`) checks for it first and returns
 * `{ applied: false, reason }` instead of calling the underlying operation when it's missing
 * (FR-014, research.md §6) — the underlying operations themselves stay lenient/no-op, unchanged,
 * for the canvas's own idempotent-delete UX.
 */
export function createDiagramTools(context: DiagramToolsContext) {
  const record = (name: string, outcome: { applied: boolean; reason?: string }) => {
    context.recordOutcome?.({ tool: name, ...outcome });
    return outcome;
  };

  return {
    addNode: tool({
      description:
        'Add a new shape to the flowchart. Returns the new shape\'s id — use it (not the label) ' +
        'as sourceId/targetId in a later addEdge call to connect it.',
      inputSchema: z.object({
        shape: z.enum(FLOWCHART_SHAPES).describe('The shape to draw.'),
        label: z.string().optional().describe('Text shown on the shape. Defaults to "New Node" if omitted.'),
      }),
      execute: async ({ shape, label }) => {
        const updated = addNode(context.getModel(), { shape, label });
        context.setModel(updated);
        // T033 (live-provider validation): a real model creating several nodes then connecting
        // them within the same turn has no way to learn this opaque generated id otherwise — it
        // can only guess (the label text, "node-1", "0", …), and every guess fails. The recorded
        // outcome (persisted/returned by the chat API) stays the existing narrow {tool, applied}
        // shape; only the value fed back to the model for this turn gains `nodeId`.
        const newNode = updated.nodes[updated.nodes.length - 1];
        return { ...record('addNode', { applied: true }), nodeId: newNode.id };
      },
    }),

    removeNode: tool({
      description: 'Remove a shape (and any connectors attached to it) from the flowchart.',
      inputSchema: z.object({ nodeId: z.string().describe('The id of the shape to remove.') }),
      execute: async ({ nodeId }) => {
        const model = context.getModel();
        if (!model.nodes.some((n) => n.id === nodeId)) {
          return record('removeNode', { applied: false, reason: `No shape with id '${nodeId}' was found.` });
        }
        context.setModel(removeNode(model, nodeId));
        return record('removeNode', { applied: true });
      },
    }),

    addEdge: tool({
      description: 'Add a connector between two existing shapes.',
      inputSchema: z.object({
        sourceId: z.string().describe('The id of the shape the connector starts from.'),
        targetId: z.string().describe('The id of the shape the connector points to.'),
        label: z.string().optional().describe('Optional text shown on the connector.'),
      }),
      execute: async ({ sourceId, targetId, label }) => {
        const model = context.getModel();
        const missing = [sourceId, targetId].filter((id) => !model.nodes.some((n) => n.id === id));
        if (missing.length > 0) {
          return record('addEdge', { applied: false, reason: `No shape with id '${missing[0]}' was found.` });
        }
        context.setModel(addEdge(model, { sourceId, targetId, label }));
        return record('addEdge', { applied: true });
      },
    }),

    removeEdge: tool({
      description: 'Remove a connector from the flowchart.',
      inputSchema: z.object({ edgeId: z.string().describe('The id of the connector to remove.') }),
      execute: async ({ edgeId }) => {
        const model = context.getModel();
        if (!model.edges.some((e) => e.id === edgeId)) {
          return record('removeEdge', { applied: false, reason: `No connector with id '${edgeId}' was found.` });
        }
        context.setModel(removeEdge(model, edgeId));
        return record('removeEdge', { applied: true });
      },
    }),

    updateNodeLabel: tool({
      description: "Rename a shape's label.",
      inputSchema: z.object({
        nodeId: z.string().describe('The id of the shape to rename.'),
        label: z.string().describe('The new label text.'),
      }),
      execute: async ({ nodeId, label }) => {
        const model = context.getModel();
        if (!model.nodes.some((n) => n.id === nodeId)) {
          return record('updateNodeLabel', { applied: false, reason: `No shape with id '${nodeId}' was found.` });
        }
        context.setModel(updateNodeLabel(model, nodeId, label));
        return record('updateNodeLabel', { applied: true });
      },
    }),

    updateEdgeLabel: tool({
      description: "Change or clear a connector's label.",
      inputSchema: z.object({
        edgeId: z.string().describe('The id of the connector to relabel.'),
        label: z.string().describe('The new label text (empty string clears it).'),
      }),
      execute: async ({ edgeId, label }) => {
        const model = context.getModel();
        if (!model.edges.some((e) => e.id === edgeId)) {
          return record('updateEdgeLabel', { applied: false, reason: `No connector with id '${edgeId}' was found.` });
        }
        context.setModel(updateEdgeLabel(model, edgeId, label));
        return record('updateEdgeLabel', { applied: true });
      },
    }),
  };
}

export type DiagramTools = ReturnType<typeof createDiagramTools>;
