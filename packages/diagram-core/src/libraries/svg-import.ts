/**
 * canvas-3dq: turning an admin-uploaded SVG into an icon. Icon artwork is an SVG fragment drawn in
 * a 48x48 coordinate space (svg-renderer.ts scales it by iconSize/48), and it ends up inline in
 * exported SVG files -- so uploaded markup gets a strict allowlist clean-up (stricter than
 * svg-sanitizer.ts's, which only guards the bundled vendor packs) and the file's own viewBox is
 * fitted into the 48x48 box with a uniform scale, never stretched (vendor icon terms forbid
 * distortion, and it looks wrong anyway).
 */
export class SvgImportError extends Error {}

/** Per file. The bundled vendor icons are 1-30 KB; a 200 KB icon is almost certainly a photo trace. */
export const MAX_SVG_BYTES = 200 * 1024;

const ALLOWED = new Set(
  [
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'lineargradient',
    'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'symbol', 'use', 'title', 'desc', 'text', 'tspan',
  ],
);

const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

// This module IS the sanitizer: an element/attribute allowlist with its own escaping (contract
// tests in tests/contract/svg-import.test.ts), deliberately without a DOM library so it runs the
// same in the browser and on the server.
function escapeAttr(value: string): string {
  // bearer:disable javascript_lang_manual_html_sanitization
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** `url(#x)`, `url("#x")`, `url(&quot;#x&quot;)` -> the referenced id, or null for an external URL. */
function urlTargets(value: string): (string | null)[] {
  return [...value.matchAll(/url\(\s*(?:&quot;|["'])?([^)"'&]*)(?:&quot;|["'])?\s*\)/gi)].map((m) => (m[1].startsWith('#') ? m[1].slice(1) : null));
}

function prefixRefs(value: string, prefix: string): string {
  return value.replace(/url\(\s*(&quot;|["'])?#([^)"'&]+)(&quot;|["'])?\s*\)/gi, (_m, open = '', id, close = '') => `url(${open}#${prefix}-${id}${close})`);
}

function cleanStyle(style: string, prefix: string): string | null {
  if (/expression\s*\(|@import|javascript:|behavior\s*:/i.test(style)) return null;
  const kept = style
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && urlTargets(d).every((t) => t !== null));
  return kept.length ? prefixRefs(kept.join(';'), prefix) : null;
}

function cleanAttributes(raw: string, prefix: string): string {
  const out: string[] = [];
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1];
    const lower = name.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (lower.startsWith('on') || lower === 'xml:base' || /javascript:|data:/i.test(value)) continue;
    if (lower === 'href' || lower === 'xlink:href') {
      if (!value.startsWith('#')) continue;
      out.push(`${name}="${escapeAttr(`#${prefix}-${value.slice(1)}`)}"`);
      continue;
    }
    if (lower === 'id') {
      out.push(`id="${escapeAttr(`${prefix}-${value}`)}"`);
      continue;
    }
    if (lower === 'style') {
      const style = cleanStyle(value, prefix);
      if (style) out.push(`style="${escapeAttr(style)}"`);
      continue;
    }
    if (/url\(/i.test(value)) {
      if (urlTargets(value).some((t) => t === null)) continue;
      out.push(`${name}="${escapeAttr(prefixRefs(value, prefix))}"`);
      continue;
    }
    out.push(m[2] === undefined && m[3] === undefined && m[4] === undefined ? name : `${name}="${escapeAttr(value)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/**
 * Strict clean-up of icon markup: only drawing elements survive (anything else is removed with
 * its content), event handlers / external references / javascript: and data: values are dropped,
 * and every id (and reference to it) gets `idPrefix` so icons in one diagram can't collide.
 * A `<style>` block is refused: its rules would apply to the whole exported diagram.
 */
export function sanitizeIconMarkupStrict(markup: string, idPrefix: string): string {
  if (/<style\b/i.test(markup)) {
    throw new SvgImportError('The SVG uses a <style> block. Export it with presentation attributes (or inline styles) instead.');
  }
  const prefix = idPrefix.replace(/[^A-Za-z0-9_-]/g, '-');
  const body = markup.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  let out = '';
  let last = 0;
  const skipping: string[] = [];
  for (const m of body.matchAll(TAG)) {
    const text = body.slice(last, m.index);
    last = m.index! + m[0].length;
    // Text between tags; see escapeAttr's note.
    // bearer:disable javascript_lang_manual_html_sanitization
    if (skipping.length === 0) out += text.replace(/</g, '&lt;');
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
    out += closing ? `</${name}>` : `<${name}${cleanAttributes(attrs, prefix)}${selfClosing ? '/' : ''}>`;
  }
  // Trailing text; see escapeAttr's note.
  // bearer:disable javascript_lang_manual_html_sanitization
  if (skipping.length === 0) out += body.slice(last).replace(/</g, '&lt;');
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
  const text = svgText
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '')
    .trim();
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
