import type { ParseError } from '../dsl/types.js';
import { extractFirstTable, splitIntoSections } from './markdown-table.js';
import { AliasAllocator, err, findSection, readMetadataFields } from './template-helpers.js';
import type { TemplateCompiler, TemplateCompileResult } from './types.js';

/**
 * Compiles a filled-in copy of docs/c4-context-template.md into Mermaid `C4Context` DSL text.
 * Mirrors that document's own "Mapping reference" section exactly -- see it for the grammar this
 * file targets. Deliberately generates DSL text directly rather than building a DiagramModel via
 * diagram-ops.ts and serializing it: c4.ts's own ELEMENT_TO_ROLE map collapses e.g.
 * Person/Person_Ext to the identical role/shape (no model field distinguishes "external" at all),
 * so going through the model layer first would silently and irrecoverably drop every entity's
 * Internal/External column before any DSL existed.
 */

const ENTITY_TYPES = ['Person', 'System', 'SystemDb', 'SystemQueue'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];
const BOUNDARY_TYPES = ['Enterprise', 'System'] as const;

interface Entity {
  name: string;
  alias: string;
  keyword: string;
  description: string;
}

interface Boundary {
  alias: string;
  label: string;
  keyword: string;
  memberAliases: string[];
}

interface Rel {
  fromAlias: string;
  toAlias: string;
  label: string;
  technology?: string;
}

interface StyleLine {
  alias: string;
  bgColor?: string;
  fontColor?: string;
  borderColor?: string;
}

/** Mermaid C4 string literals have no escape mechanism (`"([^"]*)"` in c4.ts's own ELEMENT_PATTERN
 *  / REL_PATTERN) -- a literal `"` in user-entered text would otherwise produce DSL the real
 *  parser can't read back. Replacing with a plain quote keeps the generated DSL always valid. */
function sanitizeText(value: string): string {
  return value.replace(/"/g, "'");
}

export const c4ContextTemplateCompiler: TemplateCompiler = {
  compile(markdownText: string): TemplateCompileResult {
    const errors: ParseError[] = [];
    const sections = splitIntoSections(markdownText);

    const metadataSection = findSection(sections, 'diagram metadata');
    const boundariesSection = findSection(sections, 'boundaries');
    const entitiesSection = findSection(sections, 'surrounding entities');
    const relationshipsSection = findSection(sections, 'relationships');
    const stylingSection = findSection(sections, 'styling notes');

    if (!metadataSection) errors.push(err('Missing required section "1. Diagram metadata".'));
    if (!entitiesSection) errors.push(err('Missing required section "3. Surrounding entities".'));
    if (!relationshipsSection) errors.push(err('Missing required section "4. Relationships".'));
    if (errors.length > 0) return { errors };

    // --- Section 1: metadata --------------------------------------------------------------
    const fields = readMetadataFields(metadataSection!);
    const title = fields.get('Diagram title') ?? '';
    const centralSystemName = fields.get('Central system name') ?? '';
    const centralSystemDescription = fields.get('Central system description (one line)') ?? '';
    // "Central system technology (optional)" is captured by readMetadataFields but has no slot in
    // System(...)'s own grammar (no 4th positional tech arg, unlike Container/Component) -- so, per
    // this file's own established "capture optionally, don't model" precedent (c4.ts's Rel
    // technology arg, ELEMENT_PATTERN's trailing args), it is deliberately never emitted.

    if (!centralSystemName) errors.push(err('Section 1: "Central system name" is required.'));
    if (!centralSystemDescription) errors.push(err('Section 1: "Central system description (one line)" is required.'));
    if (errors.length > 0) return { errors };

    const aliases = new AliasAllocator();
    const centralAlias = aliases.allocate(centralSystemName);

    // --- Section 3: surrounding entities ---------------------------------------------------
    const entities: Entity[] = [];
    const entityByName = new Map<string, Entity>();
    for (const row of extractFirstTable(entitiesSection!.body)) {
      const name = (row['Name'] ?? '').trim();
      if (!name) continue;
      const type = (row['Type'] ?? '').trim() as EntityType;
      const scope = (row['Internal/External'] ?? '').trim();
      if (!ENTITY_TYPES.includes(type)) {
        errors.push(err(`Section 3, entity "${name}": unrecognized Type "${row['Type'] ?? ''}" (expected one of ${ENTITY_TYPES.join(', ')}).`));
        continue;
      }
      if (scope !== 'Internal' && scope !== 'External') {
        errors.push(err(`Section 3, entity "${name}": unrecognized Internal/External value "${row['Internal/External'] ?? ''}" (expected "Internal" or "External").`));
        continue;
      }
      const entity: Entity = {
        name,
        alias: aliases.allocate(name),
        keyword: scope === 'External' ? `${type}_Ext` : type,
        description: sanitizeText((row['Description (one line)'] ?? row['Description'] ?? '').trim()),
      };
      entities.push(entity);
      entityByName.set(name, entity);
    }

    // --- Section 2: boundaries (optional) ---------------------------------------------------
    const boundaries: Boundary[] = [];
    const memberToBoundary = new Map<string, Boundary>();
    if (boundariesSection) {
      for (const row of extractFirstTable(boundariesSection.body)) {
        const boundaryName = (row['Boundary name'] ?? '').trim();
        if (!boundaryName) continue;
        const type = (row['Type (Enterprise / System)'] ?? row['Type'] ?? '').trim();
        if (!BOUNDARY_TYPES.includes(type as (typeof BOUNDARY_TYPES)[number])) {
          errors.push(err(`Section 2, boundary "${boundaryName}": unrecognized Type "${type}" (expected "Enterprise" or "System").`));
          continue;
        }
        const memberNames = (row['Entities inside'] ?? '')
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        const memberAliases: string[] = [];
        for (const memberName of memberNames) {
          const entity = entityByName.get(memberName);
          if (!entity) {
            errors.push(err(`Section 2, boundary "${boundaryName}": "${memberName}" is not listed in Section 3 (Surrounding entities).`));
            continue;
          }
          memberAliases.push(entity.alias);
        }
        const boundary: Boundary = {
          alias: aliases.allocate(boundaryName),
          label: sanitizeText(boundaryName),
          keyword: `${type}_Boundary`,
          memberAliases,
        };
        boundaries.push(boundary);
        for (const memberAlias of memberAliases) memberToBoundary.set(memberAlias, boundary);
      }
    }

    // --- Section 4: relationships ------------------------------------------------------------
    const rels: Rel[] = [];
    const resolveAlias = (name: string): string | undefined =>
      name === centralSystemName ? centralAlias : entityByName.get(name)?.alias;

    for (const row of extractFirstTable(relationshipsSection!.body)) {
      const from = (row['From'] ?? '').trim();
      const to = (row['To'] ?? '').trim();
      if (!from && !to) continue;
      const label = (row['Label (short verb phrase)'] ?? row['Label'] ?? '').trim();
      const technology = (row['Technology/protocol (optional)'] ?? row['Technology/protocol'] ?? '').trim();

      const fromAlias = resolveAlias(from);
      const toAlias = resolveAlias(to);
      if (!fromAlias) {
        errors.push(err(`Section 4: relationship "From" value "${from}" is not the central system and not listed in Section 3.`));
        continue;
      }
      if (!toAlias) {
        errors.push(err(`Section 4: relationship "To" value "${to}" is not the central system and not listed in Section 3.`));
        continue;
      }
      const fromIsCentral = from === centralSystemName;
      const toIsCentral = to === centralSystemName;
      if (fromIsCentral === toIsCentral) {
        errors.push(
          err(
            `Section 4: relationship "${from}" -> "${to}" must connect the central system to exactly one surrounding entity (Level 1 rule) -- never entity-to-entity, and never the central system to itself.`,
          ),
        );
        continue;
      }
      if (!label) {
        errors.push(err(`Section 4: relationship "${from}" -> "${to}" is missing a Label.`));
        continue;
      }
      rels.push({ fromAlias, toAlias, label: sanitizeText(label), technology: technology ? sanitizeText(technology) : undefined });
    }

    // --- Section 5: styling notes (optional) --------------------------------------------------
    const styleLines: StyleLine[] = [];
    if (stylingSection) {
      for (const row of extractFirstTable(stylingSection.body)) {
        const entityName = (row['Entity name'] ?? '').trim();
        if (!entityName) continue;
        const alias = resolveAlias(entityName);
        if (!alias) {
          errors.push(err(`Section 5: styling entry "${entityName}" is not the central system and not listed in Section 3.`));
          continue;
        }
        const bgColor = (row['Background color'] ?? '').trim();
        const fontColor = (row['Font color'] ?? '').trim();
        const borderColor = (row['Border color'] ?? '').trim();
        if (!bgColor && !fontColor && !borderColor) continue;
        styleLines.push({ alias, bgColor: bgColor || undefined, fontColor: fontColor || undefined, borderColor: borderColor || undefined });
      }
    }

    if (errors.length > 0) return { errors };

    // --- Assembly --------------------------------------------------------------------------
    const lines: string[] = ['C4Context'];
    lines.push(`    title ${title ? sanitizeText(title) : `System Context diagram: ${centralSystemName}`}`);
    lines.push('');
    lines.push(`    System(${centralAlias}, "${sanitizeText(centralSystemName)}", "${centralSystemDescription}")`);

    const elementLine = (e: Entity) => `${e.keyword}(${e.alias}, "${sanitizeText(e.name)}", "${e.description}")`;

    for (const entity of entities.filter((e) => !memberToBoundary.has(e.alias))) {
      lines.push(`    ${elementLine(entity)}`);
    }
    for (const boundary of boundaries) {
      lines.push(`    ${boundary.keyword}(${boundary.alias}, "${boundary.label}") {`);
      for (const memberAlias of boundary.memberAliases) {
        const entity = entities.find((e) => e.alias === memberAlias)!;
        lines.push(`        ${elementLine(entity)}`);
      }
      lines.push('    }');
    }
    lines.push('');
    for (const rel of rels) {
      const techArg = rel.technology ? `, "${rel.technology}"` : '';
      lines.push(`    Rel(${rel.fromAlias}, ${rel.toAlias}, "${rel.label}"${techArg})`);
    }
    if (styleLines.length > 0) {
      lines.push('');
      for (const s of styleLines) {
        const args = [
          s.bgColor ? `$bgColor="${sanitizeText(s.bgColor)}"` : undefined,
          s.fontColor ? `$fontColor="${sanitizeText(s.fontColor)}"` : undefined,
          s.borderColor ? `$borderColor="${sanitizeText(s.borderColor)}"` : undefined,
        ].filter((a): a is string => !!a);
        lines.push(`    UpdateElementStyle(${s.alias}, ${args.join(', ')})`);
      }
    }

    return { dsl: lines.join('\n') };
  },
};
