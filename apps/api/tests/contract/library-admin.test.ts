import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { awsIconsManifest, genericShapesManifest, mermaidArchitectureIconsManifest, serializeFlowchart } from '@canvas/diagram-core';
import { buildTestApp, closeTestDb, resetDatabase, seedDiagramType, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';
import { getDb } from '../../src/db/client.js';
import { ingestLibrary } from '../../src/libraries/library.service.js';
import { seedDiagramTypes } from '../../src/seed/diagram-types.seed.js';

/** Response bodies are loosely-typed JSON in these tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** canvas-3dq PR 1: admin management of icon/shape libraries (data + API + SVG/manifest import). */
const GV = genericShapesManifest.version;
const svgOf = (body = '<path d="M0 0h24v24H0z" fill="#123456"/>', box = '0 0 24 24') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${body}</svg>`;

describe('Admin icon libraries API (canvas-3dq)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let adminId: string;
  let projectId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie: string | null = adminCookie) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });

  const importSvg = async (name: string, icons: object[], license?: string) => call('POST', '/admin/libraries/import-svg', { name, license, icons });

  async function createLibrary(name = 'My Pack', icons: object[] = [{ fileName: 'Star.svg', svg: svgOf() }, { fileName: 'moon.svg', svg: svgOf() }]) {
    const response = await importSvg(name, icons);
    expect(response.statusCode).toBe(201);
    return response.json().library as { id: string; version: string };
  }

  async function seedBuiltin(): Promise<void> {
    await ingestLibrary(genericShapesManifest);
    await ingestLibrary(awsIconsManifest);
    await ingestLibrary(mermaidArchitectureIconsManifest);
  }

  async function makeDiagram(dsl: string, name = 'D'): Promise<string> {
    const response = await call('POST', `/projects/${projectId}/diagrams`, { name, diagramTypeId: 'flowchart', initialDslContent: dsl });
    expect(response.statusCode).toBe(201);
    return response.json().diagram.id;
  }
  const iconDsl = (libraryId: string, libraryVersion: string, iconId: string) =>
    serializeFlowchart({
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: 'Icon node', shape: 'icon', position: { x: 10, y: 10 }, icon: { libraryId, libraryVersion, iconId } }],
      edges: [],
      containers: [],
    });

  const adminList = async () => (await call('GET', '/admin/libraries')).json().libraries as Array<Record<string, Loose>>;
  const search = async (query = '', typeId = 'flowchart') => (await call('GET', `/icons/search?diagramTypeId=${typeId}&query=${query}`)).json().icons as Array<{ libraryId: string; id: string }>;
  const auditEvents = async () => (await call('GET', '/admin/audit?limit=200')).json().events as Array<{ event: string; detail: Record<string, Loose> | null }>;

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' });
    adminId = admin.id;
    projectId = (await seedProject('P', adminId)).id;
    adminCookie = await login('admin@example.com', 'admin-pass');
    architectCookie = await login('architect@example.com', 'architect-pass');
  });

  describe('access control', () => {
    const routes: Array<[string, 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['list', 'GET', '/admin/libraries'],
      ['icons', 'GET', '/admin/libraries/generic/1/icons'],
      ['usage', 'GET', '/admin/libraries/generic/1/usage'],
      ['import-svg', 'POST', '/admin/libraries/import-svg', { name: 'x', icons: [{ fileName: 'a.svg', svg: svgOf() }] }],
      ['import-manifest', 'POST', '/admin/libraries/import-manifest', { manifest: { id: 'x', version: '1', icons: [] } }],
      ['patch library', 'PATCH', `/admin/libraries/generic/${GV}`, { name: 'x' }],
      ['add icons', 'POST', '/admin/libraries/generic/1/icons', { icons: [{ fileName: 'a.svg', svg: svgOf() }] }],
      ['patch icon', 'PATCH', '/admin/libraries/generic/1/icons/a', { displayName: 'x' }],
      ['retire library', 'POST', `/admin/libraries/generic/${GV}/retire`],
      ['restore library', 'POST', `/admin/libraries/generic/${GV}/restore`],
      ['retire icon', 'POST', '/admin/libraries/generic/1/icons/a/retire'],
      ['restore icon', 'POST', '/admin/libraries/generic/1/icons/a/restore'],
      ['delete library', 'DELETE', `/admin/libraries/generic/${GV}`],
      ['delete icon', 'DELETE', '/admin/libraries/generic/1/icons/a'],
      ['palette', 'PUT', '/admin/libraries/generic/diagram-types', { diagramTypeIds: [] }],
    ];
    it.each(routes)('%s is admin only', async (_n, method, url, payload) => {
      expect((await call(method, url, payload, architectCookie)).statusCode).toBe(403);
      expect((await call(method, url, payload, null)).statusCode).toBe(401);
    });
  });

  describe('import-svg', () => {
    it('creates a custom library with a slug id, version 1, named icons and fitted artwork', async () => {
      const response = await importSvg('My Cool Pack!', [
        { fileName: 'cloud-storage_v2.svg', svg: svgOf() },
        { fileName: 'Other.svg', svg: svgOf(), displayName: 'Custom', category: 'Net', keywords: ['a', ' b '] },
      ], 'MIT');
      expect(response.statusCode).toBe(201);
      const { library, rejected } = response.json();
      expect(rejected).toEqual([]);
      expect(library).toMatchObject({ id: 'my-cool-pack', version: '1', name: 'My Cool Pack!', origin: 'custom', license: 'MIT', iconCount: 2, retiredIconCount: 0 });

      const icons = (await call('GET', '/admin/libraries/my-cool-pack/1/icons')).json().icons;
      const byId = Object.fromEntries(icons.map((i: Loose) => [i.id, i]));
      expect(byId['cloud-storage-v2'].displayName).toBe('Cloud storage v2');
      expect(byId['cloud-storage-v2'].category).toBe('General');
      expect(byId['cloud-storage-v2'].assetRef).toMatch(/<svg[^>]*width="48"[^>]*height="48"[^>]*viewBox="0 0 24 24"/);
      expect(byId['other']).toMatchObject({ displayName: 'Custom', category: 'Net', keywords: ['a', 'b'] });
    });

    it('de-duplicates the library id on a name clash and icon ids within a library', async () => {
      const first = await createLibrary('Same Name', [{ fileName: 'a.svg', svg: svgOf() }, { fileName: 'a.svg', svg: svgOf() }, { fileName: 'A.SVG', svg: svgOf() }]);
      const second = await createLibrary('Same Name');
      expect(first.id).toBe('same-name');
      expect(second.id).toBe('same-name-2');
      const icons = (await call('GET', '/admin/libraries/same-name/1/icons')).json().icons;
      expect(icons.map((i: Loose) => i.id).sort()).toEqual(['a', 'a-2', 'a-3']);
    });

    it('reports bad files in rejected while good ones import', async () => {
      const response = await importSvg('Mixed', [
        { fileName: 'good.svg', svg: svgOf() },
        { fileName: 'junk.svg', svg: 'not an svg at all' },
        { fileName: 'nosize.svg', svg: '<svg><path d="M0 0"/></svg>' },
      ]);
      expect(response.statusCode).toBe(201);
      const { library, rejected } = response.json();
      expect(library.iconCount).toBe(1);
      expect(rejected.map((r: Loose) => r.fileName).sort()).toEqual(['junk.svg', 'nosize.svg']);
      expect(rejected.every((r: Loose) => r.reason)).toBe(true);
    });

    it('400s when every file is bad and creates nothing', async () => {
      const response = await importSvg('Bad', [{ fileName: 'junk.svg', svg: 'nope' }]);
      expect(response.statusCode).toBe(400);
      expect(await adminList()).toEqual([]);
    });

    it('400s on a blank name and on an empty icon list', async () => {
      expect((await importSvg('   ', [{ fileName: 'a.svg', svg: svgOf() }])).statusCode).toBe(400);
      expect((await importSvg('Empty', [])).statusCode).toBe(400);
    });

    it('strips malicious content, and rejects a <style> file individually', async () => {
      const response = await importSvg('Evil', [
        {
          fileName: 'evil.svg',
          svg: svgOf('<script>alert(1)</script><path onload="x()" d="M0 0h5v5z"/><use href="https://evil.example/x.svg#a"/><image href="https://evil.example/p.png"/><foreignObject><div>hi</div></foreignObject>'),
        },
        { fileName: 'styled.svg', svg: svgOf('<style>.a{fill:red}</style><path class="a" d="M0 0h5v5z"/>') },
      ]);
      expect(response.statusCode).toBe(201);
      const { rejected } = response.json();
      expect(rejected.map((r: Loose) => r.fileName)).toEqual(['styled.svg']);
      expect(rejected[0].reason).toMatch(/style/i);
      const [icon] = (await call('GET', '/admin/libraries/evil/1/icons')).json().icons;
      expect(icon.assetRef).not.toMatch(/script|onload|evil\.example|foreignObject|<image|alert/i);
      expect(icon.assetRef).toContain('<path');
    });

    it('accepts a large payload (300 icons of ~20KB) past the default body limit', async () => {
      const path = `<path d="${'M0 0 L1 1 '.repeat(1900)}"/>`;
      const icons = Array.from({ length: 300 }, (_, i) => ({ fileName: `icon-${i}.svg`, svg: svgOf(path) }));
      expect(JSON.stringify(icons).length).toBeGreaterThan(5 * 1024 * 1024);
      const response = await importSvg('Big', icons);
      expect(response.statusCode).toBe(201);
      expect(response.json().library.iconCount).toBe(300);
    }, 60000);

    it('shows the imported icon in palette search once the library is added to a diagram type, and renders it in an export', async () => {
      const lib = await createLibrary('Searchable', [{ fileName: 'zebra-crossing.svg', svg: svgOf('<path d="M0 0h24v24H0z" fill="#abcdef"/>'), keywords: ['stripes'] }]);
      expect((await search('stripes')).map((i) => i.id)).toEqual([]);
      expect((await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart'] })).statusCode).toBe(204);
      const found = await search('stripes');
      expect(found.map((i) => `${i.libraryId}/${i.id}`)).toEqual(['searchable/zebra-crossing']);

      const diagramId = await makeDiagram(iconDsl(lib.id, lib.version, 'zebra-crossing'));
      const exported = await call('GET', `/diagrams/${diagramId}/export?format=svg`);
      expect(exported.statusCode).toBe(200);
      expect(exported.body).toContain('#abcdef');
    });
  });

  describe('import-manifest', () => {
    const manifest = (over: Record<string, unknown> = {}) => ({
      id: 'my-manifest',
      version: '2',
      license: 'CC0',
      icons: [{ id: 'one', displayName: 'One', category: 'X', keywords: ['k'], assetRef: '<g id="a"><path fill="url(#a)" d="M0 0h5v5z" onclick="x()"/></g><script>1</script>' }],
      ...over,
    });
    const importManifest = (m: unknown, name?: string) => call('POST', '/admin/libraries/import-manifest', { manifest: m, name });

    it('creates a custom library, applying strict sanitizing', async () => {
      const response = await importManifest(manifest(), 'Named');
      expect(response.statusCode).toBe(201);
      expect(response.json().library).toMatchObject({ id: 'my-manifest', version: '2', name: 'Named', origin: 'custom', license: 'CC0', iconCount: 1 });
      const [icon] = (await call('GET', '/admin/libraries/my-manifest/2/icons')).json().icons;
      expect(icon.keywords).toEqual(['k']);
      expect(icon.assetRef).not.toMatch(/script|onclick/i);
      expect(icon.assetRef).toContain('id="my-manifest-one-a"');
      expect(icon.assetRef).toContain('url(#my-manifest-one-a)');
    });

    it('409s for a built-in id and for a duplicate id+version', async () => {
      await seedBuiltin();
      expect((await importManifest(manifest({ id: 'generic' }))).statusCode).toBe(409);
      expect((await importManifest(manifest({ id: 'aws-icons', version: '99' }))).statusCode).toBe(409);
      expect((await importManifest(manifest())).statusCode).toBe(201);
      expect((await importManifest(manifest())).statusCode).toBe(409);
      expect((await importManifest(manifest({ version: '3' }))).statusCode).toBe(201);
    });

    it.each([
      ['uppercase id', { id: 'Bad Id' }],
      ['id with a slash', { id: 'a/b' }],
      ['invalid version', { version: 'v 1' }],
      ['empty icons', { icons: [] }],
      ['missing assetRef', { icons: [{ id: 'x' }] }],
      ['duplicate icon ids', { icons: [{ id: 'x', assetRef: '<path d="M0 0"/>' }, { id: 'x', assetRef: '<path d="M0 0"/>' }] }],
    ])('400s on %s', async (_n, over) => {
      expect((await importManifest(manifest(over))).statusCode).toBe(400);
    });

    it('400s when the manifest is not a library at all', async () => {
      expect((await importManifest({ nope: true })).statusCode).toBe(400);
    });
  });

  describe('list', () => {
    it('reports origin, counts, palette types, retired counts and usage', async () => {
      await seedDiagramType('cloud-infrastructure', 'architecture', 'Cloud Infrastructure');
      await seedBuiltin();
      const custom = await createLibrary('Mine');
      await call('PUT', `/admin/libraries/${custom.id}/diagram-types`, { diagramTypeIds: ['flowchart'] });
      await call('POST', `/admin/libraries/${custom.id}/1/icons/moon/retire`);

      const libs = await adminList();
      const generic = libs.find((l) => l.id === 'generic')!;
      expect(generic).toMatchObject({ origin: 'builtin', iconCount: genericShapesManifest.icons.length, retiredIconCount: 0, retiredAt: null, usedByDiagramCount: 0 });
      expect(generic.diagramTypes).toEqual([{ id: 'cloud-infrastructure', name: 'Cloud Infrastructure' }, { id: 'flowchart', name: 'Generic Flowchart' }]);
      expect(libs.find((l) => l.id === 'aws-icons')!.origin).toBe('builtin');
      expect(libs.find((l) => l.id === 'mine')).toMatchObject({ origin: 'custom', name: 'Mine', iconCount: 2, retiredIconCount: 1, version: '1' });
    });

    it('counts diagrams by front-matter icon refs and by architecture built-in icon syntax, ignoring deleted diagrams', async () => {
      await seedDiagramType('cloud-infrastructure', 'architecture', 'Cloud Infrastructure');
      await seedBuiltin();
      const custom = await createLibrary('Mine');
      const flow = await makeDiagram(iconDsl(custom.id, '1', 'star'), 'uses star');
      await makeDiagram(iconDsl(custom.id, '1', 'moon'), 'uses moon');
      const gone = await makeDiagram(iconDsl(custom.id, '1', 'moon'), 'deleted one');
      await call('POST', `/projects/${projectId}/diagrams`, {
        name: 'arch',
        diagramTypeId: 'cloud-infrastructure',
        initialDslContent: 'architecture-beta\n    service db(database)[DB]\n    service s(server)[S]\n',
      });
      expect((await call('DELETE', `/diagrams/${gone}`)).statusCode).toBe(204);

      const libs = await adminList();
      expect(libs.find((l) => l.id === 'mine')!.usedByDiagramCount).toBe(2);
      expect(libs.find((l) => l.id === mermaidArchitectureIconsManifest.id)!.usedByDiagramCount).toBe(1);

      const icons = (await call('GET', '/admin/libraries/mine/1/icons')).json().icons;
      expect(Object.fromEntries(icons.map((i: Loose) => [i.id, i.usedByDiagramCount]))).toEqual({ star: 1, moon: 1 });
      const usage = (await call('GET', '/admin/libraries/mine/1/usage?iconId=star')).json().diagrams;
      expect(usage).toEqual([{ id: flow, name: 'uses star', projectId }]);
      expect((await call('GET', '/admin/libraries/mine/1/usage')).json().diagrams).toHaveLength(2);
    });

    it('404s for an unknown library', async () => {
      expect((await call('GET', '/admin/libraries/nope/1/icons')).statusCode).toBe(404);
      expect((await call('GET', '/admin/libraries/nope/1/usage')).statusCode).toBe(404);
    });
  });

  describe('editing', () => {
    it('renames a custom library and sets/clears its license', async () => {
      const lib = await createLibrary('Old');
      expect((await call('PATCH', `/admin/libraries/${lib.id}/1`, { name: ' New Name ', license: 'Apache' })).statusCode).toBe(204);
      expect(await adminList()).toEqual([expect.objectContaining({ name: 'New Name', license: 'Apache' })]);
      await call('PATCH', `/admin/libraries/${lib.id}/1`, { license: null });
      expect((await adminList())[0]).toMatchObject({ name: 'New Name', license: null });
      expect((await call('PATCH', `/admin/libraries/${lib.id}/1`, { name: '  ' })).statusCode).toBe(400);
    });

    it('refuses to edit built-in libraries and icons', async () => {
      await seedBuiltin();
      expect((await call('PATCH', `/admin/libraries/generic/${GV}`, { name: 'x' })).statusCode).toBe(400);
      const iconId = genericShapesManifest.icons[0].id;
      expect((await call('PATCH', `/admin/libraries/generic/${genericShapesManifest.version}/icons/${iconId}`, { displayName: 'x' })).statusCode).toBe(400);
      expect((await call('POST', `/admin/libraries/generic/${genericShapesManifest.version}/icons`, { icons: [{ fileName: 'a.svg', svg: svgOf() }] })).statusCode).toBe(400);
    });

    it('404s editing an unknown library or icon', async () => {
      const lib = await createLibrary();
      expect((await call('PATCH', '/admin/libraries/nope/1', { name: 'x' })).statusCode).toBe(404);
      expect((await call('PATCH', `/admin/libraries/${lib.id}/1/icons/nope`, { displayName: 'x' })).statusCode).toBe(404);
    });

    it('edits icon displayName/category/keywords without touching sibling icons keywords', async () => {
      const lib = await createLibrary('Kw', [{ fileName: 'a.svg', svg: svgOf(), keywords: ['alpha'] }, { fileName: 'b.svg', svg: svgOf(), keywords: ['beta'] }]);
      expect((await call('PATCH', `/admin/libraries/${lib.id}/1/icons/a`, { displayName: 'Renamed', category: ' Shapes ', keywords: ['x', ' y ', ''] })).statusCode).toBe(204);
      const icons = Object.fromEntries((await call('GET', `/admin/libraries/${lib.id}/1/icons`)).json().icons.map((i: Loose) => [i.id, i]));
      expect(icons.a).toMatchObject({ displayName: 'Renamed', category: 'Shapes', keywords: ['x', 'y'] });
      expect(icons.b.keywords).toEqual(['beta']);
      expect((await call('PATCH', `/admin/libraries/${lib.id}/1/icons/a`, { displayName: ' ' })).statusCode).toBe(400);
    });

    it('re-sanitizes and re-fits replacement artwork', async () => {
      const lib = await createLibrary();
      const response = await call('PATCH', `/admin/libraries/${lib.id}/1/icons/star`, { svg: svgOf('<path d="M0 0h5v5z" onclick="x()"/><script>1</script>', '0 0 100 50') });
      expect(response.statusCode).toBe(204);
      const star = (await call('GET', `/admin/libraries/${lib.id}/1/icons`)).json().icons.find((i: Loose) => i.id === 'star');
      expect(star.assetRef).toContain('viewBox="0 0 100 50"');
      expect(star.assetRef).not.toMatch(/script|onclick/);
      expect((await call('PATCH', `/admin/libraries/${lib.id}/1/icons/star`, { svg: 'garbage' })).statusCode).toBe(400);
    });

    it('adds icons to a custom library, de-duplicating ids and reporting rejects', async () => {
      const lib = await createLibrary();
      const response = await call('POST', `/admin/libraries/${lib.id}/1/icons`, {
        icons: [{ fileName: 'star.svg', svg: svgOf() }, { fileName: 'sun.svg', svg: svgOf(), keywords: ['hot'] }, { fileName: 'bad.svg', svg: 'x' }],
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ added: ['star-2', 'sun'], rejected: [{ fileName: 'bad.svg' }] });
      const icons = (await call('GET', `/admin/libraries/${lib.id}/1/icons`)).json().icons;
      expect(icons).toHaveLength(4);
      expect(icons.find((i: Loose) => i.id === 'sun').keywords).toEqual(['hot']);
      expect((await call('POST', `/admin/libraries/${lib.id}/1/icons`, { icons: [{ fileName: 'bad.svg', svg: 'x' }] })).statusCode).toBe(400);
    });
  });

  describe('retire / restore', () => {
    it('hides a retired icon from search and the versions listing but still resolves it in exports; restore brings it back', async () => {
      const lib = await createLibrary('Ret', [{ fileName: 'keep.svg', svg: svgOf() }, { fileName: 'hide.svg', svg: svgOf('<path d="M0 0h9v9z" fill="#fedcba"/>') }]);
      await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart'] });
      const diagramId = await makeDiagram(iconDsl(lib.id, '1', 'hide'));

      expect((await call('POST', `/admin/libraries/${lib.id}/1/icons/hide/retire`)).statusCode).toBe(204);
      expect((await search()).map((i) => i.id)).toEqual(['keep']);
      const listed = (await call('GET', `/libraries/${lib.id}/versions/1/icons`)).json().icons;
      expect(listed.map((i: Loose) => i.id)).toEqual(['keep']);
      const adminIcons = (await call('GET', `/admin/libraries/${lib.id}/1/icons`)).json().icons;
      expect(adminIcons.find((i: Loose) => i.id === 'hide').retiredAt).toBeTruthy();
      expect((await adminList())[0].retiredIconCount).toBe(1);
      expect((await call('GET', `/diagrams/${diagramId}/export?format=svg`)).body).toContain('#fedcba');

      expect((await call('POST', `/admin/libraries/${lib.id}/1/icons/hide/restore`)).statusCode).toBe(204);
      expect((await search()).map((i) => i.id).sort()).toEqual(['hide', 'keep']);
      expect((await adminList())[0].retiredIconCount).toBe(0);
    });

    it('hides a retired library everywhere but exports still render; works on built-ins; restore reverses', async () => {
      await seedBuiltin();
      const lib = await createLibrary('Gone', [{ fileName: 'x.svg', svg: svgOf('<path d="M0 0h9v9z" fill="#112233"/>') }]);
      await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart'] });
      const diagramId = await makeDiagram(iconDsl(lib.id, '1', 'x'));
      expect((await search()).map((i) => i.libraryId)).toContain('gone');

      expect((await call('POST', `/admin/libraries/${lib.id}/1/retire`)).statusCode).toBe(204);
      expect((await call('POST', `/admin/libraries/generic/${GV}/retire`)).statusCode).toBe(204);
      expect(await search()).toEqual([]);
      expect((await call('GET', `/libraries/${lib.id}/versions/1/icons`)).json().icons).toEqual([]);
      expect((await call('GET', `/diagrams/${diagramId}/export?format=svg`)).body).toContain('#112233');
      const libs = await adminList();
      expect(libs.find((l) => l.id === 'gone')!.retiredAt).toBeTruthy();
      expect(libs.find((l) => l.id === 'generic')!.retiredAt).toBeTruthy();

      await call('POST', `/admin/libraries/${lib.id}/1/restore`);
      await call('POST', `/admin/libraries/generic/${GV}/restore`);
      expect((await search()).length).toBeGreaterThan(1);
      expect((await adminList()).every((l) => l.retiredAt === null)).toBe(true);
    });

    it('404s retiring an unknown library or icon', async () => {
      const lib = await createLibrary();
      expect((await call('POST', '/admin/libraries/nope/1/retire')).statusCode).toBe(404);
      expect((await call('POST', `/admin/libraries/${lib.id}/1/icons/nope/retire`)).statusCode).toBe(404);
    });

    it('re-ingesting a built-in manifest (the seed on each deploy) neither un-retires nor changes origin or display name', async () => {
      await seedBuiltin();
      const iconId = awsIconsManifest.icons[0].id;
      await call('POST', `/admin/libraries/aws-icons/${awsIconsManifest.version}/retire`);
      await call('POST', `/admin/libraries/aws-icons/${awsIconsManifest.version}/icons/${iconId}/retire`);
      await getDb().updateTable('icon_libraries').set({ display_name: 'Renamed in DB' }).where('id', '=', 'aws-icons').execute();

      await ingestLibrary(awsIconsManifest);
      await ingestLibrary(awsIconsManifest, { origin: 'custom', displayName: 'Hijack' });

      const aws = (await adminList()).find((l) => l.id === 'aws-icons')!;
      expect(aws).toMatchObject({ origin: 'builtin', name: 'Renamed in DB' });
      expect(aws.retiredAt).toBeTruthy();
      expect(aws.retiredIconCount).toBe(1);
    });
  });

  describe('delete', () => {
    it('deletes an unused custom library with its icons, keywords and palette rows', async () => {
      const lib = await createLibrary('Del', [{ fileName: 'a.svg', svg: svgOf(), keywords: ['kw'] }]);
      await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart'] });
      expect((await call('DELETE', `/admin/libraries/${lib.id}/1`)).statusCode).toBe(204);
      const db = getDb();
      expect(await db.selectFrom('icon_libraries').select('id').where('id', '=', lib.id).execute()).toEqual([]);
      expect(await db.selectFrom('icons').select('id').where('library_id', '=', lib.id).execute()).toEqual([]);
      expect(await db.selectFrom('icon_keywords').select('icon_id').where('library_id', '=', lib.id).execute()).toEqual([]);
      expect(await db.selectFrom('diagram_type_palette_libraries').select('library_id').where('library_id', '=', lib.id).execute()).toEqual([]);
      expect((await call('DELETE', `/admin/libraries/${lib.id}/1`)).statusCode).toBe(404);
    });

    it('keeps palette rows while another version of the library remains', async () => {
      await seedBuiltin();
      const manifest = { id: 'multi', version: '1', icons: [{ id: 'a', assetRef: '<path d="M0 0h5v5z"/>' }] };
      await call('POST', '/admin/libraries/import-manifest', { manifest });
      await call('POST', '/admin/libraries/import-manifest', { manifest: { ...manifest, version: '2' } });
      await call('PUT', '/admin/libraries/multi/diagram-types', { diagramTypeIds: ['flowchart'] });
      expect((await call('DELETE', '/admin/libraries/multi/1')).statusCode).toBe(204);
      expect((await adminList()).find((l) => l.id === 'multi')!.diagramTypes).toHaveLength(1);
      expect((await call('DELETE', '/admin/libraries/multi/2')).statusCode).toBe(204);
      const rows = await getDb().selectFrom('diagram_type_palette_libraries').select('library_id').where('library_id', '=', 'multi').execute();
      expect(rows).toEqual([]);
    });

    it('409s with the diagrams listed when the library or an icon is in use', async () => {
      const lib = await createLibrary();
      const diagramId = await makeDiagram(iconDsl(lib.id, '1', 'star'), 'Uses it');
      const library = await call('DELETE', `/admin/libraries/${lib.id}/1`);
      expect(library.statusCode).toBe(409);
      expect(library.json()).toMatchObject({ code: 'in_use', diagrams: [{ id: diagramId, name: 'Uses it', projectId }] });
      const icon = await call('DELETE', `/admin/libraries/${lib.id}/1/icons/star`);
      expect(icon.statusCode).toBe(409);
      expect(icon.json().code).toBe('in_use');
      expect((await call('DELETE', `/admin/libraries/${lib.id}/1/icons/moon`)).statusCode).toBe(204);
      expect((await call('GET', `/admin/libraries/${lib.id}/1/icons`)).json().icons.map((i: Loose) => i.id)).toEqual(['star']);
    });

    it('refuses to delete built-in libraries and icons', async () => {
      await seedBuiltin();
      expect((await call('DELETE', `/admin/libraries/generic/${GV}`)).statusCode).toBe(400);
      expect((await call('DELETE', `/admin/libraries/generic/${genericShapesManifest.version}/icons/${genericShapesManifest.icons[0].id}`)).statusCode).toBe(400);
    });
  });

  describe('palette', () => {
    it('adds and removes a library from diagram types, appending positions', async () => {
      await seedDiagramType('erd', 'erd', 'ERD');
      const lib = await createLibrary();
      const positions = async (type: string) =>
        (await getDb().selectFrom('diagram_type_palette_libraries').select(['library_id', 'position']).where('diagram_type_id', '=', type).orderBy('position').execute());

      expect((await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart', 'erd'] })).statusCode).toBe(204);
      expect(await positions('flowchart')).toEqual([{ library_id: 'generic', position: 0 }, { library_id: lib.id, position: 1 }]);
      expect((await adminList())[0].diagramTypes.map((t: Loose) => t.id).sort()).toEqual(['erd', 'flowchart']);

      // Idempotent re-put leaves positions alone.
      await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart', 'erd'] });
      expect(await positions('flowchart')).toHaveLength(2);

      await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['erd'] });
      expect(await positions('flowchart')).toEqual([{ library_id: 'generic', position: 0 }]);
      expect((await adminList())[0].diagramTypes.map((t: Loose) => t.id)).toEqual(['erd']);
    });

    it('400s on an unknown diagram type and 404s on an unknown library, changing nothing', async () => {
      const lib = await createLibrary();
      expect((await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart', 'no-such-type'] })).statusCode).toBe(400);
      expect((await adminList())[0].diagramTypes).toEqual([]);
      expect((await call('PUT', '/admin/libraries/nope/diagram-types', { diagramTypeIds: [] })).statusCode).toBe(404);
    });

    it('marks changed built-in diagram types admin_edited so the seed stops resetting them (custom types untouched)', async () => {
      await seedDiagramTypes();
      await getDb().insertInto('diagram_types').values({ id: 'my-custom', name: 'Custom', abstraction_level: 'N/A', dsl_family: 'flowchart', origin: 'custom' }).execute();
      const lib = await createLibrary();
      await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['erd', 'my-custom'] });
      const edited = async (id: string) => Boolean((await getDb().selectFrom('diagram_types').select('admin_edited').where('id', '=', id).executeTakeFirstOrThrow()).admin_edited);
      expect(await edited('erd')).toBe(true);
      expect(await edited('my-custom')).toBe(false);
      expect(await edited('uml')).toBe(false);

      await seedDiagramTypes();
      expect((await adminList())[0].diagramTypes.map((t: Loose) => t.id)).toContain('erd');
    });
  });

  describe('audit', () => {
    it('records icon_library_changed with the right action for each change', async () => {
      const lib = await createLibrary('Aud');
      await call('POST', '/admin/libraries/import-manifest', { manifest: { id: 'from-manifest', version: '1', icons: [{ id: 'a', assetRef: '<path d="M0 0h5v5z"/>' }] } });
      await call('PATCH', `/admin/libraries/${lib.id}/1`, { name: 'Aud2' });
      await call('POST', `/admin/libraries/${lib.id}/1/icons`, { icons: [{ fileName: 'new.svg', svg: svgOf() }] });
      await call('PATCH', `/admin/libraries/${lib.id}/1/icons/new`, { svg: svgOf() });
      await call('POST', `/admin/libraries/${lib.id}/1/icons/new/retire`);
      await call('POST', `/admin/libraries/${lib.id}/1/icons/new/restore`);
      await call('POST', `/admin/libraries/${lib.id}/1/retire`);
      await call('POST', `/admin/libraries/${lib.id}/1/restore`);
      await call('PUT', `/admin/libraries/${lib.id}/diagram-types`, { diagramTypeIds: ['flowchart'] });
      await call('DELETE', `/admin/libraries/${lib.id}/1/icons/new`);
      await call('DELETE', `/admin/libraries/${lib.id}/1`);

      const events = (await auditEvents()).filter((e) => e.event === 'icon_library_changed').map((e) => e.detail!);
      const actions = events.map((d) => d.action);
      expect(actions.sort()).toEqual(
        ['imported', 'imported', 'updated', 'icons_added', 'icon_updated', 'icon_retired', 'icon_restored', 'retired', 'restored', 'palette_set', 'icon_deleted', 'deleted'].sort(),
      );
      expect(events.find((d) => d.action === 'imported' && d.from === 'svg')).toMatchObject({ libraryId: lib.id, icons: 2 });
      expect(events.find((d) => d.action === 'imported' && d.from === 'manifest')).toMatchObject({ libraryId: 'from-manifest' });
      expect(events.find((d) => d.action === 'icon_updated')).toMatchObject({ iconId: 'new', replacedArtwork: true });
      expect(events.find((d) => d.action === 'palette_set')).toMatchObject({ diagramTypeIds: ['flowchart'] });
    });

    it('does not audit failed or forbidden changes', async () => {
      await call('DELETE', '/admin/libraries/nope/1');
      await call('POST', '/admin/libraries/import-svg', { name: 'x', icons: [{ fileName: 'a.svg', svg: svgOf() }] }, architectCookie);
      expect((await auditEvents()).filter((e) => e.event === 'icon_library_changed')).toEqual([]);
    });
  });
});
