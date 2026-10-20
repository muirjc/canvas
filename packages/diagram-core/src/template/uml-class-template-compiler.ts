import type { ParseError } from '../dsl/types.js';
import { extractFirstTable, splitIntoSections } from './markdown-table.js';
import { cell, err, findSection, pickOption, readMetadataFields } from './template-helpers.js';
import type { TemplateCompiler, TemplateCompileResult } from './types.js';

/**
 * canvas-73s.3: compiles a filled-in copy of docs/uml-class-template.md into Mermaid
 * `classDiagram` DSL, following that document's mapping reference. Class names are used as-is (a
 * class diagram's names are code identifiers), so a name that isn't one is reported, not renamed.
 */

const CLASS_NAME = /^([A-Za-z_][A-Za-z0-9_]*)(?:<([^<>]+)>)?$/;
const NAMESPACE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const KINDS = ['Attribute', 'Method'] as const;
const VISIBILITY: Record<string, string> = { public: '+', '+': '+', private: '-', '-': '-', protected: '#', '#': '#', package: '~', '~': '~' };
const MODIFIERS = { Static: '$', Abstract: '*' } as const;
const RELATIONSHIPS = ['Inheritance', 'Realization', 'Composition', 'Aggregation', 'Association', 'Dependency', 'Link'] as const;
type Relationship = (typeof RELATIONSHIPS)[number];
const TOKEN: Record<Exclude<Relationship, 'Inheritance'>, string> = {
  Realization: '..|>',
  Composition: '*--',
  Aggregation: 'o--',
  Association: '-->',
  Dependency: '..>',
  Link: '--',
};
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

interface UmlClass {
  name: string;
  generic?: string;
  stereotype?: string;
  namespace?: string;
  members: string[];
}

/** `List<String>` -> `List~String~` (Mermaid's generic notation); spaces inside a type dropped. */
function mermaidType(type: string): string {
  return type.replace(/</g, '~').replace(/>/g, '~').replace(/\s+/g, '');
}

function quoted(value: string): string {
  return value ? ` "${value.replace(/"/g, "'")}"` : '';
}

export const umlClassTemplateCompiler: TemplateCompiler = {
  compile(markdownText: string): TemplateCompileResult {
    const errors: ParseError[] = [];
    const sections = splitIntoSections(markdownText);
    const metadataSection = findSection(sections, 'diagram metadata');
    const classesSection = findSection(sections, 'classes');
    const membersSection = findSection(sections, 'members');
    const relationshipsSection = findSection(sections, 'relationships');

    if (!classesSection) return { errors: [err('Missing required section "2. Classes".')] };

    const fields = metadataSection ? readMetadataFields(metadataSection) : new Map<string, string>();
    const title = (fields.get('Diagram title') ?? '').trim();
    const directionRaw = [...fields.entries()].find(([field]) => field.startsWith('Direction'))?.[1] ?? '';
    const direction = directionRaw ? DIRECTIONS[directionRaw.toLowerCase()] : undefined;
    if (directionRaw && !direction) errors.push(err(`Section 1: unrecognized Direction "${directionRaw}" (expected Top to bottom, Left to right, Bottom to top or Right to left).`));

    // --- Section 2: classes -------------------------------------------------------------------
    const classes: UmlClass[] = [];
    const byName = new Map<string, UmlClass>();
    for (const row of extractFirstTable(classesSection.body)) {
      const raw = cell(row, 'Class');
      if (!raw) continue;
      const where = `Section 2, class "${raw}"`;
      const match = raw.match(CLASS_NAME);
      if (!match) {
        errors.push(err(`${where}: a class name must be one word (letters, digits, _), optionally generic like Repository<T>.`));
        continue;
      }
      const [, name, generic] = match;
      if (byName.has(name)) {
        errors.push(err(`${where}: listed twice.`));
        continue;
      }
      const stereotype = cell(row, 'Stereotype');
      if (stereotype && !/^\w+$/.test(stereotype)) {
        errors.push(err(`${where}: a stereotype is one word, e.g. interface.`));
        continue;
      }
      const namespace = cell(row, 'Namespace');
      if (namespace && !NAMESPACE_NAME.test(namespace)) {
        errors.push(err(`${where}: namespace "${namespace}" must be a name like Billing or Billing.Core.`));
        continue;
      }
      const umlClass: UmlClass = { name, generic: generic ? mermaidType(generic) : undefined, stereotype: stereotype || undefined, namespace: namespace || undefined, members: [] };
      classes.push(umlClass);
      byName.set(name, umlClass);
    }
    if (classes.length === 0) errors.push(err('Section 2: list at least one class.'));

    // Rows elsewhere may name a class with or without its generic part.
    const resolve = (raw: string, where: string): UmlClass | undefined => {
      const umlClass = byName.get(raw.replace(/<.*>$/, ''));
      if (!umlClass) errors.push(err(`${where}: "${raw}" is not listed in Section 2 (Classes).`));
      return umlClass;
    };

    // --- Section 3: members -------------------------------------------------------------------
    if (membersSection) {
      for (const row of extractFirstTable(membersSection.body)) {
        const className = cell(row, 'Class');
        const member = cell(row, 'Member');
        if (!className && !member) continue;
        const where = `Section 3, member "${className}.${member}"`;
        const umlClass = resolve(className, where);
        if (!umlClass) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) {
          errors.push(err(`${where}: a member name must be one word (letters, digits, _).`));
          continue;
        }
        const kind = pickOption(cell(row, 'Kind') || (cell(row, 'Parameters') ? 'Method' : 'Attribute'), KINDS);
        const visibilityRaw = cell(row, 'Visibility');
        const visibility = visibilityRaw ? VISIBILITY[visibilityRaw.toLowerCase()] : '';
        const modifierRaw = cell(row, 'Modifier');
        const modifier = modifierRaw ? pickOption(modifierRaw, Object.keys(MODIFIERS) as (keyof typeof MODIFIERS)[]) : undefined;
        if (!kind || visibility === undefined || (modifierRaw && !modifier)) {
          errors.push(err(`${where}: Kind must be Attribute or Method, Visibility Public/Private/Protected/Package, Modifier Static/Abstract.`));
          continue;
        }
        const type = mermaidType(cell(row, 'Type'));
        const mod = modifier ? MODIFIERS[modifier] : '';
        umlClass.members.push(
          kind === 'Method'
            ? `${visibility}${member}(${cell(row, 'Parameters').replace(/</g, '~').replace(/>/g, '~')})${type ? ` ${type}` : ''}${mod}`
            : `${visibility}${type ? `${type} ` : ''}${member}${mod}`,
        );
      }
    }

    // --- Section 4: relationships -------------------------------------------------------------
    const relationships: string[] = [];
    if (relationshipsSection) {
      for (const row of extractFirstTable(relationshipsSection.body)) {
        const from = cell(row, 'From');
        const to = cell(row, 'To');
        if (!from && !to) continue;
        const where = `Section 4, "${from}" -> "${to}"`;
        const fromClass = resolve(from, where);
        const toClass = resolve(to, where);
        if (!fromClass || !toClass) continue;
        const relationship = pickOption(cell(row, 'Relationship') || 'Association', RELATIONSHIPS);
        if (!relationship) {
          errors.push(err(`${where}: unrecognized Relationship "${cell(row, 'Relationship')}" (expected ${RELATIONSHIPS.join(', ')}).`));
          continue;
        }
        const label = cell(row, 'Label');
        const fromMult = quoted(cell(row, 'From multiplicity'));
        const toMult = quoted(cell(row, 'To multiplicity'));
        const suffix = label ? ` : ${label}` : '';
        // Mermaid has no "--|>" here: inheritance is written parent-first with "<|--".
        relationships.push(
          relationship === 'Inheritance'
            ? `${toClass.name}${toMult} <|--${fromMult} ${fromClass.name}${suffix}`
            : `${fromClass.name}${fromMult} ${TOKEN[relationship]}${toMult} ${toClass.name}${suffix}`,
        );
      }
    }

    if (errors.length > 0) return { errors };

    // --- Assembly ------------------------------------------------------------------------------
    const lines: string[] = ['classDiagram'];
    if (title) lines.push(`    title ${title}`);
    if (direction) lines.push(`    direction ${direction}`);
    const classLines = (c: UmlClass, indent: string): string[] => {
      const head = `class ${c.name}${c.generic ? `~${c.generic}~` : ''}${c.stereotype ? ` <<${c.stereotype}>>` : ''}`;
      if (c.members.length === 0) return [`${indent}${head}`];
      return [`${indent}${head} {`, ...c.members.map((m) => `${indent}    ${m}`), `${indent}}`];
    };
    for (const c of classes.filter((c) => !c.namespace)) lines.push(...classLines(c, '    '));
    const namespaces = [...new Set(classes.flatMap((c) => (c.namespace ? [c.namespace] : [])))];
    for (const namespace of namespaces) {
      lines.push(`    namespace ${namespace} {`);
      for (const c of classes.filter((c) => c.namespace === namespace)) lines.push(...classLines(c, '        '));
      lines.push('    }');
    }
    if (relationships.length > 0) lines.push('');
    for (const relationship of relationships) lines.push(`    ${relationship}`);
    return { dsl: lines.join('\n') + '\n' };
  },
};
