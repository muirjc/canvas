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

export class InactiveUserError extends Error {}

// canvas-mi9: highest-privilege role wins when a token carries more than one of these (Keycloak
// realm roles are not mutually exclusive by design). A user with none of the three recognised
// roles gets the lowest-privilege default (viewer) rather than failing closed (no access at all,
// which would make an otherwise-valid IdP login unusable) or open (silently admin, a real
// privilege-escalation risk) -- mirrors the precedent already established for Keycloak
// group-to-role mapping in a sibling project (ADP's auth/tokens.py _map_groups_to_role).
const ROLE_PRIORITY: UserRole[] = ['admin', 'architect', 'viewer'];

/** Reads the realm roles claim written by infra/keycloak/CanvasRealm-realm.json's "realm roles"
 *  protocol mapper (`realm_access.roles` in the ID token) -- defensively typed, since the ID
 *  token's claims are an untyped bag from the IdP's own response, not something this app
 *  controls the shape of. */
export function extractRealmRoles(claims: Record<string, unknown>): string[] {
  const realmAccess = claims.realm_access;
  if (!realmAccess || typeof realmAccess !== 'object') return [];
  const roles = (realmAccess as { roles?: unknown }).roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

export function mapRealmRolesToUserRole(realmRoles: string[]): UserRole {
  for (const role of ROLE_PRIORITY) {
    if (realmRoles.includes(role)) return role;
  }
  return 'viewer';
}

async function findOrCreateUserFromClaims(claims: {
  sub: string;
  email?: string;
  name?: string;
  realmRoles: string[];
}): Promise<SessionUser> {
  const pool = getPool();
  const email = claims.email ?? `${claims.sub}@unknown.local`;
  const name = claims.name ?? email;
  const role = mapRealmRolesToUserRole(claims.realmRoles);

  const existing = await pool.query<{
    id: string;
    email: string;
    name: string;
    role: UserRole;
    personas: string[];
    active: boolean;
  }>('SELECT id, email, name, role, personas, active FROM users WHERE email = $1', [email]);
  const row = existing.rows[0];
  if (row) {
    // canvas-mi9: local email/password auth already refuses an inactive user
    // (auth/local.ts's `!row.active` check) -- SSO had no equivalent gate at all, so a
    // deactivated account could still sign back in via Keycloak. Closed here rather than left as
    // a separate, smaller follow-up, since it's the same table/column this function already reads.
    if (!row.active) {
      throw new InactiveUserError(`User ${email} is deactivated`);
    }
    // Keycloak is the source of truth for role once a user signs in via SSO -- an admin demoted
    // in Keycloak loses admin access in canvas on their very next login, not just at some future
    // manual re-provisioning step. Written only when it actually changed, to avoid an
    // unconditional UPDATE on every single login.
    if (row.role !== role) {
      await pool.query('UPDATE users SET role = $2 WHERE id = $1', [row.id, role]);
      row.role = role;
    }
    return { id: row.id, email: row.email, name: row.name, role: row.role, personas: row.personas };
  }

  const inserted = await pool.query<{ id: string; email: string; name: string; role: UserRole; personas: string[] }>(
    `INSERT INTO users (name, email, role, personas)
     VALUES ($1, $2, $3, '{}')
     RETURNING id, email, name, role, personas`,
    [name, email, role],
  );
  return inserted.rows[0];
}

/**
 * Registers OIDC SSO login/callback routes (research.md §7 — primary auth mechanism).
 * No-op if `config.oidc.issuerUrl` is unset (e.g. local dev without an IdP configured).
 */
export async function registerOidcRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const oidcEnabled = Boolean(config.oidc.issuerUrl && config.oidc.clientId && config.oidc.redirectUri);

  // canvas-mi9: registered unconditionally (even when OIDC itself is unconfigured) so the
  // frontend has a public, unauthenticated way to know whether to show a "Sign in with SSO"
  // link at all, rather than always showing one that 404s when unset. No sensitive data —
  // whether SSO is configured isn't a secret the way OIDC_CLIENT_SECRET is.
  app.get('/auth/config', async () => ({ oidcEnabled }));

  if (!oidcEnabled) {
    app.log.info('OIDC not configured (OIDC_ISSUER_URL/CLIENT_ID/REDIRECT_URI unset) — SSO routes disabled');
    return;
  }
  // Re-narrowed explicitly (not implied by `oidcEnabled`'s own boolean type) so TypeScript still
  // sees these as definitely-defined below.
  const { issuerUrl, clientId, clientSecret, redirectUri } = config.oidc as {
    issuerUrl: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
  };

  const issuer = new URL(issuerUrl);
  // canvas-mi9: openid-client v6 refuses plain-HTTP discovery/token/userinfo requests by default
  // (a real, correct hardening default -- OAUTH_HTTP_REQUEST_FORBIDDEN otherwise). Gated on the
  // issuer URL's own protocol, not a separate env flag: a real deployment's OIDC_ISSUER_URL is
  // always https:// (Keycloak or any other real IdP), so this can't be silently left enabled in
  // production the way a boolean toggle could be forgotten-on. Only ever true for a local
  // Keycloak reachable at http://localhost:<port> (see infra/keycloak/, RUNBOOK.md).
  const allowInsecure = issuer.protocol === 'http:';
  const oidcConfig = await client.discovery(
    issuer,
    clientId,
    clientSecret,
    undefined,
    allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
  );

  app.get('/auth/login', async (request, reply) => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    request.session.oidcCodeVerifier = codeVerifier;
    request.session.oidcState = state;

    const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: redirectUri,
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

    // canvas-mi9: Fastify's `request.hostname` strips the port (it's derived from the Host
    // header but deliberately port-less, per Fastify's own docs) -- reconstructing the callback
    // URL from it silently dropped `:3000` here, producing `http://localhost/auth/callback`
    // instead of `http://localhost:3000/auth/callback`. openid-client's authorizationCodeGrant
    // derives the redirect_uri it sends to the token endpoint from this URL's own origin+path, so
    // the mismatch against the redirect_uri actually registered with the IdP made the token
    // exchange fail with "Incorrect redirect_uri" on every single OIDC login -- undetectable
    // without a real IdP to test against, which nothing in this codebase had done before
    // canvas-mi9. `request.headers.host` is the raw Host header value and does include the port.
    const currentUrl = new URL(request.url, `${request.protocol}://${request.headers.host}`);
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
    try {
      const user = await findOrCreateUserFromClaims({
        sub: claims.sub,
        email: userInfo.email,
        name: userInfo.name,
        realmRoles: extractRealmRoles(claims),
      });

      request.session.user = user;
      delete request.session.oidcCodeVerifier;
      delete request.session.oidcState;
      // canvas-mi9: redirecting to relative '/' lands on the API's OWN origin (this app is
      // explicitly split-origin -- the frontend is a separate dev server/deployment, see
      // COOKIE_SAME_SITE/docs/azure-deployment.md), which has no such route and 404s. Never
      // caught before this bead because nothing had exercised a full OIDC round-trip against a
      // real IdP. config.webOrigins is the same list CORS already trusts for credentialed
      // requests from this app's own frontend -- reusing it here rather than a separate env var.
      reply.redirect(config.webOrigins[0]);
    } catch (error) {
      if (error instanceof InactiveUserError) {
        reply.code(403).send({ error: 'This account has been deactivated.' });
        return;
      }
      throw error;
    }
  });
}
