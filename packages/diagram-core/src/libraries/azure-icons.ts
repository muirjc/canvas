import type { IconShapeLibraryManifest } from './library-loader.js';
import { placeholderIconMarkup } from './placeholder-icon.js';

/**
 * ⚠️ PLACEHOLDER ARTWORK, NOT MICROSOFT'S OFFICIAL AZURE ICONS.
 *
 * Microsoft's actual "Azure Architecture Icons" are proprietary assets published under
 * Microsoft's own license/usage terms (see the constitution's Technology & Compliance
 * Constraints). This reference implementation cannot fetch or redistribute that proprietary
 * asset pack, so it ships structurally-correct *placeholder* icons instead — same manifest
 * shape (id/displayName/keywords/category/assetRef) and same ingestion path (`loadLibrary`,
 * Constitution V) a real deployment would use. Before shipping to real users, an admin must
 * replace `icons[].assetRef` with the actual licensed SVG artwork downloaded from Microsoft's
 * official Azure Architecture Icons package — the manifest shape and the rest of the pipeline
 * (search, palette, standards references) needs no code change to support that swap.
 */
export const azureIconsManifest: IconShapeLibraryManifest = {
  id: 'azure-icons',
  version: '2024.1-placeholder',
  license:
    'PLACEHOLDER ARTWORK — replace with Microsoft Azure Architecture Icons under Microsoft\'s published usage terms before production use.',
  icons: [
    { id: 'virtual-machine', displayName: 'Azure Virtual Machine', keywords: ['compute', 'vm', 'server'], category: 'Compute', assetRef: placeholderIconMarkup('VM', '#0078d4') },
    { id: 'app-service', displayName: 'Azure App Service', keywords: ['compute', 'web', 'hosting'], category: 'Compute', assetRef: placeholderIconMarkup('AS', '#0078d4') },
    { id: 'blob-storage', displayName: 'Azure Blob Storage', keywords: ['storage', 'blob', 'object'], category: 'Storage', assetRef: placeholderIconMarkup('BS', '#50e6ff') },
    { id: 'sql-database', displayName: 'Azure SQL Database', keywords: ['database', 'sql', 'data'], category: 'Database', assetRef: placeholderIconMarkup('DB', '#005ba1') },
    { id: 'virtual-network', displayName: 'Azure Virtual Network', keywords: ['network', 'vnet'], category: 'Networking', assetRef: placeholderIconMarkup('VN', '#773adc') },
    { id: 'functions', displayName: 'Azure Functions', keywords: ['compute', 'serverless', 'function'], category: 'Compute', assetRef: placeholderIconMarkup('FN', '#0078d4') },
    { id: 'key-vault', displayName: 'Azure Key Vault', keywords: ['security', 'secrets', 'keys'], category: 'Security', assetRef: placeholderIconMarkup('KV', '#c4c4c4') },
    { id: 'load-balancer', displayName: 'Azure Load Balancer', keywords: ['network', 'balancer'], category: 'Networking', assetRef: placeholderIconMarkup('LB', '#773adc') },
  ],
};
