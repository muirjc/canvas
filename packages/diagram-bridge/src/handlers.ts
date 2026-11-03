import {
  checkStandardDefinition,
  createEmptyDiagramModel,
  getTemplateCompiler,
  detectDslFamily,
  getDslFamily,
  isParseSuccess,
  loadLibrary,
  prepareUploadedSvg,
  renderToSvg,
  sanitizeIconMarkupStrict,
  SvgImportError,
  toPortableMermaid,
  updateEmbeds,
  validate,
  type DiagramModel,
  type EmbedSource,
  type IconShapeLibraryManifest,
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

function list(body: Body, key: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new BadRequest(`"${key}" must be an array`);
  return value;
}

/** One SVG clean-up per item: an SvgImportError is that item's answer, anything else a bug (500). */
function svgBatch(body: Body, clean: (svg: string, idPrefix: string) => string) {
  return {
    results: list(body, 'items').map((item) => {
      const { svg, idPrefix } = (item ?? {}) as { svg?: unknown; idPrefix?: unknown };
      if (typeof svg !== 'string' || typeof idPrefix !== 'string') throw new BadRequest('each item needs "svg" and "idPrefix" strings');
      try {
        return { ok: true, assetRef: clean(svg, idPrefix) };
      } catch (error) {
        if (error instanceof SvgImportError) return { ok: false, error: error.message };
        throw error;
      }
    }),
  };
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

  /** canvas-1bty.8: { family, diagramTypeId } -> { dsl }: a new diagram's starting DSL (an empty model). */
  'empty-dsl': (body) => ({ dsl: family(body).found.serialize(createEmptyDiagramModel(str(body, 'diagramTypeId'))) }),

  /**
   * canvas-1bty.8: { diagramTypeId, template } -> { dsl } | { errors } | { unsupported: true }:
   * a filled-in intake template compiled to DSL.
   */
  'compile-template': (body) => {
    const compiler = getTemplateCompiler(str(body, 'diagramTypeId'));
    if (!compiler) return { unsupported: true };
    const result = compiler.compile(str(body, 'template'));
    return 'errors' in result ? { errors: result.errors } : { dsl: result.dsl };
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

  // canvas-1bty.14: the library admin (apps/api-py canvas_api/routes/library_admin.py).
  /** { items: [{ svg, idPrefix }] } -> { results: [{ ok: true, assetRef } | { ok: false, error }] }: uploaded files. */
  'svg-prepare': (body) => svgBatch(body, prepareUploadedSvg),

  /** Same shape: a custom manifest's artwork, already in the 48x48 icon space. */
  'svg-sanitize-strict': (body) => svgBatch(body, sanitizeIconMarkupStrict),

  /** { manifest } -> { ok: true, library } | { ok: false, error }: validated and normalized (loadLibrary). */
  'load-library': (body) => {
    try {
      return { ok: true, library: loadLibrary(obj<IconShapeLibraryManifest>(body, 'manifest')) };
    } catch (error) {
      if (error instanceof BadRequest) throw error;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** { diagrams: [{ family, dsl }] } -> { refs: [IconRef[] | null] }: each diagram's icon references (nodes, then
   *  containers); null when it doesn't parse or its family is unknown. */
  'icon-refs': (body) => ({
    refs: list(body, 'diagrams').map((item) => {
      const { family: id, dsl } = (item ?? {}) as { family?: unknown; dsl?: unknown };
      if (typeof id !== 'string' || typeof dsl !== 'string') throw new BadRequest('each diagram needs "family" and "dsl" strings');
      const parsed = getDslFamily(id)?.parse(dsl);
      if (!parsed || !isParseSuccess(parsed)) return null;
      return [...parsed.model.nodes, ...parsed.model.containers].flatMap((e) => (e.icon ? [e.icon] : []));
    }),
  }),
};
