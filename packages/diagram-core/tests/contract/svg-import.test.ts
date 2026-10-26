import { describe, expect, it } from 'vitest';
import { prepareUploadedSvg, sanitizeIconMarkupStrict, SvgImportError } from '../../src/index.js';

/**
 * canvas-3dq: turning an admin-uploaded .svg file into an icon fragment. Icons are drawn as
 * fragments in a 48x48 coordinate space (svg-renderer.ts scales by iconSize/48), so an uploaded
 * file's own viewBox is fitted into that box -- uniformly, never stretched -- and its markup is
 * cleaned with a strict allowlist, since it ends up inline in exported SVG files.
 */
const ok = (svg: string, prefix = 'icon') => prepareUploadedSvg(svg, prefix);

describe('prepareUploadedSvg', () => {
  it('fits the file viewBox into the 48x48 icon box with a uniform scale', () => {
    const out = ok('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>');
    expect(out).toMatch(/^<svg [^>]*width="48" height="48"/);
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(out).toContain('<path d="M0 0h24v24H0z"/>');
  });

  it('uses width/height when there is no viewBox, and keeps a non-square shape undistorted', () => {
    const out = ok('<svg width="200px" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="100"/></svg>');
    expect(out).toContain('viewBox="0 0 200 100"');
    expect(out).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it('accepts an XML declaration, comments and a DOCTYPE without entities', () => {
    const out = ok('<?xml version="1.0"?>\n<!-- made by a tool -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
    expect(out).toContain('<circle cx="5" cy="5" r="4"/>');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('DOCTYPE');
  });

  it('rejects files that are not an SVG, have no size, are too large, or declare entities', () => {
    expect(() => ok('hello')).toThrow(SvgImportError);
    expect(() => ok('<svg><path d="M0 0"/></svg>')).toThrow(/size/i);
    expect(() => ok(`<svg viewBox="0 0 10 10"><path d="${'M0 0 '.repeat(50_000)}"/></svg>`)).toThrow(/large/i);
    expect(() => ok('<!DOCTYPE svg [<!ENTITY x "boom">]><svg viewBox="0 0 1 1">&x;</svg>')).toThrow(/entit/i);
    expect(() => ok('<svg viewBox="0 0 0 10"><path d="M0 0"/></svg>')).toThrow(/size/i);
  });

  it('rejects a <style> block (its rules would leak onto every other icon in a diagram)', () => {
    expect(() => ok('<svg viewBox="0 0 10 10"><style>.a{fill:red}</style><rect class="a" width="10" height="10"/></svg>')).toThrow(/style/i);
  });

  it('removes script, foreignObject, image, animation and unknown elements with their content', () => {
    const out = ok(
      '<svg viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div>x</div></foreignObject>' +
        '<image href="https://evil.test/x.png"/><a href="https://evil.test"><rect width="1" height="1"/></a>' +
        '<animate attributeName="href" to="javascript:alert(1)"/><set attributeName="x" to="1"/><iframe src="x"></iframe>' +
        '<rect width="10" height="10"/></svg>',
    );
    for (const bad of ['script', 'alert', 'foreignObject', '<image', 'evil.test', '<a ', 'animate', '<set', 'iframe']) expect(out).not.toContain(bad);
    expect(out).toContain('<rect width="10" height="10"/>');
  });

  it('drops event handlers, external references and javascript: values from attributes', () => {
    const out = ok(
      '<svg viewBox="0 0 10 10"><rect onclick="alert(1)" onload=\'x()\' width="10" height="10" ' +
        'fill="url(https://evil.test/p.svg#g)" style="fill:url(http://evil.test/x);stroke:red" xml:base="https://evil.test/"/>' +
        '<use href="https://evil.test/sprite.svg#a"/><use xlink:href="javascript:alert(1)"/></svg>',
    );
    for (const bad of ['onclick', 'onload', 'evil.test', 'javascript', 'xml:base']) expect(out).not.toContain(bad);
    expect(out).toContain('stroke:red');
  });

  it('prefixes ids and their references so two icons in one diagram cannot collide', () => {
    const out = ok(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
        '<rect fill="url(#g)" clip-path="url(&quot;#c&quot;)" width="10" height="10"/><use href="#g"/><use xlink:href="#c"/></svg>',
      'my-icon',
    );
    expect(out).toContain('id="my-icon-g"');
    expect(out).toContain('id="my-icon-c"');
    expect(out).toContain('fill="url(#my-icon-g)"');
    expect(out).toContain('href="#my-icon-g"');
    expect(out).toContain('xlink:href="#my-icon-c"');
    expect(out).not.toMatch(/id="g"/);
  });
});

describe('sanitizeIconMarkupStrict (manifest uploads, already in 48x48 space)', () => {
  it('keeps the fragment in place (no fitting) but applies the same cleaning and id prefixing', () => {
    const out = sanitizeIconMarkupStrict('<g><script>x</script><path id="p" d="M0 0" onclick="x()"/><use href="#p"/></g>', 'lib-icon');
    expect(out).toBe('<g><path id="lib-icon-p" d="M0 0"/><use href="#lib-icon-p"/></g>');
  });

  it('rejects a style block here too', () => {
    expect(() => sanitizeIconMarkupStrict('<style>*{}</style><path d="M0 0"/>', 'x')).toThrow(SvgImportError);
  });
});
