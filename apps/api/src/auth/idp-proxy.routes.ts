import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

/**
 * Reverse proxy to Keycloak, mounted at /idp (canvas-ycu.1).
 *
 * Keycloak's Azure Container App has internal-only ingress -- unreachable from a real user's
 * browser (see infra/azure/modules/keycloak.bicep). But the browser itself has to be redirected
 * to Keycloak's own authorization endpoint (oidc.ts's /auth/login) and land back on its own
 * callback afterward -- neither can go through a server-side call alone. This router makes
 * canvas-api (already externally reachable) transparently forward everything under /idp/* to the
 * internal Keycloak instance, so the browser only ever talks to the one public hostname.
 *
 * Mounted at /idp, not /auth: canvas-api already owns the /auth/* namespace for its own session
 * routes (/auth/login, /auth/callback, /auth/me, /auth/logout, /auth/local/login, /auth/config)
 * -- unlike a sibling project this was modeled on, which has no server-side auth routes of its
 * own and could give Keycloak the whole /auth prefix.
 *
 * Keycloak is configured (KC_HOSTNAME + --http-relative-path=/idp, see
 * infra/azure/modules/keycloak.bicep) to already believe its own public base URL is
 * https://<api-fqdn>/idp -- so it generates correct absolute URLs, redirect targets, and issuer
 * claims on its own. This proxy does no path rewriting or URL substitution; it's a transparent
 * pass-through. No-op (route never registered) when KEYCLOAK_INTERNAL_URL is unset -- local dev
 * talks to Keycloak directly (OIDC_ISSUER_URL points straight at it, see RUNBOOK.md).
 */

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'host']);

export async function registerIdpProxyRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const internalUrl = config.oidc.keycloakInternalUrl;
  if (!internalUrl) return;
  const internalBase = internalUrl.replace(/\/$/, '');

  // A separate encapsulated plugin instance (app.register's own scoping), not registered
  // directly on `app` -- the raw-buffer content-type parser below must apply ONLY to routes
  // proxied here, never globally. Keycloak's own login form POSTs
  // application/x-www-form-urlencoded, which Fastify has no built-in parser for at all (would
  // 415 before ever reaching this handler) without @fastify/formbody -- but this proxy has no
  // business parsing ANY body it forwards, JSON included, just relaying whatever bytes arrived.
  //
  // A `'*'` wildcard parser alone is NOT enough: Fastify's own built-in `application/json` (and
  // `text/plain`) parsers always take precedence over a wildcard registration regardless of
  // registration order (confirmed against Fastify's own ContentTypeParser docs/source, not
  // guessed) -- so any JSON-bodied request forwarded through this proxy (e.g. every Keycloak
  // admin-API write: PUT .../clients/{id}, POST .../clients, ...) was silently being parsed into
  // a JS object by Fastify's default parser instead of staying a raw Buffer, then handed to
  // `fetch()`'s `body` option as that object -- which stringifies to the literal text
  // "[object Object]", not valid JSON, so Keycloak rejected every one with a generic
  // "Cannot parse the JSON" error. `removeAllContentTypeParsers()` clears Fastify's defaults
  // first so the wildcard below is genuinely the only parser and every content type reaches
  // Keycloak as the exact bytes the client sent.
  await app.register(async (scoped) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    scoped.all('/idp/*', async (request, reply) => {
      const wildcard = (request.params as { '*': string })['*'];
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const target = `${internalBase}/idp/${wildcard}${query}`;

      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string' && !HOP_BY_HOP.has(key.toLowerCase())) {
          forwardHeaders[key] = value;
        }
      }

      const upstream = await fetch(target, {
        method: request.method,
        headers: forwardHeaders,
        // GET/HEAD must not carry a body -- fetch throws "Request with GET/HEAD method cannot have body".
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : (request.body as Buffer | undefined),
        redirect: 'manual',
      });

      reply.code(upstream.status);
      for (const [key, value] of upstream.headers.entries()) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) reply.header(key, value);
      }
      reply.send(Buffer.from(await upstream.arrayBuffer()));
    });
  });
}
