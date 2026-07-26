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
const CLOUD_LIBRARIES = ['azure-icons', 'aws-icons', 'generic'];

/** The full built-in DiagramType catalog required by FR-006, scoped by persona per Constitution III. */
const DIAGRAM_TYPES: DiagramTypeSeed[] = [
  { id: 'flowchart', name: 'Generic Flowchart', personas: ALL_PERSONAS, abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'c4-context', name: 'C4 Context', personas: ['Solution', 'Technical'], abstractionLevel: 'Context', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation', 'generic'] },
  { id: 'c4-container', name: 'C4 Container', personas: ['Solution', 'Technical'], abstractionLevel: 'Container', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation', 'generic'] },
  { id: 'c4-component', name: 'C4 Component', personas: ['Technical'], abstractionLevel: 'Component', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation', 'generic'] },
  { id: 'c4-code', name: 'C4 Code', personas: ['Technical'], abstractionLevel: 'Code', dslFamily: 'c4', defaultPaletteLibraryIds: ['c4-notation', 'generic'] },
  { id: 'business-capability-map', name: 'Business Capability Map', personas: ['Business'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'value-stream', name: 'Value Stream Diagram', personas: ['Business'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'application-landscape', name: 'Application/Enterprise Landscape', personas: ['Enterprise'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'roadmap', name: 'Roadmap', personas: ['Enterprise'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic'] },
  { id: 'solution-architecture', name: 'Solution Architecture', personas: ['Solution'], abstractionLevel: 'N/A', dslFamily: 'flowchart', defaultPaletteLibraryIds: ['generic', ...CLOUD_LIBRARIES] },
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
