import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildAwsIconsManifest, LEGACY_AWS_ICON_IDS } from '../../scripts/generate-aws-icons.mjs';
import { awsIconsManifest, AWS_ICONS_VERSION } from '../../src/libraries/aws-icons.js';
import { loadLibrary } from '../../src/libraries/library-loader.js';

/**
 * jmuir-dtu.29: the bundled aws-icons library is placeholder artwork. AWS's icons can't be
 * committed (public repo; AWS's terms only explicitly cover using them to create diagrams), so a
 * deployment generates the library from its own copy of AWS's package. The fixture pack here is
 * hand-drawn stand-ins with AWS's file layout -- no AWS artwork in the repo.
 */
const FIXTURE = fileURLToPath(new URL('../fixtures/aws-icon-pack', import.meta.url));

describe('jmuir-dtu.29: generating the AWS icon library from a local package', () => {
  const manifest = buildAwsIconsManifest(FIXTURE);

  it('produces a valid manifest at the same library id and version as the placeholder', () => {
    expect(manifest.id).toBe('aws-icons');
    expect(manifest.version).toBe(AWS_ICONS_VERSION);
    expect(manifest.version).toBe(awsIconsManifest.version);
    expect(() => loadLibrary(manifest)).not.toThrow();
  });

  it('reads only the 48px service icons, one entry per service', () => {
    expect(manifest.icons.map((i: { id: string }) => i.id).sort()).toEqual(['ec2', 'fixture-gradient-service', 's3']);
  });

  it('keeps the placeholder library\'s ids for the services it covered, so saved diagrams resolve', () => {
    const ec2 = manifest.icons.find((i: { id: string }) => i.id === 'ec2');
    expect(ec2.displayName).toBe('Amazon EC2');
    expect(ec2.category).toBe('Compute');
    for (const id of awsIconsManifest.icons.map((i) => i.id)) {
      expect(Object.values(LEGACY_AWS_ICON_IDS)).toContain(id);
    }
  });

  it('scales uniformly into the 48x48 icon space and drops <title> / the XML prolog', () => {
    const ec2 = manifest.icons.find((i: { id: string }) => i.id === 'ec2');
    expect(ec2.assetRef).toMatch(/^<g transform="translate\(0,0\) scale\(0\.75\)">/);
    expect(ec2.assetRef).not.toContain('<title>');
    expect(ec2.assetRef).not.toContain('<?xml');
    const wide = manifest.icons.find((i: { id: string }) => i.id === 'fixture-gradient-service');
    // 32x16 scales by 1.5 to 48x24, centred vertically.
    expect(wide.assetRef).toMatch(/^<g transform="translate\(0,12\) scale\(1\.5\)">/);
  });

  it('prefixes element ids and their references with the icon id, so inlined icons never collide', () => {
    const ec2 = manifest.icons.find((i: { id: string }) => i.id === 'ec2');
    expect(ec2.assetRef).toContain('id="aws-ec2-Rectangle"');
    expect(ec2.assetRef).not.toMatch(/id="Rectangle"/);
    const wide = manifest.icons.find((i: { id: string }) => i.id === 'fixture-gradient-service');
    expect(wide.assetRef).toContain('id="aws-fixture-gradient-service-grad"');
    expect(wide.assetRef).toContain('url(#aws-fixture-gradient-service-grad)');
    expect(wide.assetRef).toContain('href="#aws-fixture-gradient-service-grad"');
  });

  it('records AWS\'s terms in the license and says where the artwork came from', () => {
    expect(manifest.license).toMatch(/AWS Architecture Icons/);
    expect(manifest.license).not.toMatch(/PLACEHOLDER/);
  });
});
