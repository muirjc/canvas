import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { emptyStandardRules, findElementLine, getDslFamily, renderToSvg, validate, type StandardRules, type Violation } from './diagram-core.js';

/**
 * canvas-3s5.3: checks every diagram Canvas committed to a repository. A diagram folder is found by
 * its `canvas.json` manifest (written by Canvas on every submission); for each one the validator
 * parses the Canvas source (`<slug>.canvas.mmd`), checks it against the standard JSON the manifest
 * names (committed alongside, under `.canvas/standards/`), and optionally renders it to SVG.
 *
 * Errors (fail the check): an unreadable manifest, a missing source or standard file, a diagram that
 * doesn't parse, and any Must fix finding. Warnings: standard warnings, a source edited outside
 * Canvas (its hash no longer matches the manifest), a missing companion file.
 */
export type Level = 'error' | 'warning' | 'notice';

export interface Finding {
  level: Level;
  /** Repository-relative path, forward slashes. */
  file: string;
  line?: number;
  title: string;
  message: string;
}

export interface DiagramResult {
  manifest: string;
  name: string;
  diagramType: string | null;
  standard: string | null;
  findings: Finding[];
  rendered?: string;
}

export interface ValidationReport {
  diagrams: DiagramResult[];
  errorCount: number;
  warningCount: number;
}

export interface ValidateOptions {
  /** Repository root (default: the working directory). */
  root: string;
  /** Folders or manifests to check, relative to root (default: the whole repository). */
  paths?: string[];
  /** Write each diagram's SVG here, mirroring its folder (default: don't render). */
  renderDir?: string;
}

interface Manifest {
  schema?: number;
  diagramId?: string;
  name?: string;
  diagramType?: string;
  dslFamily?: string;
  versionSequence?: number;
  source?: string;
  sourceSha256?: string;
  portable?: string;
  svg?: string;
  standard?: { path?: string; id?: string; version?: number; name?: string | null } | null;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);
const SEVERITY_LEVEL: Record<string, Level> = { error: 'error', warning: 'warning', info: 'notice' };
const SEVERITY_TITLE: Record<string, string> = { error: 'Must fix', warning: 'Warning', info: 'Info' };

/** Not a secret, but a constant-time comparison costs nothing here. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Every canvas.json under `dir`, skipping node_modules, .git and other dot-folders. */
export function findManifests(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(join(current, entry.name));
      } else if (entry.isFile() && entry.name === 'canvas.json') {
        found.push(join(current, entry.name));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/** A path from the manifest, kept inside the repository. */
function insideRoot(root: string, path: string): string | null {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith('..') || rel === '' || resolve(rel) === rel) return null;
  return full;
}

function checkDiagram(root: string, manifestPath: string, renderDir: string | undefined): DiagramResult {
  const manifestRel = toPosix(relative(root, manifestPath));
  const folder = dirname(manifestPath);
  const result: DiagramResult = { manifest: manifestRel, name: manifestRel, diagramType: null, standard: null, findings: [] };
  const add = (finding: Finding) => result.findings.push(finding);

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (error) {
    add({ level: 'error', file: manifestRel, title: 'Unreadable manifest', message: `canvas.json is not valid JSON (${error instanceof Error ? error.message : String(error)}).` });
    return result;
  }
  result.name = manifest.name ?? manifestRel;
  result.diagramType = manifest.diagramType ?? null;
  if (manifest.schema !== 1 || !manifest.source || !manifest.dslFamily) {
    add({ level: 'error', file: manifestRel, title: 'Unsupported manifest', message: 'canvas.json is missing "source" or "dslFamily", or has an unknown "schema" (this validator understands schema 1).' });
    return result;
  }

  const sourcePath = insideRoot(folder, manifest.source);
  if (!sourcePath || !existsSync(sourcePath)) {
    add({ level: 'error', file: manifestRel, title: 'Missing source', message: `The diagram source "${manifest.source}" named in canvas.json is missing.` });
    return result;
  }
  const sourceRel = toPosix(relative(root, sourcePath));
  const dsl = readFileSync(sourcePath, 'utf8');
  if (manifest.sourceSha256 && !sameHash(createHash('sha256').update(dsl, 'utf8').digest('hex'), manifest.sourceSha256)) {
    add({
      level: 'warning',
      file: sourceRel,
      title: 'Edited outside Canvas',
      message: 'This file differs from what Canvas submitted. Changes made in the repository are not copied back to Canvas, and the next submission replaces them.',
    });
  }
  for (const companion of [manifest.portable, manifest.svg]) {
    if (!companion) continue;
    const path = insideRoot(folder, companion);
    if (!path || !existsSync(path)) add({ level: 'warning', file: manifestRel, title: 'Missing file', message: `"${companion}" named in canvas.json is missing.` });
  }

  const family = getDslFamily(manifest.dslFamily);
  if (!family) {
    add({ level: 'error', file: manifestRel, title: 'Unknown diagram family', message: `This validator doesn't know the diagram family "${manifest.dslFamily}"; Canvas may be newer than the committed .canvas/validator.mjs.` });
    return result;
  }
  const parsed = family.parse(dsl);
  if ('errors' in parsed) {
    for (const error of parsed.errors) add({ level: 'error', file: sourceRel, line: error.line || undefined, title: 'Syntax error', message: error.message });
    return result;
  }

  if (manifest.standard?.path) {
    const standardPath = insideRoot(root, manifest.standard.path);
    const standardRel = manifest.standard.path;
    result.standard = `${manifest.standard.name ?? 'Standard'} (version ${manifest.standard.version ?? '?'})`;
    if (!standardPath || !existsSync(standardPath)) {
      add({ level: 'error', file: manifestRel, title: 'Missing standard', message: `The standard "${standardRel}" named in canvas.json is missing.` });
    } else {
      let rules: StandardRules | undefined;
      try {
        rules = (JSON.parse(readFileSync(standardPath, 'utf8')) as { rules?: StandardRules }).rules;
      } catch {
        rules = undefined;
      }
      if (!rules) {
        add({ level: 'error', file: standardRel, title: 'Unreadable standard', message: 'The standard file is not valid JSON or has no "rules".' });
      } else {
        // Canvas writes every field; a hand-edited file may not have them all.
        let violations: Violation[] = [];
        try {
          violations = validate(parsed.model, { ...emptyStandardRules(), ...rules });
        } catch (error) {
          add({ level: 'error', file: standardRel, title: 'Unusable standard', message: `The standard could not be applied (${error instanceof Error ? error.message : String(error)}).` });
        }
        for (const violation of violations) {
          const line = violation.elementId === 'diagram' || violation.elementId === '(diagram)' ? undefined : findElementLine(dsl, violation.elementId, parsed.model);
          add({
            level: SEVERITY_LEVEL[violation.severity] ?? 'warning',
            file: sourceRel,
            line,
            title: SEVERITY_TITLE[violation.severity] ?? 'Standard',
            message: violation.message,
          });
        }
      }
    }
  }

  if (renderDir) {
    const svgName = (manifest.svg ?? `${manifest.source.replace(/\.canvas\.mmd$|\.mmd$/, '')}.svg`).split('/').pop()!;
    const out = join(renderDir, relative(root, folder), svgName);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderToSvg(parsed.model));
    result.rendered = toPosix(relative(process.cwd(), out));
  }
  return result;
}

export function validateRepository(options: ValidateOptions): ValidationReport {
  const root = resolve(options.root);
  const targets = options.paths && options.paths.length > 0 ? options.paths : ['.'];
  const manifests = new Set<string>();
  for (const target of targets) {
    const full = resolve(root, target);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) for (const m of findManifests(full)) manifests.add(m);
    else if (full.endsWith('canvas.json')) manifests.add(full);
  }
  const diagrams = [...manifests].sort().map((m) => checkDiagram(root, m, options.renderDir ? resolve(options.renderDir) : undefined));
  const all = diagrams.flatMap((d) => d.findings);
  return { diagrams, errorCount: all.filter((f) => f.level === 'error').length, warningCount: all.filter((f) => f.level === 'warning').length };
}
