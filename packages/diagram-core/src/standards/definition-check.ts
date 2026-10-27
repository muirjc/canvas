import { FAMILY_KIND_SHAPES, FAMILY_RESERVED_KIND_IDS, FAMILY_SUPPORTS_ELEMENT_KINDS } from '../model/family-capabilities.js';
import { C4_ELEMENT_ROLES, C4_ROLE_SHAPES } from '../dsl/c4.js';
import { classifyNode } from './kinds.js';
import { KIND_ID_PATTERN, RESERVED_KIND_IDS, type StandardRules } from './schema.js';

export interface DefinitionIssue {
  /** Dotted path into the rules object, e.g. "elementKinds[1].id". */
  path: string;
  message: string;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * canvas-tfr: checks that a standard's own definition is coherent for the diagram family it will
 * apply to, before it can be saved. Returns [] when valid. Rejects:
 *  - kind ids not matching KIND_ID_PATTERN, reserved ids (RESERVED_KIND_IDS), duplicate kind ids
 *  - element kinds on a family that doesn't support them (FAMILY_SUPPORTS_ELEMENT_KINDS)
 *  - kind shapes outside FAMILY_KIND_SHAPES[family]; family-reserved ids (FAMILY_RESERVED_KIND_IDS)
 *  - fills/strokes that aren't #rgb or #rrggbb hex
 *  - minCount > maxCount, negative counts
 *  - `match` on a non-C4 family; a C4 `match.role` not in C4_ELEMENT_ROLES
 *  - a C4 kind listing a shape its role can't be drawn as (C4_ROLE_SHAPES) -- canvas-syd
 *  - connector rules whose from/to is neither '*' nor a defined kind id; duplicate connector ids
 *  - container allowedRoles on a family with no container roles is NOT checked (kept permissive)
 */
export function checkStandardDefinition(rules: StandardRules, family: string): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const kinds = rules.elementKinds ?? [];

  if (kinds.length > 0 && !FAMILY_SUPPORTS_ELEMENT_KINDS.has(family)) {
    issues.push({ path: 'elementKinds', message: `Element kinds aren't supported for the "${family}" diagram family.` });
  }

  const familyShapes: readonly string[] = FAMILY_KIND_SHAPES[family] ?? FAMILY_KIND_SHAPES.flowchart;
  const familyReserved = FAMILY_RESERVED_KIND_IDS[family] ?? [];
  const seenKindIds = new Set<string>();
  kinds.forEach((kind, i) => {
    const at = `elementKinds[${i}]`;
    if (!KIND_ID_PATTERN.test(kind.id)) {
      issues.push({ path: `${at}.id`, message: `Kind id "${kind.id}" must start with a lowercase letter and use only lowercase letters, digits and underscores.` });
    } else if ([...RESERVED_KIND_IDS, ...familyReserved].includes(kind.id.toLowerCase())) {
      issues.push({ path: `${at}.id`, message: `Kind id "${kind.id}" is a reserved word.` });
    }
    if (seenKindIds.has(kind.id)) {
      issues.push({ path: `${at}.id`, message: `Duplicate kind id "${kind.id}".` });
    }
    seenKindIds.add(kind.id);

    if (!kind.label?.trim()) issues.push({ path: `${at}.label`, message: 'A kind needs a label.' });

    for (const shape of kind.shapes) {
      if (!familyShapes.includes(shape)) {
        issues.push({ path: `${at}.shapes`, message: `Shape "${shape}" isn't available for ${family} diagrams.` });
      }
    }
    for (const fill of kind.approvedFills) {
      if (!HEX.test(fill)) issues.push({ path: `${at}.approvedFills`, message: `"${fill}" isn't a hex color (#rgb or #rrggbb).` });
    }
    for (const stroke of kind.approvedStrokes ?? []) {
      if (!HEX.test(stroke)) issues.push({ path: `${at}.approvedStrokes`, message: `"${stroke}" isn't a hex color (#rgb or #rrggbb).` });
    }

    if ((kind.minCount ?? 0) < 0 || (kind.maxCount ?? 0) < 0) {
      issues.push({ path: `${at}.minCount`, message: 'Counts cannot be negative.' });
    }
    if (kind.minCount !== undefined && kind.maxCount !== undefined && kind.minCount > kind.maxCount) {
      issues.push({ path: `${at}.minCount`, message: `Minimum count ${kind.minCount} exceeds maximum ${kind.maxCount}.` });
    }

    if (kind.match) {
      if (family !== 'c4') {
        issues.push({ path: `${at}.match`, message: 'Role matching is only used for C4 diagrams.' });
      } else if (!(C4_ELEMENT_ROLES as readonly string[]).includes(kind.match.role)) {
        issues.push({ path: `${at}.match`, message: `"${kind.match.role}" isn't a C4 element role (${C4_ELEMENT_ROLES.join(', ')}).` });
      }
    }

    // canvas-syd: a C4 element's shape follows from its role, so a shape the role can't produce
    // would be lost on save -- and every such element then flagged against this kind.
    const c4Role = family === 'c4' ? (kind.match?.role ?? kind.id) : undefined;
    const roleShapes: readonly string[] | undefined = c4Role ? C4_ROLE_SHAPES[c4Role as keyof typeof C4_ROLE_SHAPES] : undefined;
    if (roleShapes) {
      const unusable = kind.shapes.filter((shape) => !roleShapes.includes(shape));
      if (unusable.length > 0) {
        issues.push({
          path: `${at}.shapes`,
          message: `A C4 ${c4Role} element can't be drawn as ${unusable.map((s) => `"${s}"`).join(' or ')}; ${c4Role} elements use ${roleShapes.join(', ')}.`,
        });
      }
    }
  });

  const seenConnectorIds = new Set<string>();
  (rules.connectorRules ?? []).forEach((rule, i) => {
    const at = `connectorRules[${i}]`;
    if (seenConnectorIds.has(rule.id)) issues.push({ path: `${at}.id`, message: `Duplicate connector rule id "${rule.id}".` });
    seenConnectorIds.add(rule.id);
    for (const side of ['from', 'to'] as const) {
      const ref = rule[side];
      if (ref !== '*' && !seenKindIds.has(ref) && !kinds.some((k) => k.id === ref)) {
        issues.push({ path: `${at}.${side}`, message: `"${ref}" isn't a defined element kind (or "*").` });
      }
    }
    for (const stroke of rule.approvedStrokes ?? []) {
      if (!HEX.test(stroke)) issues.push({ path: `${at}.approvedStrokes`, message: `"${stroke}" isn't a hex color (#rgb or #rrggbb).` });
    }
  });

  return issues;
}

/**
 * canvas-e05: non-blocking notes on a standard's definition, shown beside the errors above but
 * never preventing a save. Today: a C4 kind whose match (role + external) is also satisfied by an
 * EARLIER kind. Since canvas-7hp that's legitimate -- the editor and the AI write the kind's id into
 * the element's $tags -- but an element without that tag (hand-written or imported DSL) is
 * classified as the earlier kind, which the author should know. Names the kind that wins. A kind
 * with `external` unset is checked for both internal and external elements.
 */
export function standardDefinitionNotices(rules: StandardRules, family: string): DefinitionIssue[] {
  if (family !== 'c4') return [];
  const notices: DefinitionIssue[] = [];
  (rules.elementKinds ?? []).forEach((kind, i) => {
    if (!kind.match) return;
    const samples = kind.match.external === undefined ? [false, true] : [kind.match.external];
    const winners = new Set<string>();
    for (const external of samples) {
      const winner = classifyNode({ id: 'sample', label: '', shape: 'rectangle', position: { x: 0, y: 0 }, role: kind.match.role, external }, rules);
      if (winner && winner.id !== kind.id) winners.add(winner.label?.trim() || winner.id);
    }
    if (winners.size === 0) return;
    const names = [...winners].map((w) => `"${w}"`).join(' and ');
    notices.push({
      path: `elementKinds[${i}].match`,
      message: `"${kind.label?.trim() || kind.id}" has the same C4 role as ${names}. Elements drawn in the editor or by the AI are tagged with their kind, so they are told apart; an untagged element in hand-written or imported DSL counts as ${names}.`,
    });
  });
  return notices;
}
