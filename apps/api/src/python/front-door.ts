import replyFrom from '@fastify/reply-from';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { clientIp } from '../audit/audit.service.js';
import { PYTHON_ROUTE_GROUPS } from './route-groups.js';

/**
 * canvas-1bty.3: while the backend moves to Python (docs/python-backend-assessment.md), this service
 * stays the front door: browsers keep one address, and what the Python service now answers is
 * forwarded to it (an internal-only container in Azure). Cookies go through unchanged -- both
 * services read the same sessions (canvas-1bty.2) -- and so do Set-Cookie headers coming back.
 *
 * Two ways a request is forwarded:
 * - a route prefix with no TypeScript routes under it (PYTHON_ROUTES, default "/py"): the prefix and
 *   everything under it;
 * - canvas-1bty.6: a moved route (python/route-groups.ts, PYTHON_ROUTE_GROUPS). Its TypeScript route
 *   is still registered -- the fallback -- so this hook forwards by the route Fastify matched
 *   ("PATCH /projects/:id"), before any of that route's own handling runs. Matching on Fastify's own
 *   route patterns means /projects/:id/members (not moved yet) never goes along with /projects/:id.
 *
 * Registered before the routes and after the session plugin, so this service's session handling
 * runs for forwarded requests exactly as it does for its own. Off when PYTHON_API_URL isn't set.
 */
export async function registerPythonFrontDoor(
  app: FastifyInstance,
  config: Pick<AppConfig, 'pythonApiUrl' | 'pythonRoutePrefixes' | 'pythonRouteGroups'>,
): Promise<void> {
  if (!config.pythonApiUrl) return;
  await app.register(replyFrom, { base: config.pythonApiUrl });

  // The upstream sees the original host and scheme, and the client's address as this service worked it
  // out (clientIp: the entry Azure's ingress appended). Python's own internal ingress adds another
  // X-Forwarded-For entry, so it can't apply the same rule; it reads X-Canvas-Client-IP, which this
  // always overwrites (a client can't set it: Python is reachable only through here).
  const forward = (request: FastifyRequest, reply: FastifyReply) => {
    // A moved route is forwarded before its body is parsed: hand reply-from the raw stream, so the
    // body goes through byte for byte (GET and HEAD carry none).
    if (request.body === undefined && request.method !== 'GET' && request.method !== 'HEAD') request.body = request.raw;
    return reply.from(request.url, {
      rewriteRequestHeaders: (_req, headers) => ({
        ...headers,
        'x-forwarded-host': request.headers.host ?? '',
        'x-forwarded-proto': request.protocol,
        'x-canvas-client-ip': clientIp(request),
      }),
    });
  };

  for (const prefix of config.pythonRoutePrefixes) {
    app.all(prefix, { schema: { hide: true } }, forward);
    app.all(`${prefix}/*`, { schema: { hide: true } }, forward);
  }

  const moved = new Set<string>(config.pythonRouteGroups.flatMap((group) => PYTHON_ROUTE_GROUPS[group]));
  if (moved.size === 0) return;
  app.addHook('onRequest', async (request, reply) => {
    if (moved.has(`${request.method} ${request.routeOptions.url}`)) return forward(request, reply);
  });
}
