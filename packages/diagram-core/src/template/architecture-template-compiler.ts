import type { ParseError } from '../dsl/types.js';
import { awsIconsManifest } from '../libraries/aws-icons.js';
import { azureIconsManifest } from '../libraries/azure-icons.js';
import { MERMAID_ARCHITECTURE_ICON_IDS, mermaidArchitectureIconsManifest } from '../libraries/mermaid-architecture-icons.js';
import { extractFirstTable, splitIntoSections } from './markdown-table.js';
import { AliasAllocator, cell, err, findSection, pickOption, readMetadataFields, readYesNo } from './template-helpers.js';
import type { TemplateCompiler, TemplateCompileResult } from './types.js';

/**
 * canvas-73s.4: compiles a filled-in copy of docs/architecture-template.md into Mermaid
 * `architecture-beta` DSL, for the network / deployment / cloud-infrastructure diagram types (all
 * the architecture family), following that document's mapping reference.
 *
 * Icons: Mermaid's five built-ins and iconify `prefix:name` go straight into the DSL. Canvas's own
 * libraries (`aws:<id>`, `azure:<id>`) can only be referenced through Canvas's `canvas.icons`
 * front matter, so when any is used the compiler writes that block -- and then lists EVERY
 * service's and group's icon there, because architecture.ts reads a front-matter-carrying file as
 * app-saved, where a group's `(cloud)` token without an icons entry means "no icon".
 */

const SIDES: Record<string, string> = { left: 'L', l: 'L', right: 'R', r: 'R', top: 'T', t: 'T', bottom: 'B', b: 'B' };
const LIBRARY_PREFIXES: Record<string, { id: string; version: string; ids?: Set<string> }> = {
  aws: { id: awsIconsManifest.id, version: awsIconsManifest.version },
  // Azure's manifest is the real, bundled icon set, so ids can be checked. AWS's bundled manifest
  // is a placeholder; a deployment may serve the real set (vendor-icons), so its ids aren't checked.
  azure: { id: azureIconsManifest.id, version: azureIconsManifest.version, ids: new Set(azureIconsManifest.icons.map((i) => i.id)) },
};

interface Icon {
  /** What goes between the parentheses in the DSL. */
  token: string;
  /** The front-matter icon ref, when one can be expressed (built-ins and Canvas libraries). */
  ref?: { libraryId: string; libraryVersion: string; iconId: string };
  /** True for an aws:/azure: icon, which needs the front matter. */
  library: boolean;
}

interface Group {
  id: string;
  name: string;
  icon: Icon;
  parentName: string;
  parentId?: string;
}

function resolveIcon(raw: string, fallback: string, where: string, errors: ParseError[]): Icon | undefined {
  const value = raw.trim() || fallback;
  const builtIn = pickOption(value, MERMAID_ARCHITECTURE_ICON_IDS);
  if (builtIn) {
    return { token: builtIn, ref: { libraryId: mermaidArchitectureIconsManifest.id, libraryVersion: mermaidArchitectureIconsManifest.version, iconId: builtIn }, library: false };
  }
  const prefixed = value.match(/^([a-z0-9-]+):([a-z0-9-]+)$/i);
  if (!prefixed) {
    errors.push(err(`${where}: unrecognized Icon "${raw}" (expected ${MERMAID_ARCHITECTURE_ICON_IDS.join(', ')}, aws:<icon>, azure:<icon> or an iconify prefix:name).`));
    return undefined;
  }
  const [, prefix, iconId] = prefixed;
  const library = LIBRARY_PREFIXES[prefix.toLowerCase()];
  if (!library) return { token: value, library: false };
  if (library.ids && !library.ids.has(iconId)) {
    errors.push(err(`${where}: "${iconId}" is not an icon in Canvas's ${prefix} library.`));
    return undefined;
  }
  return { token: iconId, ref: { libraryId: library.id, libraryVersion: library.version, iconId }, library: true };
}

/** Square brackets end a Mermaid architecture label, so they're dropped from names. */
const label = (name: string) => name.replace(/[[\]]/g, '');

export const architectureTemplateCompiler: TemplateCompiler = {
  compile(markdownText: string): TemplateCompileResult {
    const errors: ParseError[] = [];
    const sections = splitIntoSections(markdownText);
    const metadataSection = findSection(sections, 'diagram metadata');
    const groupsSection = findSection(sections, 'groups');
    const servicesSection = findSection(sections, 'services');
    const junctionsSection = findSection(sections, 'junctions');
    const connectionsSection = findSection(sections, 'connections');

    if (!servicesSection) errors.push(err('Missing required section "3. Services".'));
    if (!connectionsSection) errors.push(err('Missing required section "5. Connections".'));
    if (errors.length > 0) return { errors };

    const title = metadataSection ? (readMetadataFields(metadataSection).get('Diagram title') ?? '') : '';
    // Groups, services and junctions share one id namespace in Mermaid.
    const ids = new AliasAllocator();
    const nameTaken = new Set<string>();
    const claim = (name: string, where: string): boolean => {
      if (nameTaken.has(name)) {
        errors.push(err(`${where}: the name "${name}" is already used by another group, service or junction.`));
        return false;
      }
      nameTaken.add(name);
      return true;
    };

    // --- Section 2: groups --------------------------------------------------------------------
    const groups: Group[] = [];
    const groupByName = new Map<string, Group>();
    if (groupsSection) {
      for (const row of extractFirstTable(groupsSection.body)) {
        const name = cell(row, 'Group');
        if (!name) continue;
        const where = `Section 2, group "${name}"`;
        const icon = resolveIcon(cell(row, 'Icon'), 'cloud', where, errors);
        if (!icon || !claim(name, where)) continue;
        const group: Group = { id: ids.allocate(name), name, icon, parentName: cell(row, 'Inside group') };
        groups.push(group);
        groupByName.set(name, group);
      }
    }
    const groupId = (name: string, where: string): string | undefined => {
      if (!name) return undefined;
      const group = groupByName.get(name);
      if (!group) errors.push(err(`${where}: group "${name}" is not listed in Section 2 (Groups).`));
      return group?.id;
    };
    for (const group of groups) group.parentId = groupId(group.parentName, `Section 2, group "${group.name}"`);
    // Parents before children; a cycle can't be ordered.
    const orderedGroups: Group[] = [];
    const visiting = new Set<Group>();
    const visit = (group: Group): void => {
      if (orderedGroups.includes(group)) return;
      if (visiting.has(group)) {
        errors.push(err(`Section 2: groups "${group.name}" and "${group.parentName}" are inside each other.`));
        return;
      }
      visiting.add(group);
      const parent = group.parentName ? groupByName.get(group.parentName) : undefined;
      if (parent) visit(parent);
      visiting.delete(group);
      if (!orderedGroups.includes(group)) orderedGroups.push(group);
    };
    groups.forEach(visit);

    // --- Section 3: services ------------------------------------------------------------------
    const endpointId = new Map<string, string>();
    const serviceLines: string[] = [];
    const icons = new Map<string, Icon>();
    for (const group of groups) icons.set(group.id, group.icon);
    for (const row of extractFirstTable(servicesSection!.body)) {
      const name = cell(row, 'Service');
      if (!name) continue;
      const where = `Section 3, service "${name}"`;
      const icon = resolveIcon(cell(row, 'Icon'), 'server', where, errors);
      if (!icon || !claim(name, where)) continue;
      const parent = cell(row, 'Group');
      const parentId = groupId(parent, where);
      if (parent && !parentId) continue;
      const id = ids.allocate(name);
      endpointId.set(name, id);
      icons.set(id, icon);
      serviceLines.push(`service ${id}(${icon.token})[${label(name)}]${parentId ? ` in ${parentId}` : ''}`);
    }
    if (serviceLines.length === 0 && errors.length === 0) errors.push(err('Section 3: list at least one service.'));

    // --- Section 4: junctions -----------------------------------------------------------------
    const junctionLines: string[] = [];
    if (junctionsSection) {
      for (const row of extractFirstTable(junctionsSection.body)) {
        const name = cell(row, 'Junction');
        if (!name) continue;
        const where = `Section 4, junction "${name}"`;
        if (!claim(name, where)) continue;
        const parent = cell(row, 'Group');
        const parentId = groupId(parent, where);
        if (parent && !parentId) continue;
        const id = ids.allocate(name);
        endpointId.set(name, id);
        junctionLines.push(`junction ${id}${parentId ? ` in ${parentId}` : ''}`);
      }
    }

    // --- Section 5: connections ---------------------------------------------------------------
    const edgeLines: string[] = [];
    for (const row of extractFirstTable(connectionsSection!.body)) {
      const from = cell(row, 'From');
      const to = cell(row, 'To');
      if (!from && !to) continue;
      const where = `Section 5, "${from}" -> "${to}"`;
      const fromId = endpointId.get(from);
      const toId = endpointId.get(to);
      if (!fromId || !toId) {
        const missing = !fromId ? from : to;
        errors.push(
          err(groupByName.has(missing) ? `${where}: "${missing}" is a group -- connect a service or junction inside it instead.` : `${where}: "${missing}" is not listed in Section 3 or 4.`),
        );
        continue;
      }
      const fromSide = SIDES[(cell(row, 'From side') || 'Right').toLowerCase()];
      const toSide = SIDES[(cell(row, 'To side') || 'Left').toLowerCase()];
      const arrow = readYesNo(cell(row, 'Arrow'), true);
      if (!fromSide || !toSide || arrow === undefined) {
        errors.push(err(`${where}: sides must be Left, Right, Top or Bottom, and Arrow Yes or No.`));
        continue;
      }
      edgeLines.push(`${fromId}:${fromSide} ${arrow ? '-->' : '--'} ${toSide}:${toId}`);
    }

    if (errors.length > 0) return { errors };

    // --- Assembly ------------------------------------------------------------------------------
    const lines: string[] = [];
    if ([...icons.values()].some((icon) => icon.library)) {
      lines.push('---', 'canvas:', '  icons:');
      for (const [id, icon] of icons) {
        if (!icon.ref) continue;
        lines.push(`    ${id}:`, `      libraryId: ${icon.ref.libraryId}`, `      libraryVersion: "${icon.ref.libraryVersion}"`, `      iconId: ${icon.ref.iconId}`);
      }
      lines.push('---');
    }
    lines.push('architecture-beta');
    if (title) lines.push(`    title ${title}`);
    for (const group of orderedGroups) {
      lines.push(`    group ${group.id}(${group.icon.token})[${label(group.name)}]${group.parentId ? ` in ${group.parentId}` : ''}`);
    }
    for (const line of [...serviceLines, ...junctionLines]) lines.push(`    ${line}`);
    if (edgeLines.length > 0) lines.push('');
    for (const line of edgeLines) lines.push(`    ${line}`);
    return { dsl: lines.join('\n') + '\n' };
  },
};
