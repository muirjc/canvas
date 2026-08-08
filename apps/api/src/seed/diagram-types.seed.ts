import { getPool } from '../db/pool.js';

interface DiagramTypeSeed {
  id: string;
  name: string;
  personas: string[];
  abstractionLevel: string;
  dslFamily: string;
  defaultPaletteLibraryIds: string[];
}

const ALL_PERSONAS = ['Business', 'Enterprise', 'Solution', 'Technical'];
// canvas-23t.4: "generic"'s five entries (Rectangle, Circle, ...) are non-visual shape-alias
// sentinels, not real icon artwork (packages/diagram-core/src/libraries/generic.ts) — they
// duplicate the shape toolbar and render as broken, artwork-less boxes when placed via the icon
// search path. Only worth including for a diagram type with no OTHER icon library at all, where
// it's the sole way to place any icon/shape through that path — never alongside a real library.
const CLOUD_LIBRARIES = ['azure-icons', 'aws-icons'];

/** The full built-in DiagramType catalog required by FR-006, scoped by persona per Constitution III. */
const DIAGRAM_TYPES: DiagramTypeSeed[] = [
  { id: 'flowchart', name: 'Generic Flowchart', personas: ALL_PERSONAS, abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'c4-context', name: 'C4 Context', personas: ['Solution', 'Technical'], abstractionLevel: 'Context', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation'] },
  { id: 'c4-container', name: 'C4 Container', personas: ['Solution', 'Technical'], abstractionLevel: 'Container', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation'] },
  { id: 'c4-component', name: 'C4 Component', personas: ['Technical'], abstractionLevel: 'Component', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation'] },
  { id: 'c4-code', name: 'C4 Code', personas: ['Technical'], abstractionLevel: 'Code', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation'] },
  // jmuir-dtu.3.2: distinct from the pre-existing 'deployment' id below (architecture dslFamily,
  // a generic cloud-infra deployment diagram) -- this is specifically the C4 model's own
  // Deployment_Node-based infrastructure-topology diagram (packages/diagram-core/src/dsl/c4.ts).
  // Technical-only, matching c4-component/c4-code's precedent: infrastructure topology is an
  // implementation-level artifact, not something a Solution Architect typically curates.
  { id: 'c4-deployment', name: 'C4 Deployment', personas: ['Technical'], abstractionLevel: 'Deployment', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation'] },
  { id: 'business-capability-map', name: 'Business Capability Map', personas: ['Business'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'value-stream', name: 'Value Stream Diagram', personas: ['Business'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'application-landscape', name: 'Application/Enterprise Landscape', personas: ['Enterprise'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'roadmap', name: 'Roadmap', personas: ['Enterprise'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'solution-architecture', name: 'Solution Architecture', personas: ['Solution'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: CLOUD_LIBRARIES },
  { id: 'sequence', name: 'Sequence Diagram', personas: ['Solution', 'Technical'], abstractionLevel: 'N/A', dslFamily: 'sequence', defaultPaletteLibraryIds: ['generic'] },
  { id: 'network', name: 'Network Diagram', personas: ['Technical'], abstractionLevel: 'N/A', dslFamily: 'architecture', defaultPaletteLibraryIds: CLOUD_LIBRARIES },
  { id: 'deployment', name: 'Deployment Diagram', personas: ['Technical'], abstractionLevel: 'N/A', dslFamily: 'architecture', defaultPaletteLibraryIds: CLOUD_LIBRARIES },
  { id: 'cloud-infrastructure', name: 'Cloud Infrastructure Diagram', personas: ['Technical'], abstractionLevel: 'N/A', dslFamily: 'architecture', defaultPaletteLibraryIds: CLOUD_LIBRARIES },
  { id: 'erd', name: 'Entity-Relationship Diagram', personas: ['Solution', 'Technical'], abstractionLevel: 'N/A', dslFamily: 'erd', defaultPaletteLibraryIds: ['generic'] },
  { id: 'uml', name: 'UML Class Diagram', personas: ['Solution', 'Technical'], abstractionLevel: 'N/A', dslFamily: 'uml', defaultPaletteLibraryIds: ['generic'] },
];

export async function seedDiagramTypes(): Promise<void> {
  const pool = getPool();
  for (const type of DIAGRAM_TYPES) {
    await pool.query(
      `INSERT INTO diagram_types (id, name, personas, abstraction_level, dsl_family, default_palette_library_ids)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         personas = EXCLUDED.personas,
         abstraction_level = EXCLUDED.abstraction_level,
         dsl_family = EXCLUDED.dsl_family,
         default_palette_library_ids = EXCLUDED.default_palette_library_ids`,
      [type.id, type.name, type.personas, type.abstractionLevel, type.dslFamily, type.defaultPaletteLibraryIds],
    );
  }
}
