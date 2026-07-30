#!/usr/bin/env node
/**
 * Generates src/libraries/azure-icons.ts from a local copy of Microsoft's official "Azure
 * Architecture Icons" download (https://learn.microsoft.com/azure/architecture/icons/) — a
 * curated subset (Compute/Storage/Database/Networking/Security/Identity/Containers/Analytics/IoT)
 * rather than the full ~700-icon pack, matching the mainstream categories the bundled placeholder
 * manifest used to cover.
 *
 * The source pack is NOT committed to this repo (see .gitignore) — it's Microsoft's own zip
 * contents, and per Microsoft's usage terms (icons/Azure_Public_Service_Icons/*.pdf in a local
 * checkout) this script only ever resizes the artwork uniformly (never crops/flips/rotates/
 * distorts it), which is the one modification those terms explicitly permit.
 *
 * Usage: node scripts/generate-azure-icons.mjs [path-to-Azure_Public_Service_Icons/Icons]
 *   (defaults to ../../../icons/Azure_Public_Service_Icons/Icons relative to this script)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = resolve(here, '../../../icons/Azure_Public_Service_Icons/Icons');
const OUTPUT_PATH = resolve(here, '../src/libraries/azure-icons.ts');

/** folder name (as it appears under Icons/) -> { category label, extra search keywords } */
const CATEGORY_FOLDERS = {
  compute: 'Compute',
  storage: 'Storage',
  databases: 'Database',
  networking: 'Networking',
  security: 'Security',
  identity: 'Identity',
  containers: 'Containers',
  analytics: 'Analytics',
  iot: 'IoT',
};

/** The node's normalized icon coordinate space (svg-renderer.ts / shapes.tsx both assume this). */
const TARGET_SIZE = 48;

function parseViewBox(svg) {
  const match = svg.match(/viewBox="([\d.\s]+)"/);
  if (!match) return { width: 18, height: 18 };
  const [, , width, height] = match[1].trim().split(/\s+/).map(Number);
  return { width, height };
}

function extractInner(svg) {
  const openTagEnd = svg.indexOf('>');
  const closeTagStart = svg.lastIndexOf('</svg>');
  const inner = svg.slice(openTagEnd + 1, closeTagStart);
  return inner.replace(/<title>[\s\S]*?<\/title>/i, '').trim();
}

/** Uniform scale-to-fit + center — never a non-uniform (distorting) scale, per Microsoft's terms. */
function normalizeToTargetSize(svg) {
  const { width, height } = parseViewBox(svg);
  const inner = extractInner(svg);
  const scale = TARGET_SIZE / Math.max(width, height);
  const offsetX = (TARGET_SIZE - width * scale) / 2;
  const offsetY = (TARGET_SIZE - height * scale) / 2;
  const round = (n) => Math.round(n * 1000) / 1000;
  return `<g transform="translate(${round(offsetX)},${round(offsetY)}) scale(${round(scale)})">${inner}</g>`;
}

/** "10130-icon-service-SQL-Database.svg" -> "SQL-Database"; strips a leading "Azure-" too, so
 *  every icon can get a uniform "Azure " display-name prefix regardless of whether the vendor's
 *  own filename already included it. */
function coreName(filename) {
  const withoutExt = filename.replace(/\.svg$/i, '');
  const withoutPrefix = withoutExt.replace(/^\d+-icon-service-/i, '');
  return withoutPrefix.replace(/^Azure-/i, '');
}

function toId(name, usedIds) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function toDisplayName(name) {
  return `Azure ${name.replace(/-/g, ' ')}`;
}

function toKeywords(displayName, category, folder) {
  const words = displayName
    .toLowerCase()
    .replace(/[()]/g, '')
    .split(/\s+/)
    .filter((w) => w && w !== 'azure');
  return [...new Set([...words, category.toLowerCase(), folder])];
}

function main() {
  const sourceRoot = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SOURCE;
  const usedIds = new Set();
  const icons = [];

  for (const [folder, category] of Object.entries(CATEGORY_FOLDERS)) {
    const dir = resolve(sourceRoot, folder);
    const files = readdirSync(dir).filter((f) => f.endsWith('.svg'));
    for (const file of files.sort()) {
      const raw = readFileSync(resolve(dir, file), 'utf-8');
      const name = coreName(file);
      const displayName = toDisplayName(name);
      icons.push({
        id: toId(name, usedIds),
        displayName,
        keywords: toKeywords(displayName, category, folder),
        category,
        assetRef: normalizeToTargetSize(raw),
      });
    }
  }

  const manifest = {
    id: 'azure-icons',
    version: '2024.1',
    license:
      "Microsoft Azure Architecture Icons. Used per Microsoft's published terms " +
      '(learn.microsoft.com/azure/architecture/icons/): permitted in architecture diagrams, ' +
      'training materials, and documentation; icons are uniformly resized only, never cropped, ' +
      'flipped, rotated, or otherwise distorted; not used to represent any non-Microsoft product ' +
      "or service. Every placed icon's node carries the Azure service's display name as its label " +
      "(the app's own labeling behavior), per Microsoft's labeling requirement.",
    icons,
  };

  const header = `/**
 * Curated subset of Microsoft's official Azure Architecture Icons (Compute, Storage, Database,
 * Networking, Security, Identity, Containers, Analytics, IoT) — ${icons.length} icons.
 *
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   node scripts/generate-azure-icons.mjs [path-to-Azure_Public_Service_Icons/Icons]
 * from a local copy of Microsoft's download (not committed to this repo — see .gitignore and
 * scripts/generate-azure-icons.mjs's doc comment for the usage-terms rationale).
 */
import type { IconShapeLibraryManifest } from './library-loader.js';

export const azureIconsManifest: IconShapeLibraryManifest = ${JSON.stringify(manifest, null, 2)};
`;

  writeFileSync(OUTPUT_PATH, header);
  console.log(`Wrote ${icons.length} icons to src/libraries/azure-icons.ts`);
}

main();
