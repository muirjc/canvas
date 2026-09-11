import cookie from '@fastify/cookie';
import session from '@fastify/session';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

export async function registerSession(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    cookie: {
      secure: config.cookieSecure,
      httpOnly: true,
      sameSite: config.cookieSameSite,
    },
  });
}

/**
 * `/auth/me` and `/auth/logout` -- registered unconditionally, unlike `/auth/local/login`
 * (auth/local.ts, gated behind config.allowLocalAuth). These two read/destroy whatever session
 * the request already carries; they have nothing to do with *how* that session was established
 * (password login vs. the OIDC callback in auth/oidc.ts setting `request.session.user` directly).
 * Previously both lived inside auth/local.ts's gated registration, so a deployment with local
 * auth disabled (e.g. the Azure deployment's `ALLOW_LOCAL_AUTH=false` default, canvas-ycu.1)
 * 404'd on every `/auth/me` call -- including the frontend's own on-load session check right
 * after a successful SSO round-trip -- so a real, completed Keycloak login could never be
 * recognized and the user landed back on the login screen with no indication anything had
 * happened. Every existing test ran with `allowLocalAuth: true` forced on
 * (tests/helpers/setup.ts), which is why this never surfaced there.
 */
export async function registerSessionInfoRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/logout',
    // canvas-lfc: no preHandler enforces auth -- calling this with no active session is a no-op
    // 204, not an error (see the body below), so it's genuinely public, not merely unannotated.
    { schema: { tags: ['Auth'], security: [] } },
    async (request, reply) => {
      // canvas-252: destroying the local session was ALL this route ever did -- Keycloak's own SSO
      // session cookie was never touched, so the very next SSO login silently re-authenticated the
      // same user (Keycloak sees its still-live session and skips the credential prompt entirely),
      // making it impossible to sign out and switch accounts. Captured before destroy() clears it;
      // its presence also means "this session came from SSO" -- a local-auth session never sets it
      // (oidc.ts's /auth/callback is the only writer), so a local-auth user gets the exact same
      // plain 204 this route always returned, no unnecessary Keycloak round-trip.
      const oidcIdToken = request.session.oidcIdToken;
      await request.session.destroy();
      if (oidcIdToken && app.buildOidcLogoutUrl) {
        // A logout URL, not a redirect: this endpoint is called via fetch() (apps/web's api.ts),
        // and fetch silently follows redirects itself rather than navigating the browser -- Keycloak
        // would never actually see the real top-level page load its own logout endpoint needs to
        // clear its session cookie. The frontend does the real navigation instead (AppShell.tsx).
        reply.code(200).send({ logoutUrl: app.buildOidcLogoutUrl(oidcIdToken) });
        return;
      }
      reply.code(204).send();
    },
  );

  app.get(
    '/auth/me',
    // canvas-lfc: no preHandler enforces auth -- unauthenticated gets a 401 *body* from the
    // handler itself (below), not a preHandler rejection, so security: [] reflects Fastify's
    // actual enforcement mechanism rather than the practical "you need a session to get anything
    // useful back" intent alone.
    { schema: { tags: ['Auth'], security: [] } },
    async (request, reply) => {
      if (!request.session.user) {
        reply.code(401).send({ error: 'Not authenticated' });
        return;
      }
      reply.send({ user: request.session.user });
    },
  );
}
