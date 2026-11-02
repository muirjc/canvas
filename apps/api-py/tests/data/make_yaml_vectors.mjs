// Regenerates yaml_vectors.json: values and what the `yaml` npm package (the one diagram-core uses for
// front matter) writes for them. Used by tests/test_jsyaml_vectors.py to prove the Python port matches.
//   node apps/api-py/tests/data/make_yaml_vectors.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../../packages/diagram-core/package.json', import.meta.url));
const YAML = require('yaml');

// Deterministic pseudo-random numbers (mulberry32), so the file only changes when this script does.
let seed = 20261102;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const TRICKY = [
  '', ' ', '  two', 'a', 'A1', 'true', 'False', 'yes', 'no', 'on', 'off', 'null', '~', 'Null', 'NULL', 'y', 'n',
  '12', '012', '0o17', '0x1F', '1e3', '.5', '1.', '-3', '+4', '1_000', '.inf', '-.Inf', '.nan', '2024-01-01', '12:30',
  '#1168bd', '#fff', 'a: b', 'a:b', 'a #b', 'a#b', '- x', '-x', '-', '--', '? x', '?x', '?', '[x]', '{x}', 'x,y', '&a', '*a', '!t',
  '|', '>', "'q'", '"q"', "it's", 'say "hi"', 'both \' and "', '%x', '@x', '`x', '---', '...', '--- x', '<<', '=',
  'a\nb', 'a\n\nb', '\n', '\n\n', 'a\n', 'a\n\n', '\na', ' lead', 'trail ', 'tab\tin', '\ttab lead', 'trail\t', 'x:', 'x :', ': x',
  'naïve', '日本語', 'emoji 🎨 ok', 'ctl\x07x', 'nul\x00x', 'del\x7fx', 'esc\x1bx', 'bell\x07', 'back\\slash', '<br/>', 'a\rb', 'a\r\nb',
  'x\u0085y', 'x\u2028y', 'x\u2029y', '\u0085', '\u2028', 'nbsp\u00a0x', 'bom\ufeffx', 'zw\u200bx', 'lone\ud800high', 'lone\udc00low', 'pair\ud83c\udfa8ok',
  'line one\nline two\nline three', 'line one\n  indented two\nline three', 'trailing newlines\n\n\n', '  leading spaces\nand second',
  'a'.repeat(79), 'a'.repeat(80), 'a'.repeat(81), 'a'.repeat(200),
  'word '.repeat(16).trim(), 'word '.repeat(17).trim(), 'word '.repeat(40).trim(), 'word '.repeat(40) + ' ',
  'The quick brown fox jumps over the lazy dog and keeps running across the field until it is out of sight, then rests.',
  'x'.repeat(30) + ': ' + 'y '.repeat(40), '# ' + 'comment '.repeat(20), 'a\n' + 'long '.repeat(30),
  'long '.repeat(30) + '\nsecond line', ('block text line\n').repeat(8), ('block text line\n').repeat(8) + '\n\n', ('block\n').repeat(8).trimEnd(),
  'Customer Order Service', 'e1', 'A', '1', '10', '2', 'kind:a', 'a, b', 'a: b: c', 'http://example.com/x?y=1#z', 'C:\\path\\file',
];
const NUMBERS = [0, 1, 40, -12, 3.5, 0.1 + 0.2, 1e21, 1e-7, 123456789.125, 2.5e-10, 140, 16.8, 1 / 3, 1e300, 5e-324, 2 ** 53, -(2 ** 31), 100, 0.5];
const KEYS = ['a', 'alpha', 'x', 'y', 'id', 'label', 'x:y', '#', ' ', '', 'true', 'null', '12', '0', '10', '2', '1', '007', '-1', '1.5', '日本', 'kind:a', 'a b', 'long key '.repeat(10).trim(), "it's", 'a\nb', '- x', '? y', '[k]', '*', '&', 'yes'];

const str = () => {
  const r = rnd();
  if (r < 0.5) return pick(TRICKY);
  if (r < 0.8) return Array.from({ length: int(1, 30) }, () => pick(['alpha', 'beta', 'service', 'Gateway', 'the', 'of', 'a', 'x:y', '#', 'end.', 'very-long-identifier-without-spaces-' + 'z'.repeat(40)])).join(' ');
  return Array.from({ length: int(1, 100) }, () => pick(['a', 'b', ' ', ':', '#', '-', '\n', "'", '"', '\\', 'é', '\t'])).join('');
};
const value = (depth) => {
  const r = rnd();
  if (depth < 4 && r < 0.3) {
    const o = {};
    for (let i = int(0, 5); i > 0; i--) o[pick(KEYS)] = value(depth + 1);
    return o;
  }
  if (depth < 4 && r < 0.4) return Array.from({ length: int(0, 4) }, () => value(depth + 1));
  if (r < 0.5) return pick(NUMBERS);
  if (r < 0.55) return pick([true, false, null]);
  return str();
};

const values = [];
// Every tricky string, as a map value and as a map key's value, and inside a list.
for (const s of TRICKY) {
  values.push({ canvas: { label: s } });
  values.push({ [s]: 1 });
}
for (const s of TRICKY.slice(0, 60)) values.push({ list: [s, s + ' more', 3] });
// Scalars and collections at the root, numbers, empties, nesting.
for (const s of TRICKY) values.push(s);
for (const n of NUMBERS) values.push(n, { n });
values.push(true, false, null, [], {}, [[]], [{}], { a: {} }, { a: [] }, { a: [[1, 2], [3]] }, [{ a: 1, b: [2, { c: 3 }] }]);
// Keys that are array indexes sort first, ascending; the rest keep insertion order.
values.push({ b: 1, 10: 2, 2: 3, a: 4, 1: 5 }, { 10: 'x', 9: 'y', 100: 'z', '08': 'w' }, { canvas: { positions: { 10: { x: 1, y: 2 }, 2: { x: 3, y: 4 }, b: { x: 5, y: 6 }, 1: { x: 7, y: 8 } } } });
// A front-matter shaped document.
values.push({
  title: 'Value chain',
  canvas: {
    positions: { in: { x: 40, y: 40 }, ops: { x: 240.5, y: 40 } },
    containers: { G: { x: 20, y: 20, width: 360, height: 260 } },
    styles: { in: { fillColor: '#dbeafe', strokeColor: '#1e3a8a', strokeWidth: 2, strokeDasharray: '4 2' } },
    edgeStyles: { e1: { strokeWidth: 3 } },
    icons: { in: { libraryId: 'aws-icons', libraryVersion: '2024.1-placeholder', iconId: 'ec2' } },
  },
});
for (let i = 0; i < 250; i++) values.push({ canvas: value(1) });
for (let i = 0; i < 100; i++) values.push(value(0));

const vectors = values.map((v) => ({ value: v, yaml: YAML.stringify(v) }));
const out = fileURLToPath(new URL('./yaml_vectors.json', import.meta.url));
writeFileSync(out, JSON.stringify(vectors) + '\n');
console.log(`${vectors.length} vectors -> ${out}`);
