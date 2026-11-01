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
