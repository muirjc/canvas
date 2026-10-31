import { createHash } from 'node:crypto';
import type { Violation } from '@canvas/diagram-core';
import { assertSafeRepoPath } from './folder-path.js';

/**
 * canvas-3s5.1: the files a submission commits, the pull request text and the commit message --
 * pure functions, no I/O. Nothing here depends on the time or on who submits, so submitting the
 * same saved version twice builds the same files (and GitHub reports an unchanged tree).
 *
 *   <path>/README.md          what a reviewer reads first: the SVG, then details
 *   <path>/<slug>.svg         the rendered diagram
 *   <path>/<slug>.mmd         portable Mermaid (Canvas front-matter removed)
 *   <path>/<slug>.canvas.mmd  Canvas's own source, byte for byte
 *   <path>/canvas.json        manifest the CI validator reads
 *   .canvas/standards/<type>/v<version>.json   the standard it was checked against
 *   .canvas/validator.mjs     the validator the repository's CI runs (canvas-3s5.3)
 */
export interface SubmissionStandard {
  id: string;
  version: number;
  name: string | null;
  description: string | null;
  rules: unknown;
}

export interface SubmissionInput {
  diagramId: string;
  name: string;
  description: string | null;
  diagramTypeId: string;
  diagramTypeName: string;
  dslFamily: string;
  dslContent: string;
  portableMermaid: string;
  svg: string;
  versionSequence: number;
  standard: SubmissionStandard | null;
  /** The diagram's folder in the repository, e.g. "architecture/diagrams/order-flow". */
  path: string;
  slug: string;
  canvasUrl: string;
  /** canvas-3s5.3: the CI validator bundle, committed as .canvas/validator.mjs (absent when not built). */
  validator?: string | null;
}

export interface RepoFile {
  path: string;
  content: string;
}

const PR_BODY_LIMIT = 60_000;
const MAX_LISTED_WARNINGS = 50;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What "changes since submitting" compares: the saved source, name and description. */
export function submissionFingerprint(dslContent: string, name: string, description: string | null): string {
  return sha256(JSON.stringify([dslContent, name, description ?? '']));
}

/** Text from Canvas users placed in Markdown: no formatting, links, HTML or @mentions. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_{}[\]()<>#+!|~])/g, '\\$1')
    .replace(/@/g, '@​');
}

/** A single line for a commit message or PR title (no line breaks, bounded). */
export function oneLine(text: string, max = 120): string {
  const line = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A code fence longer than any backtick run inside `content`, so the content can't close it. */
function fenceFor(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

export function standardPath(diagramTypeId: string, version: number): string {
  return assertSafeRepoPath(`.canvas/standards/${diagramTypeId}/v${version}.json`);
}

export function buildManifest(input: SubmissionInput): Record<string, unknown> {
  return {
    schema: 1,
    generatedBy: 'Canvas',
    diagramId: input.diagramId,
    name: input.name,
    diagramType: input.diagramTypeId,
    dslFamily: input.dslFamily,
    versionSequence: input.versionSequence,
    source: `${input.slug}.canvas.mmd`,
    sourceSha256: sha256(input.dslContent),
    portable: `${input.slug}.mmd`,
    svg: `${input.slug}.svg`,
    standard: input.standard
      ? { path: standardPath(input.diagramTypeId, input.standard.version), id: input.standard.id, version: input.standard.version, name: input.standard.name }
      : null,
    canvasUrl: input.canvasUrl,
  };
}

function buildReadme(input: SubmissionInput): string {
  const name = escapeMarkdown(input.name);
  const standard = input.standard ? `${escapeMarkdown(input.standard.name ?? 'Standard')} (version ${input.standard.version})` : 'None';
  const fence = fenceFor(input.portableMermaid);
  const lines = [
    `# ${name}`,
    '',
    `![${name}](./${input.slug}.svg)`,
    '',
    // canvas-n85n: Mermaid has no syntax for positions, so GitHub's own render of the source below
    // is laid out automatically; the picture above is the authoritative one.
    '_Layout as drawn in Canvas._',
    '',
    '| | |',
    '|---|---|',
    `| Diagram type | ${escapeMarkdown(input.diagramTypeName)} |`,
    `| Canvas version | ${input.versionSequence} |`,
    `| Standard | ${standard} |`,
    `| Open in Canvas | [${name}](${input.canvasUrl}) |`,
    '',
  ];
  if (input.description?.trim()) lines.push(escapeMarkdown(input.description.trim()), '');
  lines.push(
    '<details><summary>Mermaid source</summary>',
    '',
    'GitHub arranges this view automatically, so positions differ from Canvas. Colours are kept where Mermaid supports them.',
    '',
    `${fence}mermaid`,
    input.portableMermaid.trimEnd(),
    fence,
    '',
    '</details>',
    '',
    '_Generated by Canvas. Edit this diagram in Canvas, not here: changes made in this repository are not copied back._',
    '',
  );
  return lines.join('\n');
}

export function buildSubmissionFiles(input: SubmissionInput): RepoFile[] {
  const at = (file: string) => assertSafeRepoPath(`${input.path}/${file}`);
  const files: RepoFile[] = [
    { path: at('README.md'), content: buildReadme(input) },
    { path: at(`${input.slug}.svg`), content: input.svg },
    { path: at(`${input.slug}.mmd`), content: input.portableMermaid },
    { path: at(`${input.slug}.canvas.mmd`), content: input.dslContent },
    { path: at('canvas.json'), content: `${JSON.stringify(buildManifest(input), null, 2)}\n` },
  ];
  if (input.standard) {
    const { id, version, name, description, rules } = input.standard;
    files.push({
      path: standardPath(input.diagramTypeId, version),
      content: `${JSON.stringify({ id, diagramTypeId: input.diagramTypeId, version, name, description, rules }, null, 2)}\n`,
    });
  }
  if (input.validator) files.push({ path: assertSafeRepoPath('.canvas/validator.mjs'), content: input.validator });
  return files;
}

export function buildPrTitle(input: Pick<SubmissionInput, 'name' | 'versionSequence'>): string {
  return `Canvas: ${oneLine(input.name, 100)} (version ${input.versionSequence})`;
}

const SEVERITY_LABEL: Record<string, string> = { warning: 'Warning', info: 'Info', error: 'Must fix' };

export function buildPrBody(input: SubmissionInput, warnings: Violation[], submittedBy: string): string {
  const name = escapeMarkdown(input.name);
  const lines = [
    `**${name}** submitted from Canvas for approval by ${escapeMarkdown(submittedBy)}.`,
    '',
    `- Diagram type: ${escapeMarkdown(input.diagramTypeName)}`,
    `- Canvas version: ${input.versionSequence}`,
    `- Standard: ${input.standard ? `${escapeMarkdown(input.standard.name ?? 'Standard')} (version ${input.standard.version})` : 'none'}`,
    `- Open in Canvas: [${name}](${input.canvasUrl})`,
    '',
    `See [README.md](${encodeURI(`${input.path}/README.md`)}) in this pull request for the rendered diagram.`,
    '',
    'Merging this pull request approves this version in Canvas; closing it without merging rejects it.',
    'Further changes are made in Canvas and pushed to this pull request; edits made here are not copied back.',
    '',
  ];
  if (warnings.length > 0) {
    lines.push(`### Standard findings (${warnings.length})`, '');
    for (const w of warnings.slice(0, MAX_LISTED_WARNINGS)) {
      lines.push(`- ${SEVERITY_LABEL[w.severity] ?? w.severity}: ${escapeMarkdown(w.message)}`);
    }
    if (warnings.length > MAX_LISTED_WARNINGS) lines.push(`- …and ${warnings.length - MAX_LISTED_WARNINGS} more (see the Issues tab in Canvas)`);
    lines.push('');
  }
  // The marker identifies the diagram from the pull request alone, so truncation must never cut it.
  const marker = `<!-- canvas:diagram=${input.diagramId} -->`;
  const body = lines.join('\n');
  const room = PR_BODY_LIMIT - marker.length - 20;
  return body.length > room ? `${body.slice(0, room)}\n\n…(truncated)\n\n${marker}` : `${body}\n${marker}`;
}

/** The commit message, crediting the Canvas user with a Co-authored-by trailer. */
export function buildCommitMessage(input: Pick<SubmissionInput, 'name' | 'versionSequence' | 'canvasUrl'>, author: { name: string; email: string }, update: boolean): string {
  const coAuthorName = oneLine(author.name.replace(/[<>]/g, ''), 100) || author.email;
  const email = author.email.replace(/[<>\s]/g, '');
  return [
    `${update ? 'Update' : 'Submit'} "${oneLine(input.name, 80)}" (version ${input.versionSequence}) from Canvas`,
    '',
    `Canvas: ${input.canvasUrl}`,
    '',
    `Co-authored-by: ${coAuthorName} <${email}>`,
    '',
  ].join('\n');
}
