import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/** canvas-ltk: a visible legend appears in SVG/PNG exports, with its automatic entries from the
 *  diagram type's active standard; no legend, nothing drawn. */
const STANDARD = {
  name: 'Order process rules',
  description: 'Steps for order flows.',
  elementKinds: [{ id: 'step', label: 'Process step', shapes: ['rectangle'], approvedFills: ['#dbeafe'] }],
  connectorRules: [{ id: 'flow', label: 'Hand-off', from: '*', to: '*' }],
};
const BODY = 'flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n';
const WITH_LEGEND = `---\ncanvas:\n  legend:\n    visible: true\n    title: Key\n---\n${BODY}`;

describe('Diagram export: legend (canvas-ltk)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let projectId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' }); // gitleaks:allow
    projectId = (await seedProject('Legend project', admin.id)).id;
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } }); // gitleaks:allow
    cookie = String(login.headers['set-cookie']).split(';')[0];
  });

  const createDiagram = async (dsl: string) => {
    const res = await app.inject({ method: 'POST', url: `/projects/${projectId}/diagrams`, headers: { cookie }, payload: { name: 'Orders', diagramTypeId: 'flowchart', initialDslContent: dsl } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().diagram.id as string;
  };
  const exportSvg = async (id: string) => (await app.inject({ method: 'GET', url: `/diagrams/${id}/export?format=svg`, headers: { cookie } })).body;
  async function publishStandard() {
    const created = await app.inject({ method: 'POST', url: '/diagram-types/flowchart/standards', headers: { cookie }, payload: STANDARD });
    expect(created.statusCode, created.body).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/standards/${created.json().standard.id}/publish`, headers: { cookie } })).statusCode).toBe(200);
  }

  it('draws the legend with the standard\'s element kinds and connector rules', async () => {
    await publishStandard();
    const svg = await exportSvg(await createDiagram(WITH_LEGEND));
    expect(svg).toContain('class="legend"');
    for (const text of ['Key', 'Process step', 'Hand-off']) expect(svg).toContain(`>${text}<`);
  });

  it('without a standard, a visible legend with no entries of its own draws nothing', async () => {
    expect(await exportSvg(await createDiagram(WITH_LEGEND))).not.toContain('class="legend"');
  });

  it('no legend in the diagram, no legend in the export', async () => {
    await publishStandard();
    expect(await exportSvg(await createDiagram(BODY))).not.toContain('class="legend"');
  });

  it('PNG export renders with a legend', async () => {
    await publishStandard();
    const res = await app.inject({ method: 'GET', url: `/diagrams/${await createDiagram(WITH_LEGEND)}/export?format=png`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
  });

  // Defence in depth: an export opened directly in the browser can't run script.
  it('sends every export format with a locked-down, sandboxed Content-Security-Policy', async () => {
    const id = await createDiagram(BODY);
    for (const format of ['svg', 'png', 'mermaid']) {
      const res = await app.inject({ method: 'GET', url: `/diagrams/${id}/export?format=${format}`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});
