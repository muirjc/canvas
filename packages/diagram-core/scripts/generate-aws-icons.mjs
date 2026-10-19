#!/usr/bin/env node
/**
 * jmuir-dtu.29: generates the real `aws-icons` library from a local copy of AWS's official
 * "AWS Architecture Icons" package (https://aws.amazon.com/architecture/icons/ -> "Icon package"
 * zip), replacing the placeholder artwork bundled in src/libraries/aws-icons.ts.
 *
 * Unlike scripts/generate-azure-icons.mjs, the output is NOT committed: this repo is public and
 * AWS's published terms only explicitly cover using the icons to create architecture diagrams, not
 * redistributing them inside a tool's source. So each deployment generates the library from its own
 * copy of the package; the API's catalog seed (apps/api/src/seed/libraries.seed.ts) loads the
 * generated JSON when present and falls back to the placeholders otherwise.
 *
 * Every 48px service icon is included. The artwork is only uniformly scaled into the renderer's
 * 48x48 icon space (never cropped, flipped, rotated or distorted); element ids are prefixed with the
 * icon's id so several icons inlined into one exported SVG can't collide.
 *
 * Usage:
 *   node packages/diagram-core/scripts/generate-aws-icons.mjs <path-to-Architecture-Service-Icons_*> [output.json]
 *   (output defaults to vendor-icons/aws-icons.json at the repo root, which is gitignored)
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(here, '../../../vendor-icons/aws-icons.json');

/** Must equal AWS_ICONS_VERSION in src/libraries/aws-icons.ts (a contract test checks it). */
const AWS_ICONS_VERSION = '2024.1';
const TARGET_SIZE = 48;

/**
 * The placeholder library's ids, kept for the matching real icons so diagrams saved against the
 * placeholders resolve to real artwork. Keyed by the service's file-name stem.
 */
export const LEGACY_AWS_ICON_IDS = {
  'Amazon-EC2': 'ec2',
  'AWS-Lambda': 'lambda',
  'Amazon-Simple-Storage-Service': 's3',
  'Amazon-DynamoDB': 'dynamodb',
  'Amazon-RDS': 'rds',
  'Amazon-Virtual-Private-Cloud': 'vpc',
  'AWS-Identity-and-Access-Management': 'iam',
  'Elastic-Load-Balancing': 'elb',
};

/** Words AWS writes in a fixed case, restored in display names ("Amazon Ec2" -> "Amazon EC2"). */
const UPPERCASE_WORDS = new Set(['EC2', 'RDS', 'IAM', 'VPC', 'S3', 'IoT', 'API', 'SQS', 'SNS', 'EKS', 'ECS', 'ECR', 'EFS', 'EMR', 'MQ', 'DB']);

function parseViewBox(svg) {
  const match = svg.match(/viewBox="([-\d.\s]+)"/);
  if (!match) return { minX: 0, minY: 0, width: 64, height: 64 };
  const [minX, minY, width, height] = match[1].trim().split(/\s+/).map(Number);
  return { minX, minY, width, height };
}

function innerMarkup(svg) {
  const open = svg.search(/<svg[\s>]/);
  const openTagEnd = svg.indexOf('>', open);
  const closeTagStart = svg.lastIndexOf('</svg>');
  return svg
    .slice(openTagEnd + 1, closeTagStart)
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<desc>[\s\S]*?<\/desc>/gi, '')
    .trim();
}

/** Prefixes every id="..." with `prefix-`, and rewrites url(#...) and href="#..." to match. */
function namespaceIds(markup, prefix) {
  const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  if (ids.size === 0) return markup;
  const rename = (id) => (ids.has(id) ? `${prefix}-${id}` : id);
  return markup
    .replace(/(\sid=")([^"]+)(")/g, (_, a, id, c) => `${a}${rename(id)}${c}`)
    .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${rename(id)})`)
    .replace(/((?:xlink:)?href=")#([^"]+)(")/g, (_, a, id, c) => `${a}#${rename(id)}${c}`);
}

/** Uniform scale-to-fit and centre -- never a distorting (non-uniform) scale. */
function normalize(svg, iconId) {
  const { minX, minY, width, height } = parseViewBox(svg);
  const scale = TARGET_SIZE / Math.max(width, height);
  const round = (n) => Math.round(n * 1000) / 1000;
  const offsetX = round((TARGET_SIZE - width * scale) / 2 - minX * scale);
  const offsetY = round((TARGET_SIZE - height * scale) / 2 - minY * scale);
  const inner = namespaceIds(innerMarkup(svg), `aws-${iconId}`);
  return `<g transform="translate(${offsetX},${offsetY}) scale(${round(scale)})">${inner}</g>`;
}

function toId(stem, usedIds) {
  const legacy = LEGACY_AWS_ICON_IDS[stem];
  const base =
    legacy ??
    stem
      .replace(/^(Amazon|AWS)-/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  let id = base;
  for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
  usedIds.add(id);
  return id;
}

function toDisplayName(stem) {
  return stem
    .split('-')
    .map((word) => {
      const upper = [...UPPERCASE_WORDS].find((w) => w.toLowerCase() === word.toLowerCase());
      return upper ?? word;
    })
    .join(' ');
}

function toCategory(folder) {
  return folder.replace(/^Arch_/, '').replace(/-/g, ' ');
}

function toKeywords(displayName, category) {
  const words = displayName
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && w !== 'amazon' && w !== 'aws');
  return [...new Set([...words, ...category.toLowerCase().split(/\s+/)])];
}

/** Builds the manifest from an `Architecture-Service-Icons_*` folder of AWS's package. */
export function buildAwsIconsManifest(sourceRoot) {
  const usedIds = new Set();
  const icons = [];
  // Legacy ids are claimed first so a same-named service elsewhere can't take them.
  const folders = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('Arch_'))
    .map((d) => d.name)
    .sort();
  const entries = [];
  for (const folder of folders) {
    const dir = resolve(sourceRoot, folder, '48');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => /^Arch_.*_48\.svg$/.test(f)).sort()) {
      entries.push({ folder, file, stem: file.replace(/^Arch_/, '').replace(/_48\.svg$/, '') });
    }
  }
  entries.sort((a, b) => Number(!(b.stem in LEGACY_AWS_ICON_IDS)) - Number(!(a.stem in LEGACY_AWS_ICON_IDS)));
  for (const { folder, file, stem } of entries) {
    const id = toId(stem, usedIds);
    const category = toCategory(folder);
    const displayName = toDisplayName(stem);
    icons.push({
      id,
      displayName,
      keywords: toKeywords(displayName, category),
      category,
      assetRef: normalize(readFileSync(resolve(sourceRoot, folder, '48', file), 'utf-8'), id),
    });
  }
  icons.sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName));
  return {
    id: 'aws-icons',
    version: AWS_ICONS_VERSION,
    license:
      "AWS Architecture Icons, generated locally from AWS's official icon package " +
      '(aws.amazon.com/architecture/icons/). AWS permits customers and partners to use them to ' +
      'create architecture diagrams. Uniformly resized only. Not committed to this repository.',
    icons,
  };
}

function main() {
  const [source, output = DEFAULT_OUTPUT] = process.argv.slice(2);
  if (!source) {
    console.error('Usage: node generate-aws-icons.mjs <path-to-Architecture-Service-Icons_*> [output.json]');
    process.exitCode = 1;
    return;
  }
  const manifest = buildAwsIconsManifest(resolve(source));
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), JSON.stringify(manifest));
  console.log(`Wrote ${manifest.icons.length} AWS icons to ${resolve(output)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
