import type { ParseError } from '../dsl/types.js';
import { extractFirstTable, splitIntoSections } from './markdown-table.js';
import { AliasAllocator, cell, err, findSection, listCell, pickOption, readMetadataFields, readYesNo } from './template-helpers.js';
import type { TemplateCompiler, TemplateCompileResult } from './types.js';

/**
 * canvas-73s.2: compiles a filled-in copy of docs/erd-template.md into Mermaid `erDiagram` DSL,
 * following that document's mapping reference. An entity name that isn't a plain identifier gets
 * a generated id plus an `id[Name]` alias, so the label survives.
 */

const CARDINALITIES = ['Exactly one', 'Zero or one', 'One or more', 'Zero or more'] as const;
type Cardinality = (typeof CARDINALITIES)[number];
const FROM_TOKEN: Record<Cardinality, string> = { 'Exactly one': '||', 'Zero or one': '|o', 'One or more': '}|', 'Zero or more': '}o' };
const TO_TOKEN: Record<Cardinality, string> = { 'Exactly one': '||', 'Zero or one': 'o|', 'One or more': '|{', 'Zero or more': 'o{' };
const KEYS = ['PK', 'FK', 'UK'] as const;
const DIRECTIONS: Record<string, string> = {
  tb: 'TB',
  td: 'TB',
  'top to bottom': 'TB',
  lr: 'LR',
  'left to right': 'LR',
  bt: 'BT',
  'bottom to top': 'BT',
  rl: 'RL',
  'right to left': 'RL',
};
const PLAIN_ID = /^[A-Za-z0-9_-]+$/;

interface Entity {
  id: string;
  name: string;
  attributes: string[];
}

/** "Order Line" -> "Order_Line": an erDiagram id allows only letters, digits, `_` and `-`. */
function entityId(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return id || 'entity';
}

export const erdTemplateCompiler: TemplateCompiler = {
  compile(markdownText: string): TemplateCompileResult {
    const errors: ParseError[] = [];
    const sections = splitIntoSections(markdownText);
    const metadataSection = findSection(sections, 'diagram metadata');
    const entitiesSection = findSection(sections, 'entities');
    const attributesSection = findSection(sections, 'attributes');
    const relationshipsSection = findSection(sections, 'relationships');

    if (!entitiesSection) errors.push(err('Missing required section "2. Entities".'));
    if (!relationshipsSection) errors.push(err('Missing required section "4. Relationships".'));
    if (errors.length > 0) return { errors };

    const fields = metadataSection ? readMetadataFields(metadataSection) : new Map<string, string>();
    const title = (fields.get('Diagram title') ?? '').trim();
    const directionRaw = [...fields.entries()].find(([field]) => field.startsWith('Direction'))?.[1] ?? '';
    const direction = directionRaw ? DIRECTIONS[directionRaw.toLowerCase()] : undefined;
    if (directionRaw && !direction) errors.push(err(`Section 1: unrecognized Direction "${directionRaw}" (expected Top to bottom, Left to right, Bottom to top or Right to left).`));

    // --- Section 2: entities ------------------------------------------------------------------
    const ids = new AliasAllocator(entityId);
    const entities: Entity[] = [];
    const byName = new Map<string, Entity>();
    for (const row of extractFirstTable(entitiesSection!.body)) {
      const name = cell(row, 'Name');
      if (!name) continue;
      if (byName.has(name)) {
        errors.push(err(`Section 2: entity "${name}" is listed twice.`));
        continue;
      }
      const entity: Entity = { id: ids.allocate(name), name, attributes: [] };
      entities.push(entity);
      byName.set(name, entity);
    }
    if (entities.length === 0) errors.push(err('Section 2: list at least one entity.'));

    const resolve = (name: string, where: string): Entity | undefined => {
      const entity = byName.get(name);
      if (!entity) errors.push(err(`${where}: "${name}" is not listed in Section 2 (Entities).`));
      return entity;
    };

    // --- Section 3: attributes ----------------------------------------------------------------
    if (attributesSection) {
      for (const row of extractFirstTable(attributesSection.body)) {
        const entityName = cell(row, 'Entity');
        const attribute = cell(row, 'Attribute');
        if (!entityName && !attribute) continue;
        const where = `Section 3, attribute "${entityName}.${attribute}"`;
        const entity = resolve(entityName, where);
        if (!entity) continue;
        const type = cell(row, 'Type').replace(/\s+/g, '');
        if (!attribute || !type) {
          errors.push(err(`${where}: Attribute and Type are both required.`));
          continue;
        }
        const keys: string[] = [];
        let badKey = false;
        for (const key of listCell(cell(row, 'Key'))) {
          const known = pickOption(key, KEYS);
          if (!known) {
            errors.push(err(`${where}: unrecognized Key "${key}" (expected PK, FK or UK).`));
            badKey = true;
          } else if (!keys.includes(known)) {
            keys.push(known);
          }
        }
        if (badKey) continue;
        const comment = cell(row, 'Comment').replace(/"/g, "'");
        const parts = [type, attribute.replace(/\s+/g, '_'), keys.join(', '), comment ? `"${comment}"` : ''].filter(Boolean);
        entity.attributes.push(parts.join(' '));
      }
    }

    // --- Section 4: relationships -------------------------------------------------------------
    const relationships: string[] = [];
    for (const row of extractFirstTable(relationshipsSection!.body)) {
      const from = cell(row, 'From');
      const to = cell(row, 'To');
      if (!from && !to) continue;
      const where = `Section 4, "${from}" -> "${to}"`;
      const fromEntity = resolve(from, where);
      const toEntity = resolve(to, where);
      if (!fromEntity || !toEntity) continue;
      const fromCard = pickOption(cell(row, 'From cardinality') || 'Exactly one', CARDINALITIES);
      const toCard = pickOption(cell(row, 'To cardinality') || 'Zero or more', CARDINALITIES);
      if (!fromCard || !toCard) {
        errors.push(err(`${where}: cardinality must be one of ${CARDINALITIES.join(', ')}.`));
        continue;
      }
      const identifying = readYesNo(cell(row, 'Identifying'), true);
      if (identifying === undefined) {
        errors.push(err(`${where}: Identifying must be Yes or No.`));
        continue;
      }
      const label = cell(row, 'Label') || 'relates to';
      relationships.push(`${fromEntity.id} ${FROM_TOKEN[fromCard]}${identifying ? '--' : '..'}${TO_TOKEN[toCard]} ${toEntity.id} : ${label}`);
    }

    if (errors.length > 0) return { errors };

    // --- Assembly ------------------------------------------------------------------------------
    const lines: string[] = ['erDiagram'];
    if (title) lines.push(`    title ${title}`);
    if (direction) lines.push(`    direction ${direction}`);
    for (const entity of entities) {
      const head = entity.id === entity.name && PLAIN_ID.test(entity.name) ? entity.id : `${entity.id}[${entity.name.replace(/[[\]]/g, '')}]`;
      if (entity.attributes.length === 0) {
        lines.push(`    ${head}`);
        continue;
      }
      lines.push(`    ${head} {`);
      for (const attribute of entity.attributes) lines.push(`        ${attribute}`);
      lines.push('    }');
    }
    if (relationships.length > 0) lines.push('');
    for (const relationship of relationships) lines.push(`    ${relationship}`);
    return { dsl: lines.join('\n') + '\n' };
  },
};
