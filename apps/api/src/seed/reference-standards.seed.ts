import { FAMILY_NODE_SHAPES, type ElementKind, type NodeShape, type StandardRules } from '@canvas/diagram-core';
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


// ---- canvas-chq: starter standards for every other built-in type --------------------------------
// Descriptive, not restrictive: they make each type's current built-in behavior visible and
// editable on the Standards page without flagging existing diagrams (no requireKnownKinds, shape
// lists = everything the family can already express, C4 fills = what the renderer already draws).
// Admins tighten them from there.

function familyShapes(family: string): NodeShape[] {
  return [...(FAMILY_NODE_SHAPES[family] ?? FAMILY_NODE_SHAPES.flowchart)];
}

function descriptiveStarter(family: string, guidance: string): StandardRules {
  return { ...EMPTY_V1, allowedShapeIds: familyShapes(family), guidance };
}

const C4_KINDS: Record<string, ElementKind> = {
  person: { id: 'person', label: 'Person', description: 'A user of the system (Person).', shapes: ['person'], approvedFills: ['#08427b'], match: { role: 'person', external: false } },
  external_person: { id: 'external_person', label: 'External Person', description: 'A person outside the organisation (Person_Ext).', shapes: ['person'], approvedFills: ['#686868'], match: { role: 'person', external: true } },
  software_system: { id: 'software_system', label: 'Software System', description: 'A software system (System / SystemDb / SystemQueue).', shapes: [], approvedFills: ['#1168bd'], match: { role: 'system', external: false } },
  external_system: { id: 'external_system', label: 'External System', description: 'A system outside the scope (System_Ext and variants).', shapes: [], approvedFills: ['#999999'], match: { role: 'system', external: true } },
  container: { id: 'container', label: 'Container', description: 'An application or data store inside a system (Container / ContainerDb / ContainerQueue).', shapes: [], approvedFills: ['#438dd5'], match: { role: 'container', external: false } },
  external_container: { id: 'external_container', label: 'External Container', description: 'A container outside the scope (Container_Ext and variants).', shapes: [], approvedFills: ['#b3b3b3'], match: { role: 'container', external: true } },
  component: { id: 'component', label: 'Component', description: 'A component inside a container (Component / ComponentDb / ComponentQueue).', shapes: [], approvedFills: ['#85bbf0'], match: { role: 'component', external: false } },
  external_component: { id: 'external_component', label: 'External Component', description: 'A component outside the scope (Component_Ext and variants).', shapes: [], approvedFills: ['#cccccc'], match: { role: 'component', external: true } },
};

function c4Starter(kindIds: string[], boundaryRoles: string[], guidance: string): StandardRules {
  return {
    ...EMPTY_V1,
    elementKinds: kindIds.map((id) => C4_KINDS[id]),
    connectorPolicy: 'any',
    connectorRules: [{ id: 'relationship', label: 'Relationship', from: '*', to: '*', requireLabel: true }],
    containers: { allowed: true, allowedRoles: boundaryRoles },
    guidance,
  };
}

const STARTER_STANDARDS: { diagramTypeId: string; name: string; description: string; rules: StandardRules }[] = [
  {
    diagramTypeId: 'c4-container',
    name: 'C4 Container (starter)',
    description: 'Standard C4 element kinds and colors for a container diagram. Edit to tighten.',
    rules: c4Starter(
      ['person', 'external_person', 'software_system', 'external_system', 'container', 'external_container'],
      ['enterprise-boundary', 'system-boundary', 'container-boundary', 'boundary'],
      'A C4 Container diagram zooms into one software system and shows its containers (applications, data stores, queues), the people who use them and the external systems they talk to. Label every relationship with what it does and how (e.g. "Reads/writes [SQL]").',
    ),
  },
  {
    diagramTypeId: 'c4-component',
    name: 'C4 Component (starter)',
    description: 'Standard C4 element kinds and colors for a component diagram. Edit to tighten.',
    rules: c4Starter(
      ['person', 'external_person', 'software_system', 'external_system', 'container', 'external_container', 'component', 'external_component'],
      ['system-boundary', 'container-boundary', 'boundary'],
      'A C4 Component diagram zooms into one container and shows its components and how they interact with each other and with surrounding containers and systems. Label every relationship.',
    ),
  },
  {
    diagramTypeId: 'c4-code',
    name: 'C4 Code (starter)',
    description: 'Standard C4 element kinds and colors for a code-level diagram. Edit to tighten.',
    rules: c4Starter(
      ['container', 'external_container', 'component', 'external_component', 'software_system', 'external_system'],
      ['container-boundary', 'boundary'],
      'A C4 Code-level view zooms into a single component. Keep it focused on the elements that matter for understanding that component, and label every relationship.',
    ),
  },
  {
    diagramTypeId: 'c4-deployment',
    name: 'C4 Deployment (starter)',
    description: 'Standard C4 element kinds and colors for a deployment diagram. Edit to tighten.',
    rules: c4Starter(
      ['person', 'external_person', 'software_system', 'external_system', 'container', 'external_container'],
      ['deployment-node', 'enterprise-boundary', 'system-boundary', 'boundary'],
      'A C4 Deployment diagram shows how containers map onto infrastructure: nest containers inside Deployment_Nodes (environments, servers, clusters, managed services). Label every relationship.',
    ),
  },
  {
    diagramTypeId: 'flowchart',
    name: 'Generic Flowchart (starter)',
    description: 'Every flowchart shape is allowed. Narrow the shapes or add element kinds to standardise.',
    rules: descriptiveStarter('flowchart', 'A general-purpose flowchart: steps, decisions and flows. Use diamonds for decisions and label the outgoing branches.'),
  },
  {
    diagramTypeId: 'business-capability-map',
    name: 'Business Capability Map (starter)',
    description: 'Every flowchart shape is allowed. Add element kinds (e.g. capability levels) to standardise.',
    rules: descriptiveStarter('flowchart', 'A business capability map shows what the business does (not how), grouped hierarchically: level-1 capabilities as groupings containing their level-2/3 capabilities. Name capabilities as nouns ("Customer Management"), not processes.'),
  },
  {
    diagramTypeId: 'value-stream',
    name: 'Value Stream (starter)',
    description: 'Every flowchart shape is allowed. Add element kinds (e.g. stages) to standardise.',
    rules: descriptiveStarter('flowchart', 'A value stream shows the end-to-end stages that deliver value to a customer, left to right, from trigger to value delivered. Name stages as outcomes ("Order Fulfilled").'),
  },
  {
    diagramTypeId: 'application-landscape',
    name: 'Application Landscape (starter)',
    description: 'Every flowchart shape is allowed. Add element kinds (e.g. application tiers) to standardise.',
    rules: descriptiveStarter('flowchart', 'An application landscape shows the organisation\'s applications, grouped by domain or capability, and the key integrations between them. Label integrations with the data or interface exchanged.'),
  },
  {
    diagramTypeId: 'roadmap',
    name: 'Roadmap (starter)',
    description: 'Every flowchart shape is allowed. Add element kinds (e.g. initiative, milestone) to standardise.',
    rules: descriptiveStarter('flowchart', 'A roadmap lays out initiatives and milestones over time, left to right, typically grouped into lanes (themes or teams). Show dependencies between initiatives as connectors.'),
  },
  {
    diagramTypeId: 'solution-architecture',
    name: 'Solution Architecture (starter)',
    description: 'Every flowchart shape and the cloud icon libraries are allowed. Narrow to standardise.',
    rules: descriptiveStarter('flowchart', 'A solution architecture shows the components of one solution, the platforms and services it runs on, and the integrations between them. Label connections with protocol or data flow.'),
  },
  {
    diagramTypeId: 'sequence',
    name: 'Sequence Diagram (starter)',
    description: 'Participants and actors as today. Edit to add rules.',
    rules: descriptiveStarter('sequence', 'A sequence diagram shows the messages exchanged between participants over time, top to bottom. Use actors for people, participants for systems, and label every message.'),
  },
  {
    diagramTypeId: 'erd',
    name: 'Entity-Relationship Diagram (starter)',
    description: 'Entities as today. Edit to add rules.',
    rules: descriptiveStarter('erd', 'An ER diagram shows entities, their attributes (mark keys PK/FK/UK) and the cardinality of the relationships between them. Name entities as singular nouns.'),
  },
  {
    diagramTypeId: 'uml',
    name: 'UML Class Diagram (starter)',
    description: 'Classes as today. Edit to add rules.',
    rules: descriptiveStarter('uml', 'A UML class diagram shows classes with their attributes and methods (with visibility), and the relationships between them (inheritance, composition, aggregation, association, dependency).'),
  },
  {
    diagramTypeId: 'network',
    name: 'Network Diagram (starter)',
    description: 'Services and junctions as today. Edit to add rules.',
    rules: descriptiveStarter('architecture', 'A network diagram shows network zones as groups, the services and devices inside them, and the connections between them. Use cloud icons where they exist.'),
  },
  {
    diagramTypeId: 'deployment',
    name: 'Deployment Diagram (starter)',
    description: 'Services and junctions as today. Edit to add rules.',
    rules: descriptiveStarter('architecture', 'A deployment diagram shows where software runs: environments and hosting platforms as groups, the services deployed into them, and how they connect.'),
  },
  {
    diagramTypeId: 'cloud-infrastructure',
    name: 'Cloud Infrastructure (starter)',
    description: 'Services and junctions as today. Edit to add rules.',
    rules: descriptiveStarter('architecture', 'A cloud infrastructure diagram shows cloud resources grouped by subscription/account, region and network, using the provider\'s official icons.'),
  },
];

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

/** canvas-chq: the two strict reference standards plus a starter for every other built-in type. */
export const BUILT_IN_STANDARDS = [...REFERENCE_STANDARDS, ...STARTER_STANDARDS];

/** Returns the diagram type ids that got a standard seeded this run. */
export async function seedReferenceStandards(): Promise<string[]> {
  const db = getDb();
  const seeded: string[] = [];
  for (const ref of BUILT_IN_STANDARDS) {
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
