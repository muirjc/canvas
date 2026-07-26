import * as client from 'openid-client';
import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import type { AppConfig } from '../config.js';
import type { SessionUser, UserRole } from './types.js';

declare module '@fastify/session' {
  interface FastifySessionObject {
    oidcState?: string;
    oidcCodeVerifier?: string;
  }
}

async function findOrCreateUserFromClaims(claims: {
  sub: string;
  email?: string;
  name?: string;
}): Promise<SessionUser> {
  const pool = getPool();
  const email = claims.email ?? `${claims.sub}@unknown.local`;
  const name = claims.name ?? email;

  const existing = await pool.query<{ id: string; email: string; name: string; role: UserRole; personas: string[] }>(
    'SELECT id, email, name, role, personas FROM users WHERE email = $1',
    [email],
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const inserted = await pool.query<{ id: string; email: string; name: string; role: UserRole; personas: string[] }>(
    `INSERT INTO users (name, email, role, personas)
     VALUES ($1, $2, 'architect', '{}')
     RETURNING id, email, name, role, personas`,
    [name, email],
  );
  return inserted.rows[0];
}

/**
 * Registers OIDC SSO login/callback routes (research.md §7 — primary auth mechanism).
 * No-op if `config.oidc.issuerUrl` is unset (e.g. local dev without an IdP configured).
 */
export async function registerOidcRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  if (!config.oidc.issuerUrl || !config.oidc.clientId || !config.oidc.redirectUri) {
    app.log.info('OIDC not configured (OIDC_ISSUER_URL/CLIENT_ID/REDIRECT_URI unset) — SSO routes disabled');
    return;
  }

  const oidcConfig = await client.discovery(
    new URL(config.oidc.issuerUrl),
    config.oidc.clientId,
    config.oidc.clientSecret,
  );

  app.get('/auth/login', async (request, reply) => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    request.session.oidcCodeVerifier = codeVerifier;
    request.session.oidcState = state;

    const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: config.oidc.redirectUri as string,
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    reply.redirect(authorizationUrl.href);
  });

  app.get('/auth/callback', async (request, reply) => {
    const { oidcCodeVerifier, oidcState } = request.session;
    if (!oidcCodeVerifier || !oidcState) {
      reply.code(400).send({ error: 'No pending OIDC login for this session' });
      return;
    }

    const currentUrl = new URL(request.url, `${request.protocol}://${request.hostname}`);
    const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
      pkceCodeVerifier: oidcCodeVerifier,
      expectedState: oidcState,
    });
    const claims = tokens.claims();
    if (!claims?.sub) {
      reply.code(401).send({ error: 'OIDC provider did not return a subject claim' });
      return;
    }

    const userInfo = await client.fetchUserInfo(oidcConfig, tokens.access_token, claims.sub);
    const user = await findOrCreateUserFromClaims({
      sub: claims.sub,
      email: userInfo.email,
      name: userInfo.name,
    });

    request.session.user = user;
    delete request.session.oidcCodeVerifier;
    delete request.session.oidcState;
    reply.redirect('/');
  });
}
