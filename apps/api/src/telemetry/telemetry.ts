import { context, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import type { LogEvent } from 'kysely';

/**
 * canvas-6upe: small helpers the app uses to describe its own work in traces. All are no-ops when
 * telemetry is off (the OpenTelemetry API then hands out non-recording spans).
 */
const tracer = trace.getTracer('canvas-api');

/** Names the current request after its route template (`GET /diagrams/:id`), for the span and for
 *  the request-duration metric, so timings group by route rather than by concrete URL. */
export function tagRequestRoute(method: string, route: string | undefined): void {
  if (!route) return;
  const span = trace.getActiveSpan();
  span?.setAttribute('http.route', route);
  span?.updateName(`${method} ${route}`);
  const rpc = getRPCMetadata(context.active());
  if (rpc?.type === RPCType.HTTP) rpc.route = route;
}

/** Who made the request: an opaque user id and their role (never their email). */
export function tagRequestUser(user: { id: string; role: string } | undefined): void {
  if (!user) return;
  const span = trace.getActiveSpan();
  span?.setAttribute('enduser.id', user.id);
  span?.setAttribute('enduser.role', user.role);
}

/** Times `fn` as a child span of the current request (parse, validate, render, AI call...). */
export async function withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T> | T): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

const MAX_SQL_LENGTH = 1000;

/**
 * Kysely's log hook: one span per SQL query, back-dated to when it started. The SQL is Kysely's
 * compiled, parameterised text -- the values are never included.
 */
export function recordQuery(dialect: 'postgresql' | 'sqlite') {
  return (event: LogEvent): void => {
    if (!trace.getActiveSpan()) return; // outside a request (migrations, seed): nothing to attach to
    const end = Date.now();
    const sql = event.query.sql;
    const span = tracer.startSpan(`${sql.split(/\s+/, 1)[0]?.toUpperCase() ?? 'QUERY'} ${dialect}`, {
      startTime: end - event.queryDurationMillis,
      attributes: {
        'db.system.name': dialect,
        'db.query.text': sql.length > MAX_SQL_LENGTH ? `${sql.slice(0, MAX_SQL_LENGTH)}…` : sql,
      },
    });
    if (event.level === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(end);
  };
}

/** For pino's mixin: the current trace and span ids, so a slow request's log lines can be found. */
export function traceIds(): Record<string, string> {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && ctx.traceFlags ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
}
