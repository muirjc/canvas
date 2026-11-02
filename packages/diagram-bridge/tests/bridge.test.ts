import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridgeServer } from '../src/server.js';

/** canvas-1bty.4: the HTTP surface. The full corpus runs through it from the Python side. */
describe('diagram-core bridge', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createBridgeServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = async (op: string, body: unknown) => {
    const res = await fetch(`${base}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('makes a new diagram\'s starting DSL and compiles intake templates (canvas-1bty.8)', async () => {
    const empty = (await post('empty-dsl', { family: 'c4', diagramTypeId: 'c4-context' })).json.dsl as string;
    expect(empty).toContain('C4Context');
    expect((await post('parse', { family: 'c4', dsl: empty })).json).toHaveProperty('model');
    expect((await post('compile-template', { diagramTypeId: 'no-such-type', template: '# x' })).json).toEqual({ unsupported: true });
    expect((await post('compile-template', { diagramTypeId: 'c4-context', template: 'nothing useful' })).json).toHaveProperty('errors');
  });

  it('cleans uploaded SVG files and strictly checks manifest artwork (canvas-1bty.14)', async () => {
    const svg = (body: string, box = '0 0 24 24') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${body}</svg>`;
    const items = [
      { svg: svg('<path d="M0 0h5v5z" onclick="x()"/><script>1</script>'), idPrefix: 'lib-a' },
      { svg: 'not an svg at all', idPrefix: 'lib-b' },
      { svg: svg('<style>.a{fill:red}</style><path class="a" d="M0 0h5v5z"/>'), idPrefix: 'lib-c' },
    ];
    const prepared = (await post('svg-prepare', { items })).json.results as { ok: boolean; assetRef?: string; error?: string }[];
    expect(prepared.map((r) => r.ok)).toEqual([true, false, false]);
    expect(prepared[0].assetRef).toMatch(/width="48"[^>]*height="48"[^>]*viewBox="0 0 24 24"/);
    expect(prepared[0].assetRef).not.toMatch(/script|onclick/);
    expect(prepared[1].error).toBeTruthy();
    expect(prepared[2].error).toMatch(/style/i);

    const strict = (await post('svg-sanitize-strict', { items: [
      { svg: '<g id="a"><path fill="url(#a)" d="M0 0h5v5z" onclick="x()"/></g><script>1</script>', idPrefix: 'my-one' },
      { svg: '<style>.a{}</style>', idPrefix: 'my-two' },
    ] })).json.results as { ok: boolean; assetRef?: string }[];
    expect(strict[0].ok).toBe(true);
    expect(strict[0].assetRef).toContain('id="my-one-a"');
    expect(strict[0].assetRef).toContain('url(#my-one-a)');
    expect(strict[0].assetRef).not.toMatch(/script|onclick/);
    expect(strict[1].ok).toBe(false);

    expect((await post('svg-prepare', { items: [] })).json).toEqual({ results: [] });
    expect((await post('svg-prepare', { items: [{ svg: 1, idPrefix: 'x' }] })).status).toBe(400);
    expect((await post('svg-sanitize-strict', { items: [{ svg: '<g/>' }] })).status).toBe(400);
    expect((await post('svg-prepare', {})).status).toBe(400);
  });

  it('validates and normalizes a library manifest, reporting problems as data (canvas-1bty.14)', async () => {
    const ok = (await post('load-library', { manifest: { id: 'x', version: '1', license: 'MIT', icons: [{ id: 'a', displayName: 'A', keywords: ['k'], category: 'C', assetRef: '<path d="M0 0h5v5z" onclick="x()"/>' }] } })).json as {
      ok: boolean;
      library: { id: string; version: string; license?: string; icons: { id: string; libraryId: string; assetRef: string }[] };
    };
    expect(ok.ok).toBe(true);
    expect(ok.library).toMatchObject({ id: 'x', version: '1', license: 'MIT' });
    expect(ok.library.icons[0]).toMatchObject({ id: 'a', libraryId: 'x' });
    expect(ok.library.icons[0].assetRef).not.toContain('onclick');

    expect((await post('load-library', { manifest: { id: 'x', icons: [] } })).json).toEqual({ ok: false, error: 'Library manifest requires both id and version' });
    const dup = { id: 'x', version: '1', icons: [{ id: 'a', assetRef: '<g/>' }, { id: 'a', assetRef: '<g/>' }] };
    expect((await post('load-library', { manifest: dup })).json).toEqual({ ok: false, error: 'Duplicate icon id "a" in library x@1' });
    expect((await post('load-library', {})).status).toBe(400);
  });

  it('lists the icons each diagram uses, null for one that does not parse (canvas-1bty.14)', async () => {
    const iconDsl = '---\ncanvas:\n  positions: {A: {x: 1, y: 1}}\n  icons:\n    A: {libraryId: mine, libraryVersion: "1", iconId: star}\n---\nflowchart TD\n  A[Icon node]\n';
    const refs = (await post('icon-refs', { diagrams: [
      { family: 'flowchart', dsl: iconDsl },
      { family: 'flowchart', dsl: 'flowchart TD\n  A --> B\n' },
      { family: 'flowchart', dsl: 'flowchart TD\n  A -->\n' },
      { family: 'architecture', dsl: 'architecture-beta\n    service db(database)[DB]\n' },
    ] })).json.refs as unknown[];
    expect(refs[0]).toEqual([{ libraryId: 'mine', libraryVersion: '1', iconId: 'star' }]);
    expect(refs[1]).toEqual([]);
    expect(refs[2]).toBeNull();
    expect(refs[3]).toEqual([{ libraryId: 'mermaid-architecture', libraryVersion: '1.0.0', iconId: 'database' }]);
    expect((await post('icon-refs', { diagrams: [{ family: 'gantt', dsl: 'x' }] })).json).toEqual({ refs: [null] });
    expect((await post('icon-refs', { diagrams: [{ family: 'flowchart' }] })).status).toBe(400);
  });

  it('answers /health', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
  });

  it('parses, serializes, validates and renders', async () => {
    const dsl = 'flowchart TD\n  A[Start] --> B[End]\n';
    expect((await post('detect', { dsl })).json).toEqual({ family: 'flowchart' });
    const parsed = await post('parse', { family: 'flowchart', dsl });
    expect(parsed.status).toBe(200);
    const model = parsed.json.model;
    const out = (await post('serialize', { family: 'flowchart', model })).json.dsl as string;
    expect(out).toContain('A[Start]');
    expect(out).toContain('A --> B');
    expect((await post('validate', { model, rules: { allowedShapeIds: ['diamond'] } })).json.violations).not.toEqual([]);
    const svg = (await post('render-svg', { model, background: '#ffffff' })).json.svg as string;
    expect(svg).toMatch(/^<svg [^>]*><rect width="100%"/);
    expect((await post('detect-and-parse', { dsl })).json).toMatchObject({ family: 'flowchart' });
  });

  it('draws the icon artwork the caller sends', async () => {
    const parsed = await post('parse', { family: 'flowchart', dsl: 'flowchart TD\n  A[Web]\n' });
    const model = parsed.json.model as { nodes: { shape: string; icon?: unknown }[] };
    model.nodes[0].shape = 'icon';
    model.nodes[0].icon = { libraryId: 'lib', libraryVersion: '1', iconId: 'web' };
    const svg = (await post('render-svg', { model, icons: { 'lib@1@web': '<circle data-probe="icon" r="4"/>' } })).json.svg as string;
    expect(svg).toContain('data-probe="icon"');
  });

  it('reports parse errors as data, not as a failure', async () => {
    const res = await post('parse', { family: 'flowchart', dsl: 'flowchart TD\n  A -->\n' });
    expect(res.status).toBe(200);
    expect(res.json.errors).toBeDefined();
  });

  it.each([
    ['unknown operation', 'nope', {}, 404],
    ['not JSON', 'parse', '{not json', 400],
    ['not an object', 'parse', '[1,2]', 400],
    ['missing field', 'parse', { family: 'flowchart' }, 400],
    ['unknown family', 'parse', { family: 'gantt', dsl: 'x' }, 400],
    ['prototype key as an operation', '__proto__', {}, 404],
  ])('%s -> %i', async (_name, op, body, status) => {
    expect((await post(op, body)).status).toBe(status);
  });

  it('refuses a body over 10 MB', async () => {
    const res = await fetch(`${base}/portable`, { method: 'POST', body: JSON.stringify({ dsl: 'x'.repeat(11 * 1024 * 1024) }) }).catch(() => null);
    // Either a 413 or the connection is closed mid-upload; never a 200.
    expect(res === null || res.status === 413).toBe(true);
  });
});
