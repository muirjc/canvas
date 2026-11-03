/**
 * canvas-3dq: turning an admin-uploaded SVG into an icon. Icon artwork is an SVG fragment drawn in
 * a 48x48 coordinate space (svg-renderer.ts scales it by iconSize/48), and it ends up inline in
 * exported SVG files -- so uploaded markup gets a strict allowlist clean-up (stricter than
 * svg-sanitizer.ts's, which only guards the bundled vendor packs) and the file's own viewBox is
 * fitted into the 48x48 box with a uniform scale, never stretched (vendor icon terms forbid
 * distortion, and it looks wrong anyway).
 *
 * canvas-1bty.19 hardened it (an appsec review of the Python port): linear-time scanning (the old tag pattern
 * backtracked exponentially), no external resources through entities, CSS escapes or image-set(), balanced
 * output (an icon can't close the elements it's drawn inside), no namespace aliasing, and well-formed XML.
 * apps/api-py/.../diagram_core/svg_import.py is the same code in Python and must stay identical (parity-fuzzed).
 */
export class SvgImportError extends Error {}

/** Per file or manifest icon. The bundled vendor icons are 1-30 KB; a 200 KB icon is almost certainly a photo trace. */
export const MAX_SVG_BYTES = 200 * 1024;

/** Deeper nesting than this is refused: XML parsers (resvg, browsers) give up on very deep documents. */
export const MAX_ICON_DEPTH = 100;
/** More `<use>` elements than this are refused: chained ones multiply (a "billion laughs" made of elements). */
export const MAX_ICON_USES = 16;
/** Characters XML 1.0 doesn't allow (control characters, U+FFFE/U+FFFF, unpaired surrogates): one would make the
 *  whole exported diagram unreadable, so they're removed. */
const NOT_XML_CHAR = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\uD800-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const ALLOWED = new Set(
  [
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'lineargradient',
    'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'symbol', 'use', 'title', 'desc', 'text', 'tspan',
  ],
);

/** CSS properties a `style` attribute may set: presentation only. */
const STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'stop-color', 'stop-opacity', 'clip-path',
  'clip-rule', 'mask', 'color', 'display', 'visibility', 'isolation', 'mix-blend-mode', 'font-family', 'font-size',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'word-spacing', 'text-decoration',
  'paint-order', 'vector-effect', 'shape-rendering', 'transform', 'transform-origin', 'transform-box',
]);

/** CSS/SVG functions a value may call. url() only as a reference inside the icon (`url(#id)`). */
const FUNCTIONS = new Set([
  'url', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'rotate', 'matrix', 'skewx', 'skewy',
  'rgb', 'rgba', 'hsl', 'hsla',
]);

// '<' never appears inside a tag (it's illegal in an XML attribute value), so a match can't run past the next '<',
// and an unquoted value can't start with a quote, so a quoted value has one reading: both keep matching linear.
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=>/<"']+(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s><"'][^\s><]*))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=>/<"']+)(?:\s*=\s*(?:"([^"<]*)"|'([^'<]*)'|([^\s><"'][^\s><]*)))?/g;
/** A plain XML attribute name; a prefixed one is kept only as one of PREFIXED. */
const ATTR_NAME = /^[A-Za-z_][\w.-]*$/;
/** xlink:href becomes href (SVG 2): exports don't declare the xlink namespace. */
const PREFIXED: Record<string, string> = { 'xlink:href': 'href', 'xml:space': 'xml:space' };
/** Written in lower case, whatever case they came in: the sanitizer treats them specially. */
const CANONICAL = new Set(['id', 'style', 'href']);
const NAMED_REFERENCE = /&(quot|amp|lt|gt|apos);/g;
const BARE_AMPERSAND = /&(?!(?:quot|amp|lt|gt|apos);)/g;
const CLEAN_URL = /url\(\s*(["']?)#([\w.:-]+)\1\s*\)/gi;
const ANY_URL = /url\s*\(/gi;
const REFERENCES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };

// This module IS the sanitizer: an element/attribute allowlist with its own escaping (contract
// tests in tests/contract/svg-import.test.ts), deliberately without a DOM library so it runs the
// same in the browser and on the server.
function escapeAttr(value: string): string {
  // bearer:disable javascript_lang_manual_html_sanitization
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(text: string): string {
  // bearer:disable javascript_lang_manual_html_sanitization
  return text.replace(BARE_AMPERSAND, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Every function a value calls is allowed, and every url() is a reference inside the icon. Function names are
 *  read backwards from each '(' (a forward regex would rescan long runs of letters: quadratic). */
function safeFunctions(value: string): boolean {
  for (let i = value.indexOf('('); i !== -1; i = value.indexOf('(', i + 1)) {
    let end = i;
    while (end > 0 && /\s/.test(value[end - 1])) end--;
    let start = end;
    while (start > 0 && /[A-Za-z-]/.test(value[start - 1])) start--;
    if (!FUNCTIONS.has(value.slice(start, end).toLowerCase())) return false;
  }
  return (value.match(ANY_URL)?.length ?? 0) === (value.match(CLEAN_URL)?.length ?? 0);
}

/** A value an attribute or declaration may hold: no CSS escapes or script/data URLs, only safe functions. */
function safeValue(value: string): boolean {
  return !value.includes('\\') && !/javascript:|vbscript:|data:/i.test(value) && safeFunctions(value);
}

function prefixRefs(value: string, prefix: string): string {
  return value.replace(CLEAN_URL, (_m, quote: string, id: string) => `url(${quote}#${prefix}-${id}${quote})`);
}

function cleanStyle(style: string, prefix: string): string | null {
  const kept: string[] = [];
  for (const part of style.split(';')) {
    const declaration = part.trim();
    if (!declaration) continue;
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!STYLE_PROPERTIES.has(property) || value.includes('@') || !safeValue(value)) continue;
    kept.push(`${property}:${prefixRefs(value, prefix)}`);
  }
  return kept.length ? kept.join(';') : null;
}

function cleanAttributes(raw: string, prefix: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(ATTR)) {
    const lower = m[1].toLowerCase();
    const name = Object.hasOwn(PREFIXED, lower)
      ? PREFIXED[lower]
      : CANONICAL.has(lower)
        ? lower
        : ATTR_NAME.test(m[1])
          ? m[1]
          : null;
    if (name === null || lower.startsWith('on') || lower.startsWith('xmlns') || seen.has(name)) continue;
    const given = m[2] ?? m[3] ?? m[4];
    if (given === undefined) {
      // A bare name isn't XML; `<rect hidden>` keeps it as hidden="".
      seen.add(name);
      out.push(`${name}=""`);
      continue;
    }
    // Only the five XML references are understood; a numeric or bare '&' could spell anything.
    if (given.replace(NAMED_REFERENCE, '').includes('&')) continue;
    const value = given.replace(NAMED_REFERENCE, (_m, ref: string) => REFERENCES[ref]);
    // A style's declarations are checked one by one, so one bad one doesn't drop the rest.
    if (name !== 'style' && !safeValue(value)) continue;
    let kept: string | null;
    if (name === 'href') kept = /^#[\w.:-]+$/.test(value) ? `#${prefix}-${value.slice(1)}` : null;
    else if (name === 'id') kept = `${prefix}-${value}`;
    else if (name === 'style') kept = cleanStyle(value, prefix);
    else kept = prefixRefs(value, prefix);
    if (kept === null) continue;
    seen.add(name);
    out.push(`${name}="${escapeAttr(kept)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/** Removes every `open`...`close` span, nearest close first, as a global lazy regex would, in linear time: a start
 *  with no close after it means no later start has one either. */
function removeSpans(text: string, open: RegExp, close: string): string {
  let out = '';
  let last = 0;
  const starts = new RegExp(open.source, `${open.flags}g`);
  for (let m = starts.exec(text); m; m = starts.exec(text)) {
    const end = text.indexOf(close, m.index + m[0].length);
    if (end === -1) break;
    out += text.slice(last, m.index);
    last = end + close.length;
    starts.lastIndex = last;
  }
  return out + text.slice(last);
}

/** `<!DOCTYPE ...>`, with or without an internal subset (`[...]`, ending at the first `]` followed by `>`). */
function removeDoctypes(text: string): string {
  let out = '';
  let last = 0;
  let noSubsetEndFrom = Infinity; // searching for "]>" from here (or later) finds nothing
  let stop = -1; // the first '>' or '[' at or after the last search's start
  const starts = /<!DOCTYPE/gi;
  const stops = /[>[]/g;
  for (let m = starts.exec(text); m; m = starts.exec(text)) {
    const from = m.index + m[0].length;
    if (stop < from) {
      stops.lastIndex = from;
      const found = stops.exec(text);
      if (!found) break;
      stop = found.index;
    }
    let end: number;
    if (text[stop] === '>') end = stop + 1;
    else {
      const open = stop;
      if (open >= noSubsetEndFrom) continue;
      const subsetEnd = /\]\s*>/g;
      subsetEnd.lastIndex = open;
      const found = subsetEnd.exec(text);
      if (!found) {
        noSubsetEndFrom = open;
        continue;
      }
      end = found.index + found[0].length;
    }
    out += text.slice(last, m.index);
    last = end;
    starts.lastIndex = end;
  }
  return out + text.slice(last);
}

/**
 * Strict clean-up of icon markup: only drawing elements survive (anything else is removed with
 * its content), event handlers / external references / javascript: and data: values are dropped,
 * every id (and reference to it) gets `idPrefix` so icons in one diagram can't collide, and the
 * result is balanced, well-formed XML. A `<style>` block is refused: its rules would apply to the
 * whole exported diagram.
 */
export function sanitizeIconMarkupStrict(markup: string, idPrefix: string): string {
  if (markup.length > MAX_SVG_BYTES) throw new SvgImportError(`The artwork is too large (over ${MAX_SVG_BYTES / 1024} KB).`);
  if (/<style\b/i.test(markup)) {
    throw new SvgImportError('The SVG uses a <style> block. Export it with presentation attributes (or inline styles) instead.');
  }
  const prefix = idPrefix.replace(/[^A-Za-z0-9_-]/g, '-');
  const body = removeSpans(removeSpans(markup.replace(NOT_XML_CHAR, ''), /<!--/, '-->'), /<!\[CDATA\[/, ']]>');
  let uses = 0;
  let out = '';
  let last = 0;
  const skipping: string[] = [];
  /** Elements written and not yet closed: a closer must match one, and whatever is left is closed at the end. */
  const open: string[] = [];
  /** How many of each (lower-case) name are open, so a closer that matches none is dropped without a search. */
  const openCount = new Map<string, number>();
  for (const m of body.matchAll(TAG)) {
    const text = body.slice(last, m.index);
    last = m.index! + m[0].length;
    if (skipping.length === 0) out += escapeText(text);
    const [, closing, name, attrs, selfClosing] = m;
    const lower = name.toLowerCase();
    if (skipping.length > 0) {
      if (lower === skipping[skipping.length - 1]) {
        if (closing) skipping.pop();
        else if (!selfClosing) skipping.push(lower);
      }
      continue;
    }
    if (!ALLOWED.has(lower)) {
      if (!closing && !selfClosing) skipping.push(lower);
      continue;
    }
    if (closing) {
      if (!openCount.get(lower)) continue; // closes something outside the icon
      // Close everything opened inside it too (each element is popped once: linear overall).
      for (;;) {
        const top = open.pop()!;
        const topLower = top.toLowerCase();
        openCount.set(topLower, openCount.get(topLower)! - 1);
        out += `</${top}>`;
        if (topLower === lower) break;
      }
      continue;
    }
    if (lower === 'use' && ++uses > MAX_ICON_USES) throw new SvgImportError(`The SVG has more than ${MAX_ICON_USES} <use> elements.`);
    if (!selfClosing && open.length >= MAX_ICON_DEPTH) throw new SvgImportError(`The SVG nests elements more than ${MAX_ICON_DEPTH} deep.`);
    out += `<${name}${cleanAttributes(attrs, prefix)}${selfClosing ? '/' : ''}>`;
    if (!selfClosing) {
      open.push(name);
      openCount.set(lower, (openCount.get(lower) ?? 0) + 1);
    }
  }
  if (skipping.length === 0) out += escapeText(body.slice(last));
  while (open.length > 0) out += `</${open.pop()}>`;
  return out;
}

function parseLength(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)(px)?$/);
  return m ? Number(m[1]) : null;
}

/** An uploaded .svg file -> icon markup in the 48x48 icon space. */
export function prepareUploadedSvg(svgText: string, idPrefix: string): string {
  if (svgText.length > MAX_SVG_BYTES) throw new SvgImportError(`The file is too large (over ${MAX_SVG_BYTES / 1024} KB).`);
  if (/<!ENTITY/i.test(svgText)) throw new SvgImportError('The file declares XML entities, which are not allowed.');
  const text = removeDoctypes(removeSpans(removeSpans(svgText, /<\?xml/i, '?>'), /<!--/, '-->')).trim();
  const root = text.match(/^<svg\b([^>]*?)(\/?)>([\s\S]*)$/i);
  if (!root) throw new SvgImportError("This isn't an SVG file.");
  const inner = root[2] ? '' : root[3].replace(/<\/svg\s*>\s*$/i, '');
  if (!root[2] && inner === root[3]) throw new SvgImportError("This isn't a complete SVG file (no closing </svg>).");

  const attrs = new Map<string, string>();
  for (const m of root[1].matchAll(ATTR)) attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  let viewBox: number[] | null = null;
  const vb = attrs.get('viewbox')?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb.every(Number.isFinite)) viewBox = vb;
  else {
    const w = parseLength(attrs.get('width'));
    const h = parseLength(attrs.get('height'));
    if (w !== null && h !== null) viewBox = [0, 0, w, h];
  }
  if (!viewBox || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new SvgImportError('The SVG has no usable size (it needs a viewBox, or a width and height in pixels).');
  }
  const cleaned = sanitizeIconMarkupStrict(inner, idPrefix);
  return `<svg x="0" y="0" width="48" height="48" viewBox="${viewBox.join(' ')}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${cleaned}</svg>`;
}
