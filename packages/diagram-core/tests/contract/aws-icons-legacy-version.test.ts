import { describe, expect, it } from 'vitest';
import { splitFrontMatter } from '../../src/dsl/front-matter.js';
import { AWS_ICONS_VERSION } from '../../src/libraries/aws-icons.js';

/**
 * jmuir-dtu.29: the aws-icons library moved from version '2024.1-placeholder' to AWS_ICONS_VERSION
 * so the placeholder and a locally generated real library share one version. Saved diagrams
 * reference the old version in front-matter; reading it upgrades those references.
 */
describe('jmuir-dtu.29: legacy aws-icons references are upgraded on read', () => {
  it('rewrites aws-icons@2024.1-placeholder to the current version', () => {
    const { frontMatter } = splitFrontMatter(
      '---\ncanvas:\n  icons:\n    n1: { libraryId: aws-icons, libraryVersion: 2024.1-placeholder, iconId: ec2 }\n---\nflowchart TD\n',
    );
    expect(frontMatter.canvas?.icons?.n1).toEqual({ libraryId: 'aws-icons', libraryVersion: AWS_ICONS_VERSION, iconId: 'ec2' });
  });

  it('leaves other libraries and versions alone', () => {
    const { frontMatter } = splitFrontMatter(
      '---\ncanvas:\n  icons:\n    a: { libraryId: azure-icons, libraryVersion: "2024.1", iconId: x }\n    b: { libraryId: other, libraryVersion: 2024.1-placeholder, iconId: y }\n---\nflowchart TD\n',
    );
    expect(frontMatter.canvas?.icons?.a.libraryVersion).toBe('2024.1');
    expect(frontMatter.canvas?.icons?.b.libraryVersion).toBe('2024.1-placeholder');
  });
});
