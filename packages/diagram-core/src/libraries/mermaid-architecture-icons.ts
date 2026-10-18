import type { IconShapeLibraryManifest } from './library-loader.js';

/**
 * jmuir-dtu.27: artwork for the five icons Mermaid's architecture-beta ships built in, so
 * `service db(database)[DB]` draws a database rather than an empty box. Nearly every
 * architecture-beta example uses only these names. Original line glyphs drawn for this app on the
 * renderer's normalized 48x48 viewBox, not copies of Mermaid's own artwork; dsl/architecture.ts
 * maps the five bare names to this library on import.
 */
const STROKE = 'stroke="#334155" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"';

export const MERMAID_ARCHITECTURE_ICON_IDS = ['cloud', 'database', 'disk', 'internet', 'server'] as const;

export const mermaidArchitectureIconsManifest: IconShapeLibraryManifest = {
  id: 'mermaid-architecture',
  version: '1.0.0',
  icons: [
    {
      id: 'cloud',
      displayName: 'Cloud',
      keywords: ['cloud', 'hosting', 'group'],
      category: 'Mermaid Built-in',
      assetRef: `<path d="M13 37h23a8.5 8.5 0 0 0 1.4-16.9A11.5 11.5 0 0 0 15.2 17.6 9.8 9.8 0 0 0 13 37z" fill="#e0f2fe" ${STROKE} />`,
    },
    {
      id: 'database',
      displayName: 'Database',
      keywords: ['database', 'db', 'sql', 'storage', 'data'],
      category: 'Mermaid Built-in',
      assetRef: [
        `<path d="M10 12v24c0 2.8 6.3 5 14 5s14-2.2 14-5V12" fill="#ede9fe" ${STROKE} />`,
        `<ellipse cx="24" cy="12" rx="14" ry="5" fill="#ddd6fe" ${STROKE} />`,
        `<path d="M10 24c0 2.8 6.3 5 14 5s14-2.2 14-5" fill="none" ${STROKE} />`,
      ].join(''),
    },
    {
      id: 'disk',
      displayName: 'Disk',
      keywords: ['disk', 'storage', 'volume', 'drive'],
      category: 'Mermaid Built-in',
      assetRef: [
        `<rect x="8" y="8" width="32" height="32" rx="5" fill="#f1f5f9" ${STROKE} />`,
        `<circle cx="24" cy="22" r="8" fill="#e2e8f0" ${STROKE} />`,
        `<circle cx="24" cy="22" r="1.5" fill="#334155" />`,
        `<path d="M14 34h12" fill="none" ${STROKE} />`,
        `<circle cx="33" cy="34" r="1.8" fill="#16a34a" />`,
      ].join(''),
    },
    {
      id: 'internet',
      displayName: 'Internet',
      keywords: ['internet', 'web', 'globe', 'network', 'public'],
      category: 'Mermaid Built-in',
      assetRef: [
        `<circle cx="24" cy="24" r="16" fill="#dcfce7" ${STROKE} />`,
        `<ellipse cx="24" cy="24" rx="7" ry="16" fill="none" ${STROKE} />`,
        `<path d="M8 24h32M10.5 16h27M10.5 32h27" fill="none" ${STROKE} />`,
      ].join(''),
    },
    {
      id: 'server',
      displayName: 'Server',
      keywords: ['server', 'compute', 'host', 'vm', 'machine'],
      category: 'Mermaid Built-in',
      assetRef: [
        `<rect x="8" y="8" width="32" height="14" rx="3" fill="#fef3c7" ${STROKE} />`,
        `<rect x="8" y="26" width="32" height="14" rx="3" fill="#fef3c7" ${STROKE} />`,
        `<path d="M14 15h10M14 33h10" fill="none" ${STROKE} />`,
        `<circle cx="33" cy="15" r="1.8" fill="#16a34a" />`,
        `<circle cx="33" cy="33" r="1.8" fill="#16a34a" />`,
      ].join(''),
    },
  ],
};
