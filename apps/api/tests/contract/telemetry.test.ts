import { SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSpan } from '../../src/telemetry/telemetry.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-6upe: what the API puts in its traces. Production exports to Application Insights; here an
 * in-memory exporter stands in, and each request runs inside a parent span the way the http
 * instrumentation's server span wraps a real one.
 */
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

describe('telemetry', () => {
  let app: FastifyInstance;
  let cookie: string;
  let diagramId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
    await provider.shutdown();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const user = await seedUser({ email: 'secret.person@example.com', password: 'pw-123456', role: 'architect' }); // gitleaks:allow
    const projectId = (await seedProject('P', user.id)).id;
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'secret.person@example.com', password: 'pw-123456' } }); // gitleaks:allow
    cookie = String(login.headers['set-cookie']).split(';')[0];
    const created = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie },
      payload: { name: 'Secret plans', diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Very secret label]\n' },
    });
    diagramId = created.json().diagram.id;
    exporter.reset();
  });

  const asRequest = <T>(fn: () => Promise<T>) => trace.getTracer('test').startActiveSpan('HTTP GET', async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });

  it('names the request after its route, says whose it was, and times each SQL query under it', async () => {
    const res = await asRequest(() => app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie } }));
    expect(res.statusCode).toBe(200);
    const spans = exporter.getFinishedSpans();
    const request = spans.find((s) => s.name === 'GET /diagrams/:id')!;
    expect(request).toBeDefined();
    expect(request.attributes['http.route']).toBe('/diagrams/:id');
    expect(request.attributes['enduser.role']).toBe('architect');
    expect(typeof request.attributes['enduser.id']).toBe('string');

    const queries = spans.filter((s) => s.attributes['db.query.text'] !== undefined);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
  });

  it('never puts diagram content, names, emails or query values in a span', async () => {
    await asRequest(() => app.inject({ method: 'GET', url: `/diagrams/${diagramId}`, headers: { cookie } }));
    await asRequest(() => app.inject({ method: 'GET', url: `/diagrams/${diagramId}/export?format=svg`, headers: { cookie } }));
    const everything = JSON.stringify(exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes })));
    for (const secret of ['Very secret label', 'Secret plans', 'secret.person@example.com', diagramId]) {
      expect(everything).not.toContain(secret);
    }
    expect(exporter.getFinishedSpans().some((s) => s.name === 'render svg' && s.attributes['canvas.diagram.family'] === 'flowchart')).toBe(true);
  });

  it('withSpan marks a failure and still rethrows it', async () => {
    await expect(withSpan('boom', {}, () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    const span = exporter.getFinishedSpans().find((s) => s.name === 'boom')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});
