import { appendFileSync } from 'node:fs';
import { formatGitHub, formatSummary, formatText } from './report.js';
import { validateRepository } from './validate-repo.js';

declare const __VALIDATOR_VERSION__: string;
const VERSION = typeof __VALIDATOR_VERSION__ === 'string' ? __VALIDATOR_VERSION__ : 'dev';

const USAGE = `Canvas diagram validator ${VERSION}

Checks the diagrams Canvas submitted to this repository: each folder with a canvas.json is parsed
and checked against the standard it names. Exits 1 if any diagram has a syntax error or a Must fix
finding.

Usage: node .canvas/validator.mjs [options] [paths...]

  paths                 folders or canvas.json files to check (default: the whole repository)
  --root <dir>          repository root (default: the current directory)
  --format text|github  github = annotations on the pull request (default: github when
                        GITHUB_ACTIONS is set, otherwise text)
  --render-dir <dir>    also render each diagram to SVG under <dir>
  --version             print the version
  --help                show this help
`;

export interface CliResult {
  exitCode: number;
  stdout: string;
}

export function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliResult {
  const paths: string[] = [];
  let root = '.';
  let format: 'text' | 'github' = env.GITHUB_ACTIONS === 'true' ? 'github' : 'text';
  let renderDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
    };
    if (arg === '--help' || arg === '-h') return { exitCode: 0, stdout: USAGE };
    if (arg === '--version') return { exitCode: 0, stdout: `${VERSION}\n` };
    if (arg === '--root') root = value();
    else if (arg === '--render-dir') renderDir = value();
    else if (arg === '--format') {
      const f = value();
      if (f !== 'text' && f !== 'github') throw new UsageError(`--format must be text or github (got: ${f})`);
      format = f;
    } else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else paths.push(arg);
  }

  const report = validateRepository({ root, paths, renderDir });
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, formatSummary(report));
    } catch {
      // The summary is a nicety; the annotations and exit code are what matter.
    }
  }
  return { exitCode: report.errorCount > 0 ? 1 : 0, stdout: format === 'github' ? formatGitHub(report) : formatText(report) };
}

export class UsageError extends Error {}

export function main(): void {
  try {
    const { exitCode, stdout } = runCli(process.argv.slice(2));
    process.stdout.write(stdout);
    process.exitCode = exitCode;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`Canvas validator failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 2;
  }
}
