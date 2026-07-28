#!/usr/bin/env node
/**
 * WCAG 2.1 contrast verification for the design tokens that actually ship.
 *
 * Reads the hex values straight out of `src/styles/tokens.css` rather than restating them, so
 * editing a token is enough to re-verify it — the pairs below are the contract, the values come
 * from the stylesheet.
 *
 * This exists because the accessibility gate (tests/e2e/accessibility.spec.ts) asserts *zero*
 * axe violations, making a failing colour a build failure rather than a review comment. The
 * first draft of this palette had three failures that visual inspection would not reliably have
 * caught, including a text token at 4.46 against a 4.5 requirement.
 *
 * Usage: node scripts/check-contrast.mjs      (exit 0 = all pass, 1 = at least one failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = resolve(here, '../src/styles/tokens.css');

/** Pairs that occur in the design, with the WCAG threshold each must clear.
 *  4.5 = normal text (1.4.3). 3 = large text, and UI-component/graphical boundaries (1.4.11). */
const PAIRS = [
  ['--text-primary', '--surface-base', 4.5, 'body text on app background'],
  ['--text-primary', '--surface-raised', 4.5, 'body text on panel'],
  ['--text-primary', '--surface-sunken', 4.5, 'text in inset/code area'],
  ['--text-secondary', '--surface-base', 4.5, 'secondary text on app background'],
  ['--text-secondary', '--surface-raised', 4.5, 'secondary text on panel'],
  ['--text-tertiary', '--surface-raised', 4.5, 'meta text on panel'],
  ['--text-tertiary', '--surface-base', 4.5, 'meta text on app background'],
  ['--accent', '--surface-raised', 4.5, 'link on panel'],
  ['--accent', '--surface-base', 4.5, 'link on app background'],
  ['--text-inverse', '--accent', 4.5, 'primary button label'],
  ['--text-inverse', '--accent-hover', 4.5, 'primary button label, hover'],
  ['--accent', '--accent-subtle', 4.5, 'accent text on tinted background'],
  ['--danger', '--surface-raised', 4.5, 'error text'],
  ['--text-inverse', '--danger', 4.5, 'danger button label'],
  ['--success', '--surface-raised', 4.5, 'success text'],
  ['--warning', '--surface-raised', 4.5, 'warning text'],
  ['--border-control', '--surface-raised', 3, 'form control boundary (WCAG 1.4.11)'],
  ['--border-control', '--surface-base', 3, 'form control boundary on app background'],
  ['--focus-ring', '--surface-raised', 3, 'focus indicator on panel'],
  ['--focus-ring', '--surface-base', 3, 'focus indicator on app background'],
  ['--focus-ring', '--surface-sunken', 3, 'focus indicator on inset'],
  ['--node-selected', '--surface-canvas', 3, 'selected diagram node outline'],
];

/** Decorative separators, exempt from 1.4.11 because they never delineate a control on their
 *  own. Reported for visibility so nobody promotes one onto a form control by accident. */
const DECORATIVE = ['--border-default', '--border-subtle', '--canvas-grid-dot'];

function parseTokens(css) {
  const tokens = {};
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens[name] = value;
  }
  return tokens;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const [r, g, b] = full.match(/../g).map((pair) => {
    const v = parseInt(pair, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

let css;
try {
  css = readFileSync(TOKENS_PATH, 'utf8');
} catch {
  console.error(`Cannot read ${TOKENS_PATH}\nRun this after src/styles/tokens.css exists.`);
  process.exit(1);
}

const tokens = parseTokens(css);
const missing = [...new Set([...PAIRS.flatMap(([f, b]) => [f, b]), ...DECORATIVE])].filter(
  (t) => !tokens[t],
);
if (missing.length) {
  console.error(`Missing token(s) in tokens.css: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`Contrast check against ${TOKENS_PATH}\n`);
console.log('PAIR                                          RATIO   NEED  RESULT  NOTE');
let failures = 0;
for (const [fg, bg, need, note] of PAIRS) {
  const r = ratio(tokens[fg], tokens[bg]);
  const pass = r >= need;
  if (!pass) failures += 1;
  const label = `${fg} / ${bg}`;
  console.log(
    `${label.padEnd(45)} ${r.toFixed(2).padStart(5)}  ${String(need).padStart(4)}  ${(pass ? 'PASS' : 'FAIL').padEnd(6)}  ${note}`,
  );
}

console.log('\nDecorative separators (exempt from 1.4.11 — never use on a form control):');
for (const t of DECORATIVE) {
  console.log(`  ${t.padEnd(24)} ${ratio(tokens[t], tokens['--surface-raised']).toFixed(2)} on --surface-raised`);
}

if (failures > 0) {
  console.error(`\n${failures} pair(s) FAILED. Fix tokens.css before shipping — the axe gate will reject this.`);
  process.exit(1);
}
console.log(`\nAll ${PAIRS.length} pairs pass.`);
