import { describe, expect, it } from 'vitest';
import { awsIconsManifest } from '../../src/libraries/aws-icons.js';
import { azureIconsManifest } from '../../src/libraries/azure-icons.js';
import { mermaidArchitectureIconsManifest } from '../../src/libraries/mermaid-architecture-icons.js';
import { MAX_ICON_DEPTH, MAX_ICON_USES, MAX_SVG_BYTES, prepareUploadedSvg, sanitizeIconMarkupStrict, SvgImportError } from '../../src/libraries/svg-import.js';

/**
 * canvas-1bty.19: findings of the appsec review of the Python port (which matched TypeScript, so both had them).
 * apps/api-py/tests/test_diagram_core_svg_import.py holds the same cases for the Python copy.
 */
const strict = (markup: string) => sanitizeIconMarkupStrict(markup, 'p');

describe('icon SVG clean-up hardening', () => {
  it('stays fast on input made to backtrack (was exponential in quoted attributes, quadratic elsewhere)', () => {
    const hostile = [
      '<a' + ' x="a b"'.repeat(40),
      '<a x="'.repeat(30_000),
      '<a x='.repeat(30_000),
      '<a '.repeat(60_000),
      '<!--'.repeat(45_000),
      '<![CDATA['.repeat(20_000),
      `<g fill="${'a'.repeat(150_000)}(">`,
      `<g fill="${'url('.repeat(40_000)}">`,
      '<g>'.repeat(30_000) + '</rect>'.repeat(15_000),
    ];
    for (const markup of hostile) {
      const started = Date.now();
      try {
        strict(markup.slice(0, MAX_SVG_BYTES));
      } catch (error) {
        expect(error).toBeInstanceOf(SvgImportError); // too deep: refused, quickly
      }
      expect(Date.now() - started).toBeLessThan(1500);
    }
    for (const prolog of ['<!DOCTYPE'.repeat(20_000) + '[', '<!DOCTYPE ['.repeat(15_000), '<?xml'.repeat(35_000)]) {
      const started = Date.now();
      expect(() => prepareUploadedSvg(prolog.slice(0, MAX_SVG_BYTES), 'p')).toThrow(SvgImportError);
      expect(Date.now() - started).toBeLessThan(1500);
    }
  });

  it('refuses deep nesting and many <use> elements, and removes characters XML forbids', () => {
    expect(strict('<g>'.repeat(MAX_ICON_DEPTH) + '<g/>')).toContain('<g/>');
    expect(() => strict('<g>'.repeat(MAX_ICON_DEPTH + 1))).toThrow(/nests elements more than 100 deep/);
    expect(() => strict('<use href="#a"/>'.repeat(MAX_ICON_USES + 1))).toThrow(/more than 16 <use>/);
    expect(strict('<text id="a\u0001b" x="\u000b1">a\u0000 \uFFFE\uD800 \uDC00 🚀\t</text>')).toBe('<text id="p-ab" x="1">a   🚀\t</text>');
  });

  it('refuses manifest artwork over the size limit', () => {
    expect(() => strict(`<path d="${'M0 0 '.repeat(50_000)}"/>`)).toThrow(/too large/);
  });

  it('loads nothing from outside the icon: entities, CSS escapes, image-set() and other functions', () => {
    for (const markup of [
      '<rect style="fill:url(http://evil/x?a&amp;b)" cursor="url(http://evil/?a&amp;b)"/>',
      '<rect style="cursor:&#117;rl(http://evil/x)" fill="&#117;rl(http://evil/x)"/>',
      '<rect style="cursor:\\75rl(http://evil/x)" fill="\\75rl(http://evil/x)"/>',
      `<rect style="cursor:image-set('http://evil/x.png' 1x)" mask="image('http://evil/x')"/>`,
      '<rect fill="url( http://evil/x )" filter="src(http://evil/x)" style="mask:cross-fade(url(#a), url(http://evil))"/>',
      '<rect fill="URL(http://evil/x)" style="FILL:Url(http://evil/x)"/>',
    ]) {
      expect(strict(markup)).toBe('<rect/>');
    }
    // References inside the icon still work, and are prefixed.
    expect(strict('<rect fill="url(#g)" clip-path="url(&quot;#c&quot;)" style="fill:url(\'#g\');stroke:red"/>')).toBe(
      '<rect fill="url(#p-g)" clip-path="url(&quot;#p-c&quot;)" style="fill:url(\'#p-g\');stroke:red"/>',
    );
  });

  it('keeps only presentation properties in style', () => {
    expect(strict('<rect style="fill:red; position:fixed; behavior:x; -moz-binding:x; stroke : blue ;@import:x"/>')).toBe(
      '<rect style="fill:red;stroke:blue"/>',
    );
  });

  it('cannot close the elements it is drawn inside, and closes what it leaves open', () => {
    expect(strict('</g><rect width="999" height="999"/><g>')).toBe('<rect width="999" height="999"/><g></g>');
    expect(strict('<g/></svg><rect/><svg>')).toBe('<g/><rect/><svg></svg>');
    expect(strict('<g><rect></g>')).toBe('<g><rect></rect></g>');
    expect(prepareUploadedSvg('<svg viewBox="0 0 1 1"></g></svg><rect/><svg></svg>', 'p')).toBe(
      '<svg x="0" y="0" width="48" height="48" viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet" overflow="hidden"><rect/><svg></svg></svg>',
    );
  });

  it('drops namespace declarations and every prefixed attribute but xml:space; xlink:href becomes href', () => {
    expect(strict('<use xmlns:q="http://www.w3.org/1999/xlink" q:href="#a" xmlns="http://www.w3.org/2000/svg"/>')).toBe('<use/>');
    expect(strict('<use xlink:href="#a" xml:space="preserve" xml:base="x" svg:x="1"/>')).toBe('<use href="#p-a" xml:space="preserve"/>');
    expect(strict('<use href="#a" xlink:href="#b"/>')).toBe('<use href="#p-a"/>');
    expect(strict('<use href="#a b"/><use href="http://evil/x#a"/>')).toBe('<use/><use/>');
  });

  it('writes well-formed XML: attribute names, duplicates, bare names, & and > in text', () => {
    expect(strict('<rect 9z="3" a.b:c="1" width="1" WIDTH="2" width="3" hidden/>')).toBe('<rect width="1" WIDTH="2" hidden=""/>');
    // A quote can't be part of a name, so this isn't a tag at all: it stays as (escaped) text.
    expect(strict(`<rect a"b="1"/>`)).toBe('&lt;rect a"b="1"/&gt;');
    expect(strict('<text>a & b &amp; c &#65; &nbsp; 1 > 0</text>')).toBe('<text>a &amp; b &amp; c &amp;#65; &amp;nbsp; 1 &gt; 0</text>');
    // Only the five XML references are read in an attribute; a numeric one drops it.
    expect(strict('<text x="1&amp;2" y="&#49;" class="a&b">t</text>')).toBe('<text x="1&amp;2">t</text>');
  });

  it("keeps every bundled pack's artwork (only ids get the prefix)", () => {
    const icons = [...azureIconsManifest.icons, ...awsIconsManifest.icons, ...mermaidArchitectureIconsManifest.icons];
    for (const icon of icons) {
      const cleaned = sanitizeIconMarkupStrict(icon.assetRef, 'p');
      const tags = (s: string) => [...s.matchAll(/<([A-Za-z]+)/g)].map((m) => m[1]);
      expect(tags(cleaned), icon.id).toEqual(tags(icon.assetRef));
      const attributes = (s: string) => [...s.matchAll(/\s([A-Za-z-]+)=/g)].length;
      // Every attribute survives; xlink:href (not counted: it has a colon) comes out as href.
      const xlinks = icon.assetRef.match(/\sxlink:href=/g)?.length ?? 0;
      expect(attributes(cleaned), icon.id).toBe(attributes(icon.assetRef) + xlinks);
    }
  });
});
