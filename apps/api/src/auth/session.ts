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
  app.post('/auth/logout', async (request, reply) => {
    await request.session.destroy();
    reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    if (!request.session.user) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    reply.send({ user: request.session.user });
  });
}
