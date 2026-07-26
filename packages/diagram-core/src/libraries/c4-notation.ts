import type { IconShapeLibraryManifest } from './library-loader.js';

/**
 * The standard C4 model notation shapes (Simon Brown's C4 model is openly licensed for this
 * kind of use, unlike the vendor cloud icon sets — no placeholder-artwork caveat needed here).
 */
export const c4NotationManifest: IconShapeLibraryManifest = {
  id: 'c4-notation',
  version: '1.0.0',
  license: 'C4 model notation (c4model.com) — open for diagramming use',
  icons: [
    { id: 'person', displayName: 'Person', keywords: ['actor', 'user', 'role'], category: 'C4 Elements', assetRef: 'shape:person' },
    { id: 'system', displayName: 'Software System', keywords: ['system'], category: 'C4 Elements', assetRef: 'shape:rectangle' },
    { id: 'container', displayName: 'Container', keywords: ['container', 'app', 'service'], category: 'C4 Elements', assetRef: 'shape:rounded-rectangle' },
    { id: 'component', displayName: 'Component', keywords: ['component'], category: 'C4 Elements', assetRef: 'shape:rounded-rectangle' },
    { id: 'database', displayName: 'Database', keywords: ['database', 'store'], category: 'C4 Elements', assetRef: 'shape:cylinder' },
    { id: 'boundary', displayName: 'System/Container Boundary', keywords: ['boundary', 'grouping'], category: 'C4 Elements', assetRef: 'shape:boundary' },
  ],
};
