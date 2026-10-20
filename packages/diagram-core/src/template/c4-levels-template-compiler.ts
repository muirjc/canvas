import type { ParseError } from '../dsl/types.js';
import { extractFirstTable, splitIntoSections } from './markdown-table.js';
import { AliasAllocator, cell, err, findSection, pickOption, readMetadataFields } from './template-helpers.js';
import type { TemplateCompiler, TemplateCompileResult } from './types.js';

/**
 * canvas-73s.5: compiles a filled-in copy of docs/c4-levels-template.md into Mermaid C4 DSL for
 * the C4 Container, Component and Deployment diagram types -- one compiler per level, from one
 * factory, differing only in the header and the element/boundary types allowed. Unlike the Level 1
 * template (c4-context-template-compiler.ts) there's no "central system" rule: any two elements
 * can be related.
 */

type Level = 'container' | 'component' | 'deployment';

const HEADER: Record<Level, string> = { container: 'C4Container', component: 'C4Component', deployment: 'C4Deployment' };
const BASE_TYPES = ['Person', 'System', 'SystemDb', 'SystemQueue', 'Container', 'ContainerDb', 'ContainerQueue'] as const;
const COMPONENT_TYPES = ['Component', 'ComponentDb', 'ComponentQueue'] as const;
const ELEMENT_TYPES: Record<Level, readonly string[]> = {
  container: BASE_TYPES,
  component: [...BASE_TYPES, ...COMPONENT_TYPES],
  deployment: BASE_TYPES,
};
const BOUNDARY_TYPES: Record<Level, readonly string[]> = {
  container: ['System', 'Container', 'Enterprise', 'Boundary'],
  component: ['System', 'Container', 'Enterprise', 'Boundary'],
  deployment: ['Node'],
};
const BOUNDARY_KEYWORD: Record<string, string> = {
  System: 'System_Boundary',
  Container: 'Container_Boundary',
  Enterprise: 'Enterprise_Boundary',
  Boundary: 'Boundary',
  Node: 'Deployment_Node',
};

interface Boundary {
  id: string;
  name: string;
  line: string;
  insideName: string;
  parent?: Boundary;
}

interface Element {
  line: string;
  boundary?: Boundary;
}

/** Mermaid C4 text has no escape for `"`, so it becomes a single quote. */
const q = (value: string) => `"${value.replace(/"/g, "'")}"`;

function makeCompiler(level: Level): TemplateCompiler {
  return {
    compile(markdownText: string): TemplateCompileResult {
      const errors: ParseError[] = [];
      const sections = splitIntoSections(markdownText);
      const metadataSection = findSection(sections, 'diagram metadata');
      const boundariesSection = findSection(sections, 'boundaries');
      const elementsSection = findSection(sections, 'elements');
      const relationshipsSection = findSection(sections, 'relationships');

      if (!elementsSection) errors.push(err('Missing required section "3. Elements".'));
      if (!relationshipsSection) errors.push(err('Missing required section "4. Relationships".'));
      if (errors.length > 0) return { errors };

      const title = metadataSection ? (readMetadataFields(metadataSection).get('Diagram title') ?? '') : '';
      const ids = new AliasAllocator();

      // --- Section 2: boundaries ----------------------------------------------------------------
      const boundaries: Boundary[] = [];
      const boundaryByName = new Map<string, Boundary>();
      if (boundariesSection) {
        for (const row of extractFirstTable(boundariesSection.body)) {
          const name = cell(row, 'Boundary');
          if (!name) continue;
          const where = `Section 2, boundary "${name}"`;
          const allowed = BOUNDARY_TYPES[level];
          const type = pickOption(cell(row, 'Type') || allowed[0], allowed);
          if (!type) {
            errors.push(err(`${where}: Type "${cell(row, 'Type')}" isn't allowed on a ${HEADER[level]} diagram (expected ${allowed.join(', ')}).`));
            continue;
          }
          if (boundaryByName.has(name)) {
            errors.push(err(`${where}: listed twice.`));
            continue;
          }
          const id = ids.allocate(name);
          const technology = cell(row, 'Technology');
          const description = cell(row, 'Description');
          // Positional args per Mermaid: Boundary(alias, label, type); Deployment_Node(alias, label, type, descr).
          const args = [id, q(name)];
          if (type === 'Node') {
            if (technology || description) args.push(q(technology));
            if (description) args.push(q(description));
          } else if (type === 'Boundary' && technology) {
            args.push(q(technology));
          }
          const boundary: Boundary = { id, name, line: `${BOUNDARY_KEYWORD[type]}(${args.join(', ')}) {`, insideName: cell(row, 'Inside') };
          boundaries.push(boundary);
          boundaryByName.set(name, boundary);
        }
      }
      const boundaryNamed = (name: string, where: string): Boundary | undefined => {
        const boundary = boundaryByName.get(name);
        if (!boundary) errors.push(err(`${where}: boundary "${name}" is not listed in Section 2 (Boundaries).`));
        return boundary;
      };
      for (const boundary of boundaries) {
        if (boundary.insideName) boundary.parent = boundaryNamed(boundary.insideName, `Section 2, boundary "${boundary.name}"`);
      }
      for (const boundary of boundaries) {
        const seen = new Set<Boundary>();
        for (let b: Boundary | undefined = boundary; b; b = b.parent) {
          if (seen.has(b)) {
            errors.push(err(`Section 2: boundary "${boundary.name}" ends up inside itself.`));
            boundary.parent = undefined;
            break;
          }
          seen.add(b);
        }
      }

      // --- Section 3: elements ------------------------------------------------------------------
      const elements: Element[] = [];
      const elementIdByName = new Map<string, string>();
      for (const row of extractFirstTable(elementsSection!.body)) {
        const name = cell(row, 'Name');
        if (!name) continue;
        const where = `Section 3, element "${name}"`;
        const allowed = ELEMENT_TYPES[level];
        const type = pickOption(cell(row, 'Type'), allowed);
        if (!type) {
          errors.push(err(`${where}: Type "${cell(row, 'Type')}" isn't allowed on a ${HEADER[level]} diagram (expected ${allowed.join(', ')}).`));
          continue;
        }
        const scope = pickOption(cell(row, 'Internal/External') || 'Internal', ['Internal', 'External'] as const);
        if (!scope) {
          errors.push(err(`${where}: Internal/External must be Internal or External.`));
          continue;
        }
        if (elementIdByName.has(name) || boundaryByName.has(name)) {
          errors.push(err(`${where}: the name is already used by another element or boundary.`));
          continue;
        }
        const technology = cell(row, 'Technology');
        const hasTechnology = type.startsWith('Container') || type.startsWith('Component');
        if (technology && !hasTechnology) {
          errors.push(err(`${where}: only containers and components have a Technology.`));
          continue;
        }
        const inside = cell(row, 'Inside');
        const boundary = inside ? boundaryNamed(inside, where) : undefined;
        if (inside && !boundary) continue;
        const id = ids.allocate(name);
        elementIdByName.set(name, id);
        const description = cell(row, 'Description');
        const args = [id, q(name)];
        if (hasTechnology) args.push(q(technology));
        args.push(q(description));
        // Trailing empty strings add nothing; drop them so the line reads naturally.
        while (args.length > 2 && args[args.length - 1] === '""') args.pop();
        elements.push({ line: `${type}${scope === 'External' ? '_Ext' : ''}(${args.join(', ')})`, boundary });
      }
      if (elements.length === 0 && errors.length === 0) errors.push(err('Section 3: list at least one element.'));

      // --- Section 4: relationships -------------------------------------------------------------
      const relLines: string[] = [];
      for (const row of extractFirstTable(relationshipsSection!.body)) {
        const from = cell(row, 'From');
        const to = cell(row, 'To');
        if (!from && !to) continue;
        const where = `Section 4, "${from}" -> "${to}"`;
        const fromId = elementIdByName.get(from);
        const toId = elementIdByName.get(to);
        if (!fromId || !toId) {
          const missing = !fromId ? from : to;
          errors.push(err(boundaryByName.has(missing) ? `${where}: "${missing}" is a boundary -- relate the elements inside it.` : `${where}: "${missing}" is not listed in Section 3 (Elements).`));
          continue;
        }
        const label = cell(row, 'Label');
        if (!label) {
          errors.push(err(`${where}: a Label is required.`));
          continue;
        }
        const technology = cell(row, 'Technology');
        relLines.push(`Rel(${fromId}, ${toId}, ${q(label)}${technology ? `, ${q(technology)}` : ''})`);
      }

      if (errors.length > 0) return { errors };

      // --- Assembly ------------------------------------------------------------------------------
      const lines: string[] = [HEADER[level]];
      if (title) lines.push(`    title ${title}`);
      const emit = (parent: Boundary | undefined, depth: number) => {
        const indent = '    '.repeat(depth);
        for (const element of elements.filter((e) => e.boundary === parent)) lines.push(`${indent}${element.line}`);
        for (const boundary of boundaries.filter((b) => b.parent === parent)) {
          lines.push(`${indent}${boundary.line}`);
          emit(boundary, depth + 1);
          lines.push(`${indent}}`);
        }
      };
      emit(undefined, 1);
      if (relLines.length > 0) lines.push('');
      for (const line of relLines) lines.push(`    ${line}`);
      return { dsl: lines.join('\n') + '\n' };
    },
  };
}

export const c4ContainerTemplateCompiler = makeCompiler('container');
export const c4ComponentTemplateCompiler = makeCompiler('component');
export const c4DeploymentTemplateCompiler = makeCompiler('deployment');
