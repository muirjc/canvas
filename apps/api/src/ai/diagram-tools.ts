import { z } from 'zod';
import { tool } from 'ai';
import {
  addContainer,
  addEdge,
  addNode,
  addPointMarkerContainer,
  assignNodeToContainer,
  removeEdge,
  removeNode,
  updateClassMembers,
  updateEdgeArrowStyle,
  updateEdgeLabel,
  updateEdgeRelationKind,
  updateEdgeStyle,
  updateEntityAttributes,
  updateNodeLabel,
  updateNodeRole,
  updateNodeStyle,
  type DiagramEdge,
  type DiagramModel,
  type NodeShape,
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

/**
 * 010-ai-diagram-knowledge, T021: `addNode`'s `shape` enum, widened from the single hardcoded
 * flowchart list to the family-appropriate `NodeShape` subset — confirmed against each family's
 * own `dsl/*.ts` parser, not assumed. `erd`/`uml` entities/classes are always plain rectangles;
 * `sequence` participants are rectangles (or 'person' for an actor); `c4` elements use whichever
 * shape their role maps to (`ELEMENT_TO_SHAPE` in dsl/c4.ts); `architecture` services are always
 * 'icon'-shaped (dsl/architecture.ts's `SERVICE_PATTERN`) — a bare node with no icon artwork is
 * still valid, matching a service declared with empty `()`. An unrecognized family falls back to
 * the full flowchart set.
 */
const FAMILY_NODE_SHAPES: Record<string, readonly [NodeShape, ...NodeShape[]]> = {
  flowchart: [
    'rectangle',
    'rounded-rectangle',
    'circle',
    'diamond',
    'cylinder',
    'stadium',
    'subroutine',
    'double-circle',
    'hexagon',
    'parallelogram',
    'parallelogram-alt',
    'trapezoid',
    'trapezoid-alt',
    'asymmetric',
  ],
  c4: ['rectangle', 'person', 'cylinder', 'stadium'],
  sequence: ['rectangle', 'person'],
  erd: ['rectangle'],
  uml: ['rectangle'],
  architecture: ['icon'],
};

/** 010-ai-diagram-knowledge, T019: per-family enum options for the new diagram-type-specific
 *  tools below — each confirmed against the corresponding `dsl/*.ts` parser's own vocabulary
 *  (see diagram-model.ts's field doc comments for the authoritative source). */
const NODE_ROLE_OPTIONS: Record<string, readonly [string, ...string[]]> = {
  c4: ['person', 'system', 'container', 'component'],
  sequence: ['participant', 'actor'],
};
const ENTITY_KEY_OPTIONS = ['PK', 'FK', 'UK'] as const;
const CLASS_MEMBER_VISIBILITY = ['+', '-', '#', '~'] as const;
const UML_RELATION_KINDS = [
  'inheritance',
  'composition',
  'aggregation',
  'association',
  'link-solid',
  'dependency',
  'realization',
  'link-dashed',
  'lollipop-source',
  'lollipop-target',
] as const;
type ArrowValue = NonNullable<DiagramEdge['arrow']>;
type LineStyleValue = NonNullable<DiagramEdge['lineStyle']>;
const CONNECTOR_ARROW_OPTIONS: Partial<Record<string, readonly [ArrowValue, ...ArrowValue[]]>> = {
  flowchart: ['none', 'both'],
  sequence: ['none', 'both', 'cross', 'open'],
};
const CONNECTOR_LINE_STYLE_OPTIONS: Partial<Record<string, readonly [LineStyleValue, ...LineStyleValue[]]>> = {
  flowchart: ['solid', 'dotted', 'thick', 'invisible'],
  sequence: ['solid', 'dotted'],
};
/** Families whose grouping concept (boundary/namespace/box/group) `groupIntoContainer` covers.
 *  Not `erd` (no ER grouping concept) or `flowchart` (subgraphs are authored structurally by the
 *  canvas/DSL, not a natural chat request in this feature's scope). */
const GROUPABLE_FAMILIES = new Set(['architecture', 'c4', 'uml', 'sequence']);

const stylePatchSchema = {
  fillColor: z.string().optional().describe('Fill color as a hex code, e.g. "#1168bd".'),
  strokeColor: z.string().optional().describe('Border/line color as a hex code, e.g. "#0b4884".'),
  strokeWidth: z.number().optional().describe('Border/line thickness in pixels.'),
  strokeDasharray: z.string().optional().describe('SVG stroke-dasharray, e.g. "5 5", for a dashed/dotted line.'),
};

/**
 * The AI-facing tool surface (FR-009), one wrapper per targeted edit operation. Each wrapper
 * calls the same `diagram-core` functions the canvas's manual UI uses (research.md §1). Every
 * tool that references an existing element (all but `addNode`) checks for it first and returns
 * `{ applied: false, reason }` instead of calling the underlying operation when it's missing
 * (FR-014, research.md §6) — the underlying operations themselves stay lenient/no-op, unchanged,
 * for the canvas's own idempotent-delete UX.
 *
 * 010-ai-diagram-knowledge, T005: `family` (a `registry.ts` `dslFamily` id) makes the returned
 * tool set family-conditional — the 8 base tools below are offered for every family unchanged,
 * but the diagram-type-specific tools (T019) below them are only present in the returned object
 * when `family` is one they apply to. This is the structural mechanism behind FR-004 ("decline an
 * edit with no equivalent concept in the diagram's type"): there is no tool call to make for an
 * out-of-family request, not merely a description saying so (plan.md's Constitution Check).
 */
export function createDiagramTools(context: DiagramToolsContext, family: string) {
  const nodeShapes = FAMILY_NODE_SHAPES[family] ?? FAMILY_NODE_SHAPES.flowchart;
  const record = (name: string, outcome: { applied: boolean; reason?: string }) => {
    context.recordOutcome?.({ tool: name, ...outcome });
    return outcome;
  };

  const base = {
    addNode: tool({
      description:
        'Add a new shape to the flowchart. Returns the new shape\'s id — use it (not the label) ' +
        'as sourceId/targetId in a later addEdge call to connect it.',
      inputSchema: z.object({
        shape: z.enum(nodeShapes).describe('The shape to draw.'),
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

    updateNodeStyle: tool({
      description:
        "Set a shape's fill/border color or border thickness/dash pattern. Only the fields you " +
        'provide are changed — omit any you want left as they are.',
      inputSchema: z.object({
        nodeId: z.string().describe('The id of the shape to restyle.'),
        ...stylePatchSchema,
      }),
      execute: async ({ nodeId, ...patch }) => {
        const model = context.getModel();
        if (!model.nodes.some((n) => n.id === nodeId)) {
          return record('updateNodeStyle', { applied: false, reason: `No shape with id '${nodeId}' was found.` });
        }
        context.setModel(updateNodeStyle(model, nodeId, patch));
        return record('updateNodeStyle', { applied: true });
      },
    }),

    updateEdgeStyle: tool({
      description:
        "Set a connector's line color or thickness/dash pattern. Only the fields you provide are " +
        'changed — omit any you want left as they are.',
      inputSchema: z.object({
        edgeId: z.string().describe('The id of the connector to restyle.'),
        ...stylePatchSchema,
      }),
      execute: async ({ edgeId, ...patch }) => {
        const model = context.getModel();
        if (!model.edges.some((e) => e.id === edgeId)) {
          return record('updateEdgeStyle', { applied: false, reason: `No connector with id '${edgeId}' was found.` });
        }
        context.setModel(updateEdgeStyle(model, edgeId, patch));
        return record('updateEdgeStyle', { applied: true });
      },
    }),
  };

  /*
   * 010-ai-diagram-knowledge, T019: diagram-type-specific tools (User Story 2). Each wraps one
   * of the new diagram-ops.ts operations (T017) the same way the base 8 wrap the pre-existing
   * ones — check-then-call-then-record, never bypassing the not-found convention above. Built
   * conditionally so a family that has no equivalent concept simply has no tool call to make for
   * it (FR-004), rather than a tool that exists everywhere but silently no-ops.
   */
  const nodeRoleOptions = NODE_ROLE_OPTIONS[family];
  const setNodeRole = nodeRoleOptions
    ? tool({
        description: `Set a shape's semantic role (one of: ${nodeRoleOptions.join(', ')}).`,
        inputSchema: z.object({
          nodeId: z.string().describe('The id of the shape to set the role of.'),
          role: z.enum(nodeRoleOptions).describe('The semantic role to assign.'),
        }),
        execute: async ({ nodeId, role }) => {
          const model = context.getModel();
          if (!model.nodes.some((n) => n.id === nodeId)) {
            return record('setNodeRole', { applied: false, reason: `No shape with id '${nodeId}' was found.` });
          }
          context.setModel(updateNodeRole(model, nodeId, role));
          return record('setNodeRole', { applied: true });
        },
      })
    : undefined;

  const setEntityAttributes =
    family === 'erd'
      ? tool({
          description:
            "Replace an ER entity's full attribute list. Provide every attribute the entity should " +
            'have — this replaces the list wholesale, it does not merge with the existing one.',
          inputSchema: z.object({
            nodeId: z.string().describe('The id of the entity to set attributes on.'),
            attributes: z.array(
              z.object({
                type: z.string().describe('The attribute\'s data type, e.g. "string", "int".'),
                name: z.string().describe("The attribute's name."),
                keys: z
                  .array(z.enum(ENTITY_KEY_OPTIONS))
                  .describe('Zero or more of PK (primary key), FK (foreign key), UK (unique key).'),
                comment: z.string().optional().describe('Optional descriptive comment, purely informational.'),
              }),
            ),
          }),
          execute: async ({ nodeId, attributes }) => {
            const model = context.getModel();
            if (!model.nodes.some((n) => n.id === nodeId)) {
              return record('setEntityAttributes', { applied: false, reason: `No entity with id '${nodeId}' was found.` });
            }
            context.setModel(updateEntityAttributes(model, nodeId, attributes));
            return record('setEntityAttributes', { applied: true });
          },
        })
      : undefined;

  const setClassMembers =
    family === 'uml'
      ? tool({
          description:
            "Replace a UML class's full member list (attributes and methods). Provide every member " +
            'the class should have — this replaces the list wholesale, it does not merge with the ' +
            'existing one.',
          inputSchema: z.object({
            nodeId: z.string().describe('The id of the class to set members on.'),
            members: z.array(
              z.object({
                kind: z.enum(['attribute', 'method']).describe('Whether this member is a typed attribute or a method.'),
                visibility: z
                  .enum(CLASS_MEMBER_VISIBILITY)
                  .optional()
                  .describe('+ public, - private, # protected, ~ package/internal. Omit if unmarked.'),
                name: z.string().describe("The member's name."),
                type: z.string().optional().describe('Attributes only: the declared type.'),
                params: z.string().optional().describe('Methods only: the raw parameter-list text (may be empty).'),
                returnType: z.string().optional().describe('Methods only: the return type, if any.'),
                isStatic: z.boolean().optional().describe('True for a static member ($ suffix).'),
                isAbstract: z.boolean().optional().describe('True for an abstract member (* suffix).'),
              }),
            ),
          }),
          execute: async ({ nodeId, members }) => {
            const model = context.getModel();
            if (!model.nodes.some((n) => n.id === nodeId)) {
              return record('setClassMembers', { applied: false, reason: `No class with id '${nodeId}' was found.` });
            }
            context.setModel(updateClassMembers(model, nodeId, members));
            return record('setClassMembers', { applied: true });
          },
        })
      : undefined;

  const setRelationshipKind =
    family === 'uml'
      ? tool({
          description:
            "Set a UML relationship's kind (inheritance, composition, aggregation, association, " +
            'link-solid, dependency, realization, link-dashed, or a lollipop interface) and/or its ' +
            'cardinality labels. Only the fields you provide are changed.',
          inputSchema: z.object({
            edgeId: z.string().describe('The id of the relationship to update.'),
            umlRelationKind: z.enum(UML_RELATION_KINDS).optional().describe('The relationship kind.'),
            sourceCardinality: z.string().optional().describe('Cardinality label at the source end, e.g. "1", "0..1", "*".'),
            targetCardinality: z.string().optional().describe('Cardinality label at the target end.'),
          }),
          execute: async ({ edgeId, ...patch }) => {
            const model = context.getModel();
            if (!model.edges.some((e) => e.id === edgeId)) {
              return record('setRelationshipKind', { applied: false, reason: `No connector with id '${edgeId}' was found.` });
            }
            context.setModel(updateEdgeRelationKind(model, edgeId, patch));
            return record('setRelationshipKind', { applied: true });
          },
        })
      : undefined;

  const connectorArrowOptions = CONNECTOR_ARROW_OPTIONS[family];
  const connectorLineStyleOptions = CONNECTOR_LINE_STYLE_OPTIONS[family];
  const setConnectorStyle =
    connectorArrowOptions && connectorLineStyleOptions
      ? tool({
          description:
            "Set a connector's arrowhead and/or line style. Only the fields you provide are changed.",
          inputSchema: z.object({
            edgeId: z.string().describe('The id of the connector to update.'),
            arrow: z.enum(connectorArrowOptions).optional().describe('Which endpoint(s) carry an arrowhead.'),
            lineStyle: z.enum(connectorLineStyleOptions).optional().describe("The connector's line rendering."),
          }),
          execute: async ({ edgeId, ...patch }) => {
            const model = context.getModel();
            if (!model.edges.some((e) => e.id === edgeId)) {
              return record('setConnectorStyle', { applied: false, reason: `No connector with id '${edgeId}' was found.` });
            }
            context.setModel(updateEdgeArrowStyle(model, edgeId, patch));
            return record('setConnectorStyle', { applied: true });
          },
        })
      : undefined;

  const groupIntoContainer = GROUPABLE_FAMILIES.has(family)
    ? tool({
        description:
          'Group one or more existing shapes into a new labeled container (a boundary/namespace/box, ' +
          "depending on the diagram type). Returns the new container's id.",
        inputSchema: z.object({
          nodeIds: z.array(z.string()).min(1).describe('Ids of the shapes to group together.'),
          label: z.string().optional().describe('Label for the new container. Defaults to "Container" if omitted.'),
        }),
        execute: async ({ nodeIds, label }) => {
          let model = context.getModel();
          const existingIds = nodeIds.filter((id) => model.nodes.some((n) => n.id === id));
          if (existingIds.length === 0) {
            return record('groupIntoContainer', { applied: false, reason: `No shape with id '${nodeIds[0]}' was found.` });
          }
          model = addContainer(model, { label });
          const container = model.containers[model.containers.length - 1];
          for (const id of existingIds) {
            model = assignNodeToContainer(model, id, container.id);
          }
          context.setModel(model);
          return { ...record('groupIntoContainer', { applied: true }), containerId: container.id };
        },
      })
    : undefined;

  const makeActivationTool = (role: 'activate' | 'deactivate') =>
    tool({
      description:
        role === 'activate'
          ? 'Mark a participant as actively processing, starting at this point in the sequence.'
          : 'Mark a participant as no longer actively processing, at this point in the sequence.',
      inputSchema: z.object({
        participantId: z.string().describe('The id of the participant/actor.'),
      }),
      execute: async ({ participantId }) => {
        const toolName = role === 'activate' ? 'activateParticipant' : 'deactivateParticipant';
        const model = context.getModel();
        if (!model.nodes.some((n) => n.id === participantId)) {
          return record(toolName, { applied: false, reason: `No participant with id '${participantId}' was found.` });
        }
        context.setModel(addPointMarkerContainer(model, { role, attachedNodeId: participantId }));
        return record(toolName, { applied: true });
      },
    });
  const activateParticipant = family === 'sequence' ? makeActivationTool('activate') : undefined;
  const deactivateParticipant = family === 'sequence' ? makeActivationTool('deactivate') : undefined;

  return {
    ...base,
    ...(setNodeRole ? { setNodeRole } : {}),
    ...(setEntityAttributes ? { setEntityAttributes } : {}),
    ...(setClassMembers ? { setClassMembers } : {}),
    ...(setRelationshipKind ? { setRelationshipKind } : {}),
    ...(setConnectorStyle ? { setConnectorStyle } : {}),
    ...(groupIntoContainer ? { groupIntoContainer } : {}),
    ...(activateParticipant ? { activateParticipant } : {}),
    ...(deactivateParticipant ? { deactivateParticipant } : {}),
  };
}

export type DiagramTools = ReturnType<typeof createDiagramTools>;
