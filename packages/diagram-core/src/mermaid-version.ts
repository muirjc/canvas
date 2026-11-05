/**
 * canvas-7p3y: the Mermaid version Canvas's syntax follows, recorded once.
 *
 * Canvas doesn't run Mermaid: diagram-core has its own parser, serializer and renderer for Mermaid's
 * syntax. So this is the Mermaid release whose grammar the parsers were checked against, not a
 * package version. Changing it is a deliberate step of the upgrade process in
 * docs/admin-guide/operations.md ("Moving to a newer Mermaid version"); a test pins these values.
 */
export const MERMAID_SYNTAX_VERSION = '11.15';

/**
 * The Mermaid version GitHub draws diagrams with (pull requests, READMEs), recorded by hand: put a
 * ```mermaid block containing `info` in any GitHub Markdown preview and it prints the version.
 * Mermaid 12 changed how diagrams are laid out and coloured by default (ELK layout for flowchart,
 * class and ER diagrams), not the syntax.
 */
export const GITHUB_MERMAID_VERSION = { version: '12.2.0', checkedOn: '2026-10-31' } as const;

/** Per diagram family: Mermaid syntax Canvas doesn't read or doesn't draw yet. Checked by a test. */
export interface MermaidSupportNote {
  family: 'flowchart' | 'sequence' | 'uml' | 'erd' | 'c4' | 'architecture' | 'state';
  label: string;
  notes: string[];
}

export const MERMAID_SUPPORT_NOTES: readonly MermaidSupportNote[] = [
  {
    family: 'flowchart',
    label: 'Flowchart',
    notes: [
      'Not read: the newer shape syntax (A@{ shape: … }) and edge ids (A e1@--> B).',
      'Refused on purpose: click … call (runs script); click … href links work.',
    ],
  },
  {
    family: 'sequence',
    label: 'Sequence',
    notes: ['Read but not drawn: participant link menus (link / links); they are kept and exported.'],
  },
  {
    family: 'uml',
    label: 'Class (UML)',
    notes: [],
  },
  {
    family: 'erd',
    label: 'Entity relationship',
    notes: [],
  },
  {
    family: 'c4',
    label: 'C4',
    notes: ['Read but not followed: UpdateLayoutConfig and the Node_L/Node_R alignment hints.'],
  },
  {
    family: 'state',
    label: 'State',
    notes: ['Not read: floating notes (note "text" as N). Read but not kept: hide empty description and scale.'],
  },
  {
    family: 'architecture',
    label: 'Architecture',
    notes: ['Icons from iconify packs (logos:aws-lambda) are kept but drawn as a plain box.'],
  },
];

/** Major version of a version string ('12.2.0' -> 12). */
export function mermaidMajorVersion(version: string): number {
  return Number.parseInt(version, 10);
}
