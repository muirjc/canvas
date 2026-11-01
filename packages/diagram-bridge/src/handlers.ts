import {
  checkStandardDefinition,
  detectDslFamily,
  getDslFamily,
  isParseSuccess,
  renderToSvg,
  toPortableMermaid,
  updateEmbeds,
  validate,
  type DiagramModel,
  type EmbedSource,
  type StandardRules,
} from './diagram-core.js';

/**
 * canvas-1bty.4: each operation the Python service needs from diagram-core, as JSON in -> JSON out.
 * Pure: no state between calls, no file or network access.
 */

export class BadRequest extends Error {}

type Body = Record<string, unknown>;

function str(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new BadRequest(`"${key}" must be a string`);
  return value;
}

function obj<T>(body: Body, key: string): T {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequest(`"${key}" must be an object`);
  return value as T;
}

function family(body: Body) {
  const id = str(body, 'family');
  const found = getDslFamily(id);
  if (!found) throw new BadRequest(`unknown family "${id}"`);
  return { id, found };
}

export const handlers: Record<string, (body: Body) => unknown> = {
  /** { dsl } -> { family: string | null } */
  detect: (body) => ({ family: detectDslFamily(str(body, 'dsl')) ?? null }),

  /** { family, dsl } -> { model } | { errors } (the parser's own result) */
  parse: (body) => family(body).found.parse(str(body, 'dsl')),

  /** { family, model } -> { dsl } */
  serialize: (body) => ({ dsl: family(body).found.serialize(obj<DiagramModel>(body, 'model')) }),

  /** { dsl, family? } -> { family, model } | { family, errors }: detect + parse in one call. */
  'detect-and-parse': (body) => {
    const dsl = str(body, 'dsl');
    const id = typeof body.family === 'string' ? body.family : detectDslFamily(dsl);
    const found = id ? getDslFamily(id) : undefined;
    if (!id || !found) return { family: id ?? null, errors: [{ message: 'Unrecognized diagram header' }] };
    const result = found.parse(dsl);
    return isParseSuccess(result) ? { family: id, model: result.model } : { family: id, errors: result.errors };
  },

  /** { model, rules } -> { violations } */
  validate: (body) => ({ violations: validate(obj<DiagramModel>(body, 'model'), obj<StandardRules>(body, 'rules')) }),

  /** { rules, family } -> { issues } */
  'check-standard': (body) => ({ issues: checkStandardDefinition(obj<StandardRules>(body, 'rules'), str(body, 'family')) }),

  /**
   * { model, icons?, standardRules?, background? } -> { svg }. `icons` maps
   * "<libraryId>@<libraryVersion>@<iconId>" to icon markup (the caller resolves it from its database).
   */
  'render-svg': (body) => {
    const icons = (body.icons ?? {}) as Record<string, string>;
    const svg = renderToSvg(obj<DiagramModel>(body, 'model'), (icon) => icons[`${icon.libraryId}@${icon.libraryVersion}@${icon.iconId}`], {
      standardRules: body.standardRules as StandardRules | undefined,
      background: typeof body.background === 'string' ? body.background : undefined,
    });
    return { svg };
  },

  /** { dsl, stripFrontMatter? } -> { dsl } */
  portable: (body) => ({ dsl: toPortableMermaid(str(body, 'dsl'), { stripFrontMatter: body.stripFrontMatter === true }) }),

  /** { markdown, docPath, sources: { path: EmbedSource }, only?: string[] } -> EmbedUpdate */
  embeds: (body) => {
    const sources = obj<Record<string, EmbedSource>>(body, 'sources');
    const only = Array.isArray(body.only) ? new Set(body.only as string[]) : undefined;
    return updateEmbeds(str(body, 'markdown'), str(body, 'docPath'), (path) => sources[path], only);
  },
};
