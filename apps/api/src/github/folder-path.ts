/**
 * canvas-3s5.1: the folder an admin links a project to, and the per-diagram paths Canvas writes
 * under it. Strict on purpose: every path Canvas commits passes through `assertSafeRepoPath`, so a
 * folder, a diagram name or a type id can never reach `.git`, `.github` (workflows) or another
 * diagram's files.
 */
export class InvalidRepoPathError extends Error {}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PATH_LENGTH = 200;
const MAX_DEPTH = 10;
/** Folders Canvas never writes into (it writes `.canvas/` itself, but never under a linked folder). */
const RESERVED = new Set(['.git', '.github', '.canvas', '.gitmodules', '.gitattributes', '.gitignore']);

function checkSegments(path: string, what: string): void {
  const segments = path.split('/');
  if (segments.length > MAX_DEPTH) throw new InvalidRepoPathError(`${what} is nested too deeply (at most ${MAX_DEPTH} levels).`);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new InvalidRepoPathError(`${what} has an empty, "." or ".." part.`);
    if (RESERVED.has(segment.toLowerCase())) throw new InvalidRepoPathError(`${what} can't use "${segment}".`);
    if (!SEGMENT.test(segment)) {
      throw new InvalidRepoPathError(`${what} may use letters, numbers, ".", "_" and "-" only, and each part must start with a letter or number ("${segment}").`);
    }
  }
}

/** Normalises an admin-entered folder ("/architecture/diagrams/" -> "architecture/diagrams").
 *  The repository root is not allowed: diagrams always live under a folder. */
export function normalizeFolder(input: string): string {
  const folder = input.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (folder === '') throw new InvalidRepoPathError('Choose a folder in the repository (for example "architecture/diagrams").');
  if (folder.length > MAX_PATH_LENGTH) throw new InvalidRepoPathError(`The folder is too long (at most ${MAX_PATH_LENGTH} characters).`);
  checkSegments(folder, 'The folder');
  return folder;
}

/** A diagram's folder name: kebab-case from its name, at most 60 characters. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'diagram';
}

/** Re-checks a full path Canvas is about to write (a file inside a diagram folder, or a standard). */
export function assertSafeRepoPath(path: string): string {
  if (path.length > MAX_PATH_LENGTH + 120) throw new InvalidRepoPathError('The file path is too long.');
  // `.canvas/standards/...` is Canvas's own folder; everything else follows the folder rules.
  const checked = path.startsWith('.canvas/') ? path.slice('.canvas/'.length) : path;
  checkSegments(checked, 'The file path');
  return path;
}
