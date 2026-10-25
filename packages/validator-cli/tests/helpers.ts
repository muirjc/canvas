import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
export const BUNDLE = join(PKG_DIR, 'dist', 'validator.mjs');

export const SAMPLES: Record<string, string> = {
  flowchart: 'flowchart TD\n  A[Receive] --> B[Ship]\n',
  c4: 'C4Context\n  Person(user, "User")\n  System(sys, "System")\n  Rel(user, sys, "Uses")\n',
  architecture: 'architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service srv(server)[Server] in api\n  db:L -- R:srv\n',
  sequence: 'sequenceDiagram\n  participant A\n  participant B\n  A->>B: Hello\n',
  erd: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n',
  uml: 'classDiagram\n  Animal <|-- Dog\n',
};

export const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function tempDir(prefix = 'canvas-validator-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export interface DiagramFixture {
  folder?: string;
  slug?: string;
  name?: string;
  family?: string;
  dsl?: string;
  /** null = no standard. */
  rules?: Record<string, unknown> | null;
  manifest?: Record<string, unknown>;
  hash?: string;
  companions?: boolean;
}

/** Writes a diagram folder the way Canvas does and returns its manifest path (repo-relative). */
export function writeDiagram(root: string, f: DiagramFixture = {}): string {
  const folder = f.folder ?? 'architecture/order-flow';
  const slug = f.slug ?? 'order-flow';
  const family = f.family ?? 'flowchart';
  const dsl = f.dsl ?? SAMPLES[family];
  const standardPath = '.canvas/standards/flowchart/v1.json';
  write(root, `${folder}/${slug}.canvas.mmd`, dsl);
  if (f.companions !== false) {
    write(root, `${folder}/${slug}.mmd`, dsl);
    write(root, `${folder}/${slug}.svg`, '<svg/>');
  }
  if (f.rules) write(root, standardPath, JSON.stringify({ id: 's1', version: 1, name: 'Rules', rules: f.rules }));
  const manifest = {
    schema: 1,
    name: f.name ?? 'Order Flow',
    diagramType: family,
    dslFamily: family,
    source: `${slug}.canvas.mmd`,
    sourceSha256: f.hash ?? sha(dsl),
    portable: `${slug}.mmd`,
    svg: `${slug}.svg`,
    standard: f.rules ? { path: standardPath, id: 's1', version: 1, name: 'Rules' } : null,
    ...f.manifest,
  };
  write(root, `${folder}/canvas.json`, JSON.stringify(manifest, null, 2));
  return `${folder}/canvas.json`;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runBundle(args: string[], opts: { cwd?: string; env?: Record<string, string>; bundle?: string } = {}): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...opts.env };
  return new Promise((resolve) => {
    execFile(process.execPath, [opts.bundle ?? BUNDLE, ...args], { cwd: opts.cwd, env }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Must fix: at least 2 "step" nodes required. */
export const MIN_STEPS_RULES = {
  requireKnownKinds: true,
  elementKinds: [{ id: 'step', label: 'Step', shapes: ['rectangle'], approvedFills: [], minCount: 2 }],
  severityOverrides: { 'kind-min-count': 'error' },
};
