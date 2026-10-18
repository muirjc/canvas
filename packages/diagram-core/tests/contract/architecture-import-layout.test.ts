import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel, Position, Size } from '../../src/model/diagram-model.js';
import { nodeSize } from '../../src/render/svg-renderer.js';

/**
 * jmuir-dtu.26: a fresh architecture-beta import (no stored front-matter geometry) placed every
 * service, junction AND group from one flat 5-wide grid counter and gave groups no size, so a
 * group's box never enclosed its services and nested groups sat beside their parent. Edge anchor
 * sides (`db:L -- R:server` = db sits right of server) and `align row/column` were parsed but
 * never used for placement -- Mermaid's own renderer lays these diagrams out from those hints.
 */

interface Box { pos: Position; size: Size }

function parseOk(dsl: string): DiagramModel {
  const result = parseArchitecture(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

function nodeBox(model: DiagramModel, id: string): Box {
  const node = model.nodes.find((n) => n.id === id)!;
  return { pos: node.position, size: nodeSize(node) };
}

function groupBox(model: DiagramModel, id: string): Box {
  const group = model.containers.find((c) => c.id === id)!;
  expect(group.size, `group ${id} has a size`).toBeDefined();
  return { pos: group.position, size: group.size! };
}

function encloses(outer: Box, inner: Box): boolean {
  return (
    inner.pos.x >= outer.pos.x &&
    inner.pos.y >= outer.pos.y &&
    inner.pos.x + inner.size.width <= outer.pos.x + outer.size.width &&
    inner.pos.y + inner.size.height <= outer.pos.y + outer.size.height
  );
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.pos.x < b.pos.x + b.size.width &&
    b.pos.x < a.pos.x + a.size.width &&
    a.pos.y < b.pos.y + b.size.height &&
    b.pos.y < a.pos.y + a.size.height
  );
}

const center = (box: Box) => ({ x: box.pos.x + box.size.width / 2, y: box.pos.y + box.size.height / 2 });

// Mermaid's own documentation example for architecture-beta.
const DOCS_EXAMPLE = [
  'architecture-beta',
  '    group api(cloud)[API]',
  '',
  '    service db(database)[Database] in api',
  '    service disk1(disk)[Storage] in api',
  '    service disk2(disk)[Storage] in api',
  '    service server(server)[Server] in api',
  '',
  '    db:L -- R:server',
  '    disk1:T -- B:server',
  '    disk2:T -- B:db',
  '',
].join('\n');

const NESTED_EXAMPLE = [
  'architecture-beta',
  '    group cloud(cloud)[Cloud]',
  '    group vpc(server)[VPC] in cloud',
  '    service gw(internet)[Gateway] in cloud',
  '    service app(server)[App] in vpc',
  '    service db(database)[DB] in vpc',
  '    junction j1',
  '    gw:R --> L:app',
  '    app:B -- T:db',
  '    app{group}:R -- L:j1',
  '',
].join('\n');

describe('jmuir-dtu.26: groups enclose their contents on a fresh import', () => {
  it('the docs example: the api group gets a size enclosing all four services', () => {
    const model = parseOk(DOCS_EXAMPLE);
    const api = groupBox(model, 'api');
    for (const id of ['db', 'disk1', 'disk2', 'server']) {
      expect(encloses(api, nodeBox(model, id)), `${id} inside api`).toBe(true);
    }
  });

  it('a nested group sits inside its parent, and services sit inside their own group', () => {
    const model = parseOk(NESTED_EXAMPLE);
    const cloud = groupBox(model, 'cloud');
    const vpc = groupBox(model, 'vpc');
    expect(encloses(cloud, vpc)).toBe(true);
    expect(encloses(cloud, nodeBox(model, 'gw'))).toBe(true);
    for (const id of ['app', 'db']) {
      expect(encloses(vpc, nodeBox(model, id)), `${id} inside vpc`).toBe(true);
      expect(encloses(cloud, nodeBox(model, id)), `${id} inside cloud`).toBe(true);
    }
    // j1 is top level: outside cloud entirely.
    expect(overlaps(cloud, nodeBox(model, 'j1'))).toBe(false);
  });

  it('an empty group still gets a sensible size', () => {
    const model = parseOk('architecture-beta\n    group empty(cloud)[Empty]\n    service a(server)[A]\n');
    const empty = groupBox(model, 'empty');
    expect(empty.size.width).toBeGreaterThan(0);
    expect(empty.size.height).toBeGreaterThan(0);
    expect(overlaps(empty, nodeBox(model, 'a'))).toBe(false);
  });
});

describe('jmuir-dtu.26: edge anchor sides drive relative placement', () => {
  it('db:L -- R:server puts db to the right of server, on the same row', () => {
    const model = parseOk(DOCS_EXAMPLE);
    const db = nodeBox(model, 'db');
    const server = nodeBox(model, 'server');
    expect(db.pos.x).toBeGreaterThanOrEqual(server.pos.x + server.size.width);
    expect(center(db).y).toBeCloseTo(center(server).y);
  });

  it('disk1:T -- B:server puts disk1 below server, in the same column', () => {
    const model = parseOk(DOCS_EXAMPLE);
    const disk1 = nodeBox(model, 'disk1');
    const server = nodeBox(model, 'server');
    expect(disk1.pos.y).toBeGreaterThanOrEqual(server.pos.y + server.size.height);
    expect(center(disk1).x).toBeCloseTo(center(server).x);
  });

  it('only the target anchor given: A -- L:B still puts B to the right of A', () => {
    const model = parseOk('architecture-beta\n    service a(server)[A]\n    service b(server)[B]\n    a -- L:b\n');
    const a = nodeBox(model, 'a');
    const b = nodeBox(model, 'b');
    expect(b.pos.x).toBeGreaterThanOrEqual(a.pos.x + a.size.width);
  });

  it('an anchored edge between services in different groups places the groups accordingly', () => {
    // gw (in cloud) :R --> L: app (in vpc, in cloud) => at cloud's level, vpc is right of gw.
    const model = parseOk(NESTED_EXAMPLE);
    const gw = nodeBox(model, 'gw');
    const vpc = groupBox(model, 'vpc');
    expect(vpc.pos.x).toBeGreaterThanOrEqual(gw.pos.x + gw.size.width);
    // app:B -- T:db => db below app inside vpc.
    const app = nodeBox(model, 'app');
    const db = nodeBox(model, 'db');
    expect(db.pos.y).toBeGreaterThanOrEqual(app.pos.y + app.size.height);
  });

  it('two services anchored to the same side of one service never overlap', () => {
    const model = parseOk(
      'architecture-beta\n    service hub(server)[Hub]\n    service a(server)[A]\n    service b(server)[B]\n    hub:R -- L:a\n    hub:R -- L:b\n',
    );
    expect(overlaps(nodeBox(model, 'a'), nodeBox(model, 'b'))).toBe(false);
    expect(nodeBox(model, 'a').pos.x).toBeGreaterThan(nodeBox(model, 'hub').pos.x);
    expect(nodeBox(model, 'b').pos.x).toBeGreaterThan(nodeBox(model, 'hub').pos.x);
  });
});

describe('jmuir-dtu.26: align row/column', () => {
  it('align row shares a row; align column shares a column', () => {
    const model = parseOk(
      [
        'architecture-beta',
        '    service a(server)[A]',
        '    service b(server)[B]',
        '    service c(server)[C]',
        '    service d(server)[D]',
        '    service e(server)[E]',
        '    align row a b c',
        '    align column a d e',
        '',
      ].join('\n'),
    );
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id) => center(nodeBox(model, id)));
    expect(b.y).toBeCloseTo(a.y);
    expect(c.y).toBeCloseTo(a.y);
    expect(d.x).toBeCloseTo(a.x);
    expect(e.x).toBeCloseTo(a.x);
  });
});

describe('jmuir-dtu.26: general invariants', () => {
  it('no two siblings overlap, including disconnected services and junctions', () => {
    const model = parseOk(
      [
        'architecture-beta',
        '    group g(cloud)[G]',
        '    service a(server)[A] in g',
        '    service b(server)[B] in g',
        '    service c(database)[C]',
        '    service d(disk)[D]',
        '    service e(internet)[E]',
        '    service f(server)[F]',
        '    service h(server)[H]',
        '    junction j',
        '    a:R -- L:b',
        '    c:B -- T:d',
        '',
      ].join('\n'),
    );
    const topLevel: Box[] = [
      groupBox(model, 'g'),
      ...['c', 'd', 'e', 'f', 'h', 'j'].map((id) => nodeBox(model, id)),
    ];
    for (let i = 0; i < topLevel.length; i += 1) {
      for (let k = i + 1; k < topLevel.length; k += 1) {
        expect(overlaps(topLevel[i], topLevel[k]), `top-level items ${i} and ${k} overlap`).toBe(false);
      }
    }
    expect(overlaps(nodeBox(model, 'a'), nodeBox(model, 'b'))).toBe(false);
  });

  it('a diagram with stored geometry keeps it exactly', () => {
    const stored = [
      '---',
      'canvas:',
      '  positions:',
      '    db: { x: 500, y: 500 }',
      '    server: { x: 10, y: 20 }',
      '    disk1: { x: 30, y: 300 }',
      '    disk2: { x: 600, y: 300 }',
      '  containers:',
      '    api: { x: 0, y: 0, width: 900, height: 700 }',
      '---',
      DOCS_EXAMPLE,
    ].join('\n');
    const model = parseOk(stored);
    expect(model.nodes.find((n) => n.id === 'db')!.position).toEqual({ x: 500, y: 500 });
    expect(model.nodes.find((n) => n.id === 'server')!.position).toEqual({ x: 10, y: 20 });
    expect(model.containers.find((c) => c.id === 'api')!.size).toEqual({ width: 900, height: 700 });
  });

  it('serialize -> reparse after a fresh import is idempotent and keeps the computed geometry', () => {
    const model = parseOk(NESTED_EXAMPLE);
    const once = serializeArchitecture(model);
    const reparsed = parseOk(once);
    expect(serializeArchitecture(reparsed)).toBe(once);
    expect(reparsed.containers.find((c) => c.id === 'vpc')!.size).toEqual(model.containers.find((c) => c.id === 'vpc')!.size);
    expect(reparsed.nodes.find((n) => n.id === 'app')!.position).toEqual(model.nodes.find((n) => n.id === 'app')!.position);
  });
});
