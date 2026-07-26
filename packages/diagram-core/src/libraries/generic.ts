import type { IconShapeLibraryManifest } from './library-loader.js';

/** The built-in generic flowchart/ERD shape set — always available, no license restriction. */
export const genericShapesManifest: IconShapeLibraryManifest = {
  id: 'generic',
  version: '1.0.0',
  icons: [
    { id: 'rectangle', displayName: 'Rectangle', keywords: ['box', 'process'], category: 'Basic Shapes', assetRef: 'shape:rectangle' },
    { id: 'rounded-rectangle', displayName: 'Rounded Rectangle', keywords: ['box', 'process'], category: 'Basic Shapes', assetRef: 'shape:rounded-rectangle' },
    { id: 'circle', displayName: 'Circle', keywords: ['ellipse', 'state'], category: 'Basic Shapes', assetRef: 'shape:circle' },
    { id: 'diamond', displayName: 'Diamond / Decision', keywords: ['decision', 'condition'], category: 'Basic Shapes', assetRef: 'shape:diamond' },
    { id: 'cylinder', displayName: 'Cylinder / Data Store', keywords: ['database', 'storage'], category: 'Basic Shapes', assetRef: 'shape:cylinder' },
  ],
};
