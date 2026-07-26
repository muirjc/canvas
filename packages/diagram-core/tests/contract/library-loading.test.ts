import { describe, expect, it } from 'vitest';
import { loadLibrary, searchIcons, LibraryValidationError } from '../../src/libraries/library-loader.js';

/**
 * Constitution V (Extensible Symbol Libraries): adding a new icon set — Azure, AWS, or any
 * future provider — is one loadLibrary() call with a manifest; no other diagram-core code
 * should need to change. This test uses Azure/AWS-shaped fixtures to exercise that contract.
 */
describe('loadLibrary / searchIcons', () => {
  it('ingests an Azure-shaped manifest and makes its icons queryable', () => {
    const library = loadLibrary({
      id: 'azure-icons',
      version: '2024.1',
      license: 'Microsoft Azure architecture icons — used per Microsoft published usage guidelines',
      icons: [
        { id: 'blob-storage', displayName: 'Azure Blob Storage', keywords: ['storage', 'blob', 'object'], category: 'Storage', assetRef: 'azure/blob-storage.svg' },
        { id: 'app-service', displayName: 'Azure App Service', keywords: ['web', 'app', 'hosting'], category: 'Compute', assetRef: 'azure/app-service.svg' },
      ],
    });
    expect(library.id).toBe('azure-icons');
    expect(library.icons).toHaveLength(2);
    expect(library.icons[0].libraryId).toBe('azure-icons');
    expect(library.icons[0].libraryVersion).toBe('2024.1');
  });

  it('ingests an AWS-shaped manifest independently of the Azure one', () => {
    const library = loadLibrary({
      id: 'aws-icons',
      version: '2024.1',
      license: 'AWS Architecture Icons — used per AWS published usage guidelines',
      icons: [
        { id: 'lambda', displayName: 'AWS Lambda', keywords: ['compute', 'serverless', 'function'], category: 'Compute', assetRef: 'aws/lambda.svg' },
        { id: 's3', displayName: 'Amazon S3', keywords: ['storage', 'bucket', 'object'], category: 'Storage', assetRef: 'aws/s3.svg' },
      ],
    });
    expect(library.id).toBe('aws-icons');
    expect(library.icons.map((i) => i.id)).toEqual(['lambda', 's3']);
  });

  it('rejects a manifest with duplicate icon ids', () => {
    expect(() =>
      loadLibrary({
        id: 'broken',
        version: '1.0.0',
        icons: [
          { id: 'x', displayName: 'X', keywords: [], category: 'Misc', assetRef: 'x.svg' },
          { id: 'x', displayName: 'X again', keywords: [], category: 'Misc', assetRef: 'x2.svg' },
        ],
      }),
    ).toThrow(LibraryValidationError);
  });

  it('searches icons by name, id, and keyword, case-insensitively', () => {
    const library = loadLibrary({
      id: 'aws-icons',
      version: '2024.1',
      icons: [
        { id: 'lambda', displayName: 'AWS Lambda', keywords: ['serverless', 'function'], category: 'Compute', assetRef: 'lambda.svg' },
        { id: 's3', displayName: 'Amazon S3', keywords: ['storage', 'bucket'], category: 'Storage', assetRef: 's3.svg' },
      ],
    });

    expect(searchIcons(library, 'lambda').map((i) => i.id)).toEqual(['lambda']);
    expect(searchIcons(library, 'SERVERLESS').map((i) => i.id)).toEqual(['lambda']);
    expect(searchIcons(library, 'bucket').map((i) => i.id)).toEqual(['s3']);
    expect(searchIcons(library, '')).toHaveLength(2);
    expect(searchIcons(library, 'nonexistent')).toHaveLength(0);
  });

  it('keeps two libraries with the same icon id distinct (library-scoped identity)', () => {
    const azure = loadLibrary({ id: 'azure-icons', version: '1.0.0', icons: [{ id: 'storage', displayName: 'Storage', keywords: [], category: 'Storage', assetRef: 'a.svg' }] });
    const aws = loadLibrary({ id: 'aws-icons', version: '1.0.0', icons: [{ id: 'storage', displayName: 'Storage', keywords: [], category: 'Storage', assetRef: 'b.svg' }] });
    expect(azure.icons[0].libraryId).not.toBe(aws.icons[0].libraryId);
  });
});
