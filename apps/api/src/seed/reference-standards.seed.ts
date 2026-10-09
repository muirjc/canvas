import type { StandardRules } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { createDraftStandard, publishStandard } from '../standards/standard.service.js';
import { revalidateDiagramsForType } from '../standards/revalidate.service.js';

/**
 * canvas-tfr: two published reference standards showing what Standards v2 element kinds express --
 * one for a type below the flowchart family (Value Chain), one fixing a C4 level's notation and
 * colors (C4 Context). Seeded only into a diagram type that has NO standard rows at all (any status),
 * so an admin's own edits -- or a deliberate retire -- are never overwritten by a redeploy.
 */

const EMPTY_V1: Pick<StandardRules, 'allowedShapeIds' | 'mandatoryShapeIds' | 'allowedIconLibraryRefs' | 'colorPalette'> = {
  allowedShapeIds: [],
  mandatoryShapeIds: [],
  allowedIconLibraryRefs: [],
  colorPalette: [],
};

export const VALUE_CHAIN_STANDARD: StandardRules = {
  ...EMPTY_V1,
  requireKnownKinds: true,
  connectorPolicy: 'listed-only',
  elementKinds: [
    {
      id: 'primary_activity',
      label: 'Primary Activity',
      description:
        'An activity that directly creates and delivers value: inbound logistics, operations, outbound logistics, marketing & sales, service. Chain them left to right in the order value flows.',
      shapes: ['asymmetric'],
      approvedFills: ['#dbeafe', '#bfdbfe'],
      approvedStrokes: ['#1d4ed8'],
      minCount: 1,
      requireConnection: true,
    },
    {
      id: 'support_activity',
      label: 'Support Activity',
      description:
        'An activity that enables the primary activities across the whole chain: firm infrastructure, human resource management, technology development, procurement. Not connected into the primary flow.',
      shapes: ['rectangle'],
      approvedFills: ['#fef3c7', '#fde68a'],
      approvedStrokes: ['#b45309'],
      minCount: 1,
    },
    {
      id: 'margin',
      label: 'Margin',
      description: 'The value captured: exactly one, at the end of the primary activity chain.',
      shapes: ['hexagon'],
      approvedFills: ['#dcfce7'],
      approvedStrokes: ['#15803d'],
      minCount: 1,
      maxCount: 1,
    },
  ],
  connectorRules: [
    { id: 'flow', label: 'Value flow', from: 'primary_activity', to: 'primary_activity', lineStyles: ['solid'], arrows: ['target'], maxPerSource: 1 },
    { id: 'to_margin', label: 'Delivers margin', from: 'primary_activity', to: 'margin', lineStyles: ['solid'], arrows: ['target'], maxPerSource: 1 },
  ],
  guidance:
    "Porter's value chain: primary activities in sequence left to right (typically 5: inbound logistics, operations, outbound logistics, marketing & sales, service), the last one feeding the single Margin element. Support activities (typically 4: firm infrastructure, HR management, technology development, procurement) sit as bands above the primary chain and are not connected into it.",
};

// Fills match the C4 role defaults the renderer already draws (svg-renderer.ts C4_NODE_COLORS /
// C4_EXTERNAL_NODE_COLORS), so an unstyled element is compliant out of the box.
export const C4_CONTEXT_STANDARD: StandardRules = {
  ...EMPTY_V1,
  requireKnownKinds: true,
  connectorPolicy: 'any',
  elementKinds: [
    {
      id: 'person',
      label: 'Person',
      description: 'A user of the system (Person).',
      shapes: ['person'],
      approvedFills: ['#08427b'],
      match: { role: 'person', external: false },
    },
    {
      id: 'external_person',
      label: 'External Person',
      description: 'A person outside the organisation (Person_Ext).',
      shapes: ['person'],
      approvedFills: ['#686868'],
      match: { role: 'person', external: true },
    },
    {
      id: 'software_system',
      label: 'Software System',
      description: 'The system in scope, or another internal system (System / SystemDb / SystemQueue).',
      shapes: ['rectangle', 'cylinder', 'stadium'],
      approvedFills: ['#1168bd'],
      match: { role: 'system', external: false },
      minCount: 1,
    },
    {
      id: 'external_system',
      label: 'External System',
      description: 'A system outside the scope being described (System_Ext / SystemDb_Ext / SystemQueue_Ext).',
      shapes: ['rectangle', 'cylinder', 'stadium'],
      approvedFills: ['#999999'],
      match: { role: 'system', external: true },
    },
  ],
  connectorRules: [{ id: 'relationship', label: 'Relationship', from: '*', to: '*', requireLabel: true }],
  containers: { allowed: true, allowedRoles: ['enterprise-boundary', 'system-boundary', 'boundary'] },
  guidance:
    'A C4 System Context diagram shows the software system in scope, the people who use it, and the other systems it depends on -- nothing inside a system (no containers or components). Every relationship needs a label describing what it does.',
};

export const REFERENCE_STANDARDS: { diagramTypeId: string; name: string; description: string; rules: StandardRules }[] = [
  {
    diagramTypeId: 'value-chain',
    name: 'Value Chain (Porter)',
    description: 'Primary activities in sequence feeding a single margin, with support activities alongside.',
    rules: VALUE_CHAIN_STANDARD,
  },
  {
    diagramTypeId: 'c4-context',
    name: 'C4 System Context',
    description: 'People and software systems only, in the standard C4 colors, with labelled relationships.',
    rules: C4_CONTEXT_STANDARD,
  },
];

/** Returns the diagram type ids that got a standard seeded this run. */
export async function seedReferenceStandards(): Promise<string[]> {
  const db = getDb();
  const seeded: string[] = [];
  for (const ref of REFERENCE_STANDARDS) {
    const type = await db.selectFrom('diagram_types').select('id').where('id', '=', ref.diagramTypeId).executeTakeFirst();
    if (!type) continue;
    const existing = await db.selectFrom('standards').select('id').where('diagram_type_id', '=', ref.diagramTypeId).executeTakeFirst();
    if (existing) continue;
    const draft = await createDraftStandard({
      diagramTypeId: ref.diagramTypeId,
      rules: ref.rules,
      name: ref.name,
      description: ref.description,
    });
    await publishStandard(draft.id);
    await revalidateDiagramsForType(ref.diagramTypeId);
    seeded.push(ref.diagramTypeId);
  }
  return seeded;
}
