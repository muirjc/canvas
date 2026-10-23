import cookie from '@fastify/cookie';
import session from '@fastify/session';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { DbSessionStore } from './session-store.js';

/**
 * canvas-4xo: sessions used to run on every @fastify/session default -- the in-memory store (lost
 * on restart, unbounded, single-replica only), no expiry, and a session created for every
 * anonymous request. Now:
 * - the store is the database (DbSessionStore);
 * - the cookie's Max-Age is the idle timeout, refreshed on every request (`rolling`, the
 *   library's default), and the library itself rejects a restored session past it;
 * - a signed-in session also ends sessionMaxHours after sign-in, however active (see the
 *   onRequest hook below);
 * - nothing is stored for a request that never writes to its session (saveUninitialized: false).
 * The cookie is named SESSION_COOKIE_NAME, not the library default.
 */
/**
 * The session cookie's name. Not @fastify/session's default ('sessionId'): a default name tells an
 * attacker which session library to target, and Bearer flags it (javascript_express_default_cookie_
 * config). Exported so the API docs and tests use the one value.
 */
export const SESSION_COOKIE_NAME = 'cid';

export async function registerSession(app: FastifyInstance, config: AppConfig): Promise<void> {
  const idleMs = config.sessionIdleMinutes * 60 * 1000;
  const maxMs = config.sessionMaxHours * 60 * 60 * 1000;
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    cookieName: SESSION_COOKIE_NAME,
    store: new DbSessionStore(idleMs),
    saveUninitialized: false,
    cookie: {
      secure: config.cookieSecure,
      httpOnly: true,
      sameSite: config.cookieSameSite,
      maxAge: idleMs,
    },
  });

  // Runs after @fastify/session's own onRequest hook (registered just above) has restored the
  // session. A session from before canvas-4xo has no authenticatedAt and is treated as expired.
  app.addHook('onRequest', async (request) => {
    const { user, authenticatedAt } = request.session;
    if (user && (typeof authenticatedAt !== 'number' || Date.now() - authenticatedAt > maxMs)) {
      await replaceSession(request);
    }
  });

  // canvas-ez1.2: someone signed in with a one-time password can only change it (or sign out)
  // until they do. The /auth/* routes stay reachable -- /auth/me tells the web app to show the
  // change-password screen.
  app.addHook('preHandler', async (request, reply) => {
    // canvas-ez1.5: the same for two-step verification that's required but not set up yet.
    const user = request.session.user;
    if (!user?.mustChangePassword && !user?.mustEnrollMfa) return;
    const route = request.routeOptions.url ?? '';
    if (route.startsWith('/auth/') || route === '/health') return;
    if (user.mustChangePassword) {
      return reply.code(403).send({
        error: 'Change your one-time password before continuing.',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
    return reply.code(403).send({
      error: 'Set up two-step verification before continuing.',
      code: 'MFA_ENROLLMENT_REQUIRED',
    });
  });
}

/**
 * canvas-4xo: swaps the request's session for a fresh, empty one with a new id, and deletes the
 * old one from the store (regenerate() alone leaves it valid until it expires). Used at sign-in,
 * so a session id known before login can't be used after it (session fixation), and when a
 * session passes its absolute lifetime.
 */
export async function replaceSession(request: FastifyRequest): Promise<void> {
  const previous = request.session;
  const previousId = previous.sessionId;
  await previous.regenerate();
  await new Promise<void>((resolve, reject) => {
    request.sessionStore.destroy(previousId, (error) => (error ? reject(error) : resolve()));
  });
}

/** canvas-4xo: starts a signed-in session for `user`: a new session id, stamped with the sign-in
 *  time the absolute lifetime is measured from. */
export async function startAuthenticatedSession(request: FastifyRequest, user: NonNullable<FastifyRequest['session']['user']>): Promise<void> {
  await replaceSession(request);
  request.session.user = user;
  request.session.authenticatedAt = Date.now();
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
        return reply.code(200).send({ logoutUrl: app.buildOidcLogoutUrl(oidcIdToken) });
      }
      return reply.code(204).send();
    },
  );

  // canvas-ao2: did this request arrive with a session? The web app asks right after a sign-in
  // succeeds: 'none' then means the browser dropped the session cookie -- the app and the API are
  // on different sites, so private windows and Safari (every iOS browser) block it as third-party
  // -- and the sign-in page can say so instead of failing at the next step. Reads only; never
  // creates a session.
  app.get(
    '/auth/session-check',
    { schema: { tags: ['Auth'], security: [] } },
    async (request, reply) => {
      const state = request.session.user ? 'signed-in' : request.session.mfaPending ? 'pending-mfa' : 'none';
      return reply.send({ session: state });
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
        return reply.code(401).send({ error: 'Not authenticated' });
      }
      return reply.send({ user: request.session.user });
    },
  );
}
