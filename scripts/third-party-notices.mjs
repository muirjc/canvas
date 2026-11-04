#!/usr/bin/env node
// canvas-qrvn: writes THIRD-PARTY-NOTICES.md -- every production npm package any workspace
// ships (the web bundle, the validator bundle) and every production Python package the API image
// installs (apps/api-py, without the dev dependency group), with its licence and the
// licence/notice text from the installed package -- and fails on a licence outside ALLOWED.
//
//   node scripts/third-party-notices.mjs           write THIRD-PARTY-NOTICES.md
//   node scripts/third-party-notices.mjs --check   fail if the committed file is out of date
//
// Needs `npm ci` and `uv sync --frozen` (dev group or not) in apps/api-py first.
//
// The package lists come from the lockfiles, not from what happens to be installed, so the output
// is the same on every Linux machine: npm's from package-lock.json (entries not flagged
// dev/devOptional), Python's from apps/api-py/uv.lock via `uv export --frozen --no-dev`. Licence
// metadata and texts are read from the installed packages (node_modules, and the dist-info
// directories in apps/api-py/.venv). The platform-dependent parts are handled explicitly: optional
// npm native binaries restricted by os/cpu (only one of which npm installs per platform), and
// Python packages whose environment marker excludes Linux, are listed without licence text.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// canvas-dyvn: the font PNG exports draw their text in.
const FONT_LICENSE = join(ROOT, 'apps/api-py/src/canvas_api/fonts/OFL.txt');
const DAGRE_LICENSE = join(ROOT, 'apps/api-py/src/canvas_api/diagram_core/dagre/LICENSE');
const OUTPUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');
const PY_PROJECT = join(ROOT, 'apps', 'api-py');
const PY_SITE_PACKAGES = join(PY_PROJECT, '.venv', 'lib', 'python3.13', 'site-packages');

// SPDX expressions accepted without review. Anything else fails unless listed in EXCEPTIONS.
const ALLOWED = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  // @resvg/resvg-js (PNG export), used unmodified; MPL-2.0 is file-level copyleft only.
  'MPL-2.0',
  // json-schema (via @fastify/swagger); dual-licensed, used under BSD-3-Clause.
  '(AFL-2.1 OR BSD-3-Clause)',
  // Dual-licensed Python packages (cryptography, packaging, sniffio, structlog, uvloop); each
  // offers a permissive licence from this list.
  'Apache-2.0 OR BSD-3-Clause',
  'Apache-2.0 OR BSD-2-Clause',
  'MIT OR Apache-2.0',
  // cffi; MIT without the attribution requirement.
  'MIT-0',
  // typing_extensions; the Python Software Foundation licence, permissive.
  'PSF-2.0',
]);

// Reviewed packages whose licence is outside ALLOWED: `name` -> why it is acceptable.
const EXCEPTIONS = new Map([
  [
    'psycopg',
    'LGPL-3.0-only: the PostgreSQL driver, used unmodified as a separately installed library, which the LGPL permits.',
  ],
  [
    'psycopg-binary',
    "LGPL-3.0-only: psycopg's C speed-ups, used unmodified as a separately installed library. The wheel also bundles libpq, OpenSSL, krb5, cyrus-sasl, OpenLDAP, PCRE, keyutils, libcom_err, libselinux and libxcrypt shared libraries (all under permissive or LGPL licences, used unmodified) but ships no licence text for them.",
  ],
]);

// Python packages whose metadata gives no SPDX licence, reviewed against the licence file they
// ship: `name` -> SPDX expression.
const PY_REVIEWED_LICENSES = new Map([
  // METADATA `License:` holds a copyright line, classifier just "BSD License"; LICENSE has the
  // three BSD clauses (incl. no endorsement).
  ['isodate', 'BSD-3-Clause'],
  // No licence metadata at all; licenses/LICENSE is the MIT text.
  ['resvg-py', 'MIT'],
  // METADATA says "MIT License" but the project is dual-licensed and ships both texts.
  ['uvloop', 'MIT OR Apache-2.0'],
]);

// Python packages whose environment marker excludes Linux, so they are never installed here and
// their metadata can't be read: `name` -> SPDX licence, reviewed on PyPI.
const PY_NOT_INSTALLED_LICENSES = new Map([
  ['httpx2-jsfetch', 'BSD-3-Clause'], // emscripten only
  ['tzdata', 'Apache-2.0'], // Windows only
]);

// Non-SPDX `License:` field values and `License ::` classifiers, mapped to SPDX. A BSD classifier
// is deliberately absent: it doesn't say which BSD licence, so such a package needs a reviewed
// entry above.
const PY_LICENSE_ALIASES = new Map([
  ['MIT License', 'MIT'],
  ['License :: OSI Approved :: MIT License', 'MIT'],
  ['License :: OSI Approved :: Apache Software License', 'Apache-2.0'],
  ['License :: OSI Approved :: ISC License (ISCL)', 'ISC'],
  ['License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)', 'MPL-2.0'],
]);

// The environment the production image runs in, for evaluating uv.lock environment markers.
const PY_ENVIRONMENT = {
  sys_platform: 'linux',
  platform_system: 'Linux',
  os_name: 'posix',
  platform_python_implementation: 'CPython',
  implementation_name: 'cpython',
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const SPDX_EXPRESSION = /^[A-Za-z0-9.+-]+( (OR|AND|WITH) [A-Za-z0-9.+-]+)*$/;

function packageName(lockPath, entry) {
  if (entry.name) return entry.name;
  const i = lockPath.lastIndexOf('node_modules/');
  return lockPath.slice(i + 'node_modules/'.length);
}

function repositoryUrl(pkgJson) {
  const repo = pkgJson.repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  if (!url) return pkgJson.homepage ?? '';
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  if (url.startsWith('github:')) return `https://github.com/${url.slice('github:'.length)}`;
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

function licenseTexts(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({
      file: f,
      text: readFileSync(join(dir, f), 'utf8').replace(/\r\n?/g, '\n').trim(),
    }));
}

function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}text\n${text}\n${marks}`;
}

function collect() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const packages = new Map();
  const platformBinaries = new Map();
  const problems = [];

  for (const [lockPath, entry] of Object.entries(lock.packages)) {
    if (!lockPath.includes('node_modules/') || entry.link) continue;
    if (entry.dev || entry.devOptional) continue;

    const name = packageName(lockPath, entry);
    const key = `${name}@${entry.version}`;
    const license = entry.license ?? 'UNKNOWN';
    if (!ALLOWED.has(license) && !EXCEPTIONS.has(name)) {
      problems.push(`${key}: licence "${license}" is not on the allow-list`);
    }

    if (entry.os || entry.cpu) {
      platformBinaries.set(key, { name, version: entry.version, license });
      continue;
    }
    if (packages.has(key)) continue;

    const dir = join(ROOT, lockPath);
    if (!existsSync(join(dir, 'package.json'))) {
      problems.push(`${key}: not installed at ${lockPath} (run npm ci first)`);
      continue;
    }
    const pkgJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    packages.set(key, {
      name,
      version: entry.version,
      license,
      repository: repositoryUrl(pkgJson),
      texts: licenseTexts(dir),
    });
  }

  const byKey = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  return {
    packages: [...packages.values()].sort(byKey),
    platformBinaries: [...platformBinaries.values()].sort(byKey),
    ...collectPython(problems),
    problems,
  };
}

// Evaluates a uv.lock environment marker (`a == 'x' and b != 'y' or ...`) for PY_ENVIRONMENT.
// Anything fancier throws, so a new marker shape is noticed rather than guessed at.
function markerApplies(marker) {
  if (!marker) return true;
  if (/[()]/.test(marker)) throw new Error(`unsupported environment marker: ${marker}`);
  return marker.split(' or ').some((alternative) =>
    alternative.split(' and ').every((clause) => {
      const m = /^\s*(\w+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(clause);
      if (!m || !(m[1] in PY_ENVIRONMENT)) {
        throw new Error(`unsupported environment marker: ${marker}`);
      }
      return (PY_ENVIRONMENT[m[1]] === m[3]) === (m[2] === '==');
    }),
  );
}

function pythonLockPackages() {
  const exported = execFileSync(
    'uv',
    ['export', '--frozen', '--no-dev', '--no-hashes', '--no-emit-project', '--quiet'],
    { cwd: PY_PROJECT, encoding: 'utf8' },
  );
  const list = [];
  for (const line of exported.split('\n')) {
    if (line === '' || line.startsWith('#') || /^\s/.test(line)) continue;
    const m = /^([A-Za-z0-9._-]+)==(\S+)(?:\s*;\s*(.+))?$/.exec(line);
    if (!m) throw new Error(`unexpected line from uv export: ${line}`);
    list.push({ name: m[1], version: m[2], marker: m[3] });
  }
  return list;
}

const normalizePyName = (name) => name.toLowerCase().replace(/[-_.]+/g, '_');

function parseMetadata(text) {
  const headers = text.replace(/\r\n?/g, '\n').split('\n\n')[0];
  const fields = [];
  for (const line of headers.split('\n')) {
    if (/^\s/.test(line) && fields.length > 0) continue; // continuation of a long field
    const i = line.indexOf(': ');
    if (i > 0) fields.push([line.slice(0, i), line.slice(i + 2).trim()]);
  }
  const all = (key) => fields.filter(([k]) => k === key).map(([, v]) => v);
  return { get: (key) => all(key)[0], all };
}

function pythonLicense(name, meta) {
  if (PY_REVIEWED_LICENSES.has(name)) return PY_REVIEWED_LICENSES.get(name);
  const expression = meta.get('License-Expression');
  if (expression) return expression;
  const field = meta.get('License');
  if (field) {
    const license = PY_LICENSE_ALIASES.get(field) ?? field;
    if (SPDX_EXPRESSION.test(license)) return license;
  }
  const classifiers = meta.all('Classifier').filter((c) => c.startsWith('License ::'));
  if (classifiers.length === 1 && PY_LICENSE_ALIASES.has(classifiers[0])) {
    return PY_LICENSE_ALIASES.get(classifiers[0]);
  }
  return 'UNKNOWN';
}

function pythonRepository(meta) {
  const urls = meta.all('Project-URL').map((v) => {
    const i = v.indexOf(',');
    return { label: v.slice(0, i).trim().toLowerCase(), url: v.slice(i + 1).trim() };
  });
  const pick = (labels) => urls.find((u) => labels.includes(u.label))?.url;
  return (
    pick(['source', 'source code', 'repository', 'code', 'github']) ??
    meta.get('Home-page') ??
    pick(['homepage', 'home']) ??
    ''
  );
}

function walkFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? walkFiles(path) : [path];
  });
}

// Everything under the dist-info's licenses/ (the PEP 639 place) plus LICENSE*-style files at its
// top level (older wheels), AUTHORS lists excluded.
function pythonLicenseTexts(distInfo) {
  const files = readdirSync(distInfo)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(distInfo, f)).isFile())
    .map((f) => join(distInfo, f));
  const licensesDir = join(distInfo, 'licenses');
  if (existsSync(licensesDir)) {
    files.push(
      ...walkFiles(licensesDir).filter((f) => !/^authors([.-].*)?$/i.test(f.split('/').pop())),
    );
  }
  return files
    .map((f) => relative(distInfo, f).split('\\').join('/'))
    .sort()
    .map((file) => ({
      file,
      text: readFileSync(join(distInfo, file), 'utf8').replace(/\r\n?/g, '\n').trim(),
    }));
}

function collectPython(problems) {
  const packages = [];
  const notInstalled = [];
  const distInfos = new Map();
  if (existsSync(PY_SITE_PACKAGES)) {
    for (const dir of readdirSync(PY_SITE_PACKAGES)) {
      const m = /^(.+)-([^-]+)\.dist-info$/.exec(dir);
      if (m) distInfos.set(`${normalizePyName(m[1])}@${m[2]}`, join(PY_SITE_PACKAGES, dir));
    }
  }

  for (const { name, version, marker } of pythonLockPackages()) {
    const key = `${name}@${version}`;
    if (!markerApplies(marker)) {
      const license = PY_NOT_INSTALLED_LICENSES.get(name) ?? 'UNKNOWN';
      if (!ALLOWED.has(license) && !EXCEPTIONS.has(name)) {
        problems.push(
          `${key} (Python, not for Linux): licence "${license}" is not on the allow-list`,
        );
      }
      notInstalled.push({ name, version, license, marker });
      continue;
    }
    const distInfo = distInfos.get(`${normalizePyName(name)}@${version}`);
    if (!distInfo) {
      problems.push(
        `${key} (Python): not installed in apps/api-py/.venv (run uv sync --frozen in apps/api-py first)`,
      );
      continue;
    }
    const meta = parseMetadata(readFileSync(join(distInfo, 'METADATA'), 'utf8'));
    const license = pythonLicense(name, meta);
    if (!ALLOWED.has(license) && !EXCEPTIONS.has(name)) {
      problems.push(`${key} (Python): licence "${license}" is not on the allow-list`);
    }
    packages.push({
      name,
      version,
      license,
      repository: pythonRepository(meta),
      texts: pythonLicenseTexts(distInfo),
    });
  }

  const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  return { pyPackages: packages.sort(byName), pyNotInstalled: notInstalled.sort(byName) };
}

function renderTexts(out, packages, declaredIn) {
  for (const p of packages) {
    out.push(`### ${p.name} ${p.version}`, '', `Licence: ${p.license}`);
    if (p.repository) out.push(`Repository: ${p.repository}`);
    out.push('');
    if (EXCEPTIONS.has(p.name)) out.push(`Note: ${EXCEPTIONS.get(p.name)}`, '');
    if (p.texts.length === 0) {
      out.push(`The package ships no licence file; its ${declaredIn} declares ${p.license}.`, '');
    }
    for (const { file, text } of p.texts) {
      out.push(`\`${file}\`:`, '', fence(text), '');
    }
  }
}

function render({ packages, platformBinaries, pyPackages, pyNotInstalled }) {
  const out = [];
  out.push(
    '# Third-party notices',
    '',
    'Canvas is licensed under the Apache License 2.0 (see `LICENSE`). It includes third-party',
    'software and artwork under their own licences, listed below.',
    '',
    'It covers the production npm packages (the web app and the validator) and the production',
    'Python packages of the API service (`apps/api-py`). This file is generated by',
    '`npm run licenses` from `package-lock.json` and `apps/api-py/uv.lock`. Do not edit it by hand.',
    '',
    '## Artwork and other non-npm material',
    '',
    "- **Microsoft Azure Architecture Icons** (the `azure-icons` library): used under Microsoft's",
    '  published terms (<https://learn.microsoft.com/azure/architecture/icons/>), which permit their',
    '  use in architecture diagrams, training materials and documentation. The icons are resized',
    '  uniformly and never cropped, flipped, rotated or otherwise distorted.',
    '- **AWS Architecture Icons**: not included in this repository. A deployment may generate them',
    "  locally into `vendor-icons/` from AWS's own download, under AWS's published terms",
    '  (<https://aws.amazon.com/architecture/icons/>); without that file, Canvas uses original',
    '  placeholder icons.',
    '- The generic shapes, the Mermaid architecture icons and the placeholder icons are original',
    '  Canvas artwork under the Apache License 2.0.',
    '- **Liberation Sans** (Regular and Bold, version 2.1;',
    '  <https://github.com/liberationfonts/liberation-fonts>): the font PNG exports draw their text',
    '  in, bundled in the API image (`apps/api-py/src/canvas_api/fonts`), unmodified, under the SIL',
    '  Open Font License 1.1 (its text is below and beside the font files, in `OFL.txt`).',
    '- **dagre** (`@dagrejs/dagre` 3.1.0 with the `@dagrejs/graphlib` it bundles;',
    '  <https://github.com/dagrejs/dagre>): `apps/api-py/src/canvas_api/diagram_core/dagre/` is a',
    "  Python port of the part of its layout Canvas's Auto Layout uses, under the MIT License (its",
    '  text is below and beside the port, in `LICENSE`).',
    '',
    '### Liberation Sans licence',
    '',
    fence(readFileSync(FONT_LICENSE, 'utf8').replace(/\r\n?/g, '\n').trim()),
    '',
    '### dagre licence',
    '',
    fence(readFileSync(DAGRE_LICENSE, 'utf8').replace(/\r\n?/g, '\n').trim()),
    '',
    '## npm packages',
    '',
    `${packages.length} production packages across all workspaces (\`apps/web\`,`,
    '`packages/diagram-core`, `packages/validator-cli`, `packages/diagram-bridge`).',
    '',
    '| Package | Version | Licence |',
    '| --- | --- | --- |',
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
    '',
  );

  if (platformBinaries.length > 0) {
    out.push(
      '### Platform-specific binaries',
      '',
      'npm installs only the one matching the platform it runs on. Each is the native build of the',
      'package it is named after, from the same project and under the same licence (its licence',
      "text is that package's, below).",
      '',
      ...platformBinaries.map((p) => `- ${p.name} ${p.version} (${p.license})`),
      '',
    );
  }

  out.push('## Licence texts', '');
  renderTexts(out, packages, '`package.json`');

  out.push(
    '## Python packages',
    '',
    `${pyPackages.length + pyNotInstalled.length} production packages of the API service`,
    '(`apps/api-py`, without the `dev` dependency group).',
    '',
    '| Package | Version | Licence |',
    '| --- | --- | --- |',
    ...pyPackages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
    '',
  );
  if (pyNotInstalled.length > 0) {
    out.push(
      '### Packages for other platforms',
      '',
      'Dependencies only installed on other platforms, so not part of the Linux image.',
      '',
      ...pyNotInstalled.map((p) => `- ${p.name} ${p.version} (${p.license}; when ${p.marker})`),
      '',
    );
  }
  out.push('## Python licence texts', '');
  renderTexts(out, pyPackages, 'metadata');
  return out.join('\n');
}

const result = collect();
if (result.problems.length > 0) {
  console.error('Third-party licence check failed:');
  for (const problem of result.problems) console.error(`  - ${problem}`);
  console.error(
    'Review the licence. If it is acceptable, add it to ALLOWED or EXCEPTIONS in scripts/third-party-notices.mjs.',
  );
  process.exit(1);
}

const content = render(result);
const counts = `${result.packages.length} npm, ${result.pyPackages.length + result.pyNotInstalled.length} Python packages`;
if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (committed !== content) {
    console.error(
      'THIRD-PARTY-NOTICES.md is out of date. Run `npm run licenses` and commit the result.',
    );
    process.exit(1);
  }
  // Package counts only.
  // bearer:disable javascript_lang_logger_leak
  console.log(`THIRD-PARTY-NOTICES.md is up to date (${counts}).`);
} else {
  writeFileSync(OUTPUT, content);
  // Package counts only.
  // bearer:disable javascript_lang_logger_leak
  console.log(`Wrote THIRD-PARTY-NOTICES.md (${counts}).`);
}
