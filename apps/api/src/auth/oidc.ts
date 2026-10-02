import { randomUUID } from 'node:crypto';
import * as client from 'openid-client';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { getUserPersonas } from '../db/array-columns.js';
import type { AppConfig } from '../config.js';
import type { SessionUser, UserRole } from './types.js';

declare module '@fastify/session' {
  interface FastifySessionObject {
    oidcState?: string;
    oidcNonce?: string;
    oidcCodeVerifier?: string;
    // canvas-252: the ID token from the OIDC callback, kept for the life of the session so
    // /auth/logout (session.ts) can pass it as id_token_hint on RP-Initiated Logout. Its presence
    // also doubles as "this session was established via SSO" -- a local-auth session never sets
    // it, so /auth/logout can tell the two apart without a separate flag.
    oidcIdToken?: string;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    // canvas-252: set only when OIDC is configured AND the discovered issuer metadata actually
    // advertises an end_session_endpoint -- session.ts checks for its presence before using it,
    // so a deployment/IdP without RP-Initiated Logout support falls back to local-session-only
    // logout exactly as before, rather than erroring.
    buildOidcLogoutUrl?: (idTokenHint: string) => string;
  }
}

/**
 * Pure URL builder for OIDC RP-Initiated Logout
 * (https://openid.net/specs/openid-connect-rpinitiated-1_0.html) -- extracted as a standalone
 * function so it's directly unit-testable without a real discovered Configuration (openid-client's
 * own client.buildEndSessionUrl needs the full Configuration instance, which isn't easily faked in
 * a unit test). client_id is always included, per spec, whenever id_token_hint is present too --
 * harmless, and matches openid-client's own behavior.
 */
export function buildEndSessionUrl(
  endSessionEndpoint: string | URL,
  params: { clientId: string; idTokenHint: string; postLogoutRedirectUri: string },
): URL {
  const url = new URL(endSessionEndpoint);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('id_token_hint', params.idTokenHint);
  url.searchParams.set('post_logout_redirect_uri', params.postLogoutRedirectUri);
  return url;
}

export class InactiveUserError extends Error {}

// canvas-mi9: highest-privilege role wins when a token carries more than one of these. A user
// with none of the three recognised roles gets the lowest-privilege default (viewer) rather than
// failing closed (no access at all, which would make an otherwise-valid IdP login unusable) or
// open (silently admin, a real privilege-escalation risk) -- mirrors the precedent already
// established for Keycloak group-to-role mapping in a sibling project (ADP's auth/tokens.py
// _map_groups_to_role). canvas-haz: Entra's own "Assignment required" Enterprise Application
// setting (see RUNBOOK.md's "Entra ID SSO" section) already makes an unassigned user unable to
// get a token for this app at all, so this default mostly only matters for a token that somehow
// carries zero of the three roles despite assignment being required.
const ROLE_PRIORITY: UserRole[] = ['admin', 'architect', 'viewer'];

/** Entra App Roles arrive as a flat top-level `roles: string[]` claim on the v2.0 ID token (set up
 *  in the app registration's manifest -- see RUNBOOK.md's "Entra ID SSO" section) -- defensively
 *  typed, since the ID token's claims are an untyped bag from the IdP's own response, not
 *  something this app controls the shape of. A Keycloak-shaped `realm_access.roles` claim (or any
 *  other nested shape) is deliberately NOT read here -- that was the previous IdP's own claim
 *  structure, not Entra's. */
export function extractEntraRoles(claims: Record<string, unknown>): string[] {
  const roles = claims.roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

export function mapIdpRolesToUserRole(idpRoles: string[]): UserRole {
  for (const role of ROLE_PRIORITY) {
    if (idpRoles.includes(role)) return role;
  }
  return 'viewer';
}

/**
 * Reads identity (subject, email, display name) directly off the ID token's own claims, rather
 * than calling the OIDC userinfo endpoint (as the previous Keycloak-based flow did) -- Entra's
 * userinfo endpoint lives on Microsoft Graph (a separate audience, an extra round-trip per login)
 * and returns nothing the v2 ID token doesn't already carry once the `email` optional claim is
 * configured on the app registration (RUNBOOK.md's "Entra ID SSO" section) -- and the ID token is
 * the one artifact whose signature `enableNonRepudiationChecks` now actually verifies, making it
 * the stronger source to read identity from, not just the more convenient one.
 *
 * `email` is lowercased: Entra can return it in whatever case the directory happens to store it
 * (e.g. `Jane.Doe@Contoso.com`), while this app's own `users.email` lookup is a case-sensitive `=`
 * on both supported database engines -- without normalizing here, the exact same person could
 * silently get a second, duplicate account if Entra ever returns a differently-cased email.
 *
 * `preferred_username` is used as a fallback only when it looks like an email (contains `@`) --
 * Microsoft documents it as the user's UPN, mutable and not guaranteed to resemble an email
 * address at all, so it's a weaker signal than the `email` claim and only trusted when it's
 * actually shaped like one.
 */
export function extractIdentityFromIdToken(
  claims: Record<string, unknown>,
): { sub: string; email?: string; name?: string } {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const rawEmail = typeof claims.email === 'string' && claims.email ? claims.email : undefined;
  const preferredUsername =
    typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@')
      ? claims.preferred_username
      : undefined;
  const email = (rawEmail ?? preferredUsername)?.toLowerCase();
  const name = typeof claims.name === 'string' && claims.name ? claims.name : undefined;
  return { sub, email, name };
}

async function findOrCreateUserFromClaims(claims: {
  sub: string;
  email?: string;
  name?: string;
  roles: string[];
}): Promise<SessionUser> {
  const db = getDb();
  const email = claims.email ?? `${claims.sub}@unknown.local`;
  const name = claims.name ?? email;
  const role = mapIdpRolesToUserRole(claims.roles);

  const row = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'role', 'active'])
    .where('email', '=', email)
    .executeTakeFirst();
  if (row) {
    // canvas-mi9: local email/password auth already refuses an inactive user
    // (auth/local.ts's `!row.active` check) -- SSO had no equivalent gate at all, so a
    // deactivated account could still sign back in via the IdP. Closed here rather than left as
    // a separate, smaller follow-up, since it's the same table/column this function already reads.
    if (!row.active) {
      throw new InactiveUserError(`User ${email} is deactivated`);
    }
    // The IdP is the source of truth for role once a user signs in via SSO -- an admin demoted in
    // Entra loses admin access in canvas on their very next login, not just at some future manual
    // re-provisioning step. Written only when it actually changed, to avoid an unconditional
    // UPDATE on every single login.
    if (row.role !== role) {
      await db.updateTable('users').set({ role }).where('id', '=', row.id).execute();
      row.role = role;
    }
    return { id: row.id, email: row.email, name: row.name, role: row.role, personas: await getUserPersonas(db, row.id) };
  }

  const inserted = await db
    .insertInto('users')
    .values({ id: randomUUID(), name, email, role })
    .returning(['id', 'email', 'name', 'role'])
    .executeTakeFirstOrThrow();
  // A freshly-created user has no personas yet — no row in users_personas, which
  // getUserPersonas already reads as [] — so no setUserPersonas([]) call is needed here.
  return { ...inserted, personas: [] };
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
  //
  // canvas-cpa: localAuthEnabled likewise tells the frontend, before the user ever submits
  // anything, whether POST /auth/local/login exists at all -- it's gated behind
  // config.allowLocalAuth exactly like this route registration is gated behind oidcEnabled, and
  // an SSO-only deployment (the Azure default, canvas-ycu.1) would otherwise only find out via a
  // raw 404 after submitting the password form.
  app.get(
    '/auth/config',
    // canvas-lfc: no preHandler enforces auth -- deliberately public (see the comment above).
    { schema: { tags: ['Auth'], security: [] } },
    async () => ({ oidcEnabled, localAuthEnabled: config.allowLocalAuth }),
  );

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
  // issuer URL's own protocol, not a separate env flag: Entra's own issuer is always
  // https://login.microsoftonline.com/..., so this can't be silently left enabled in production
  // the way a boolean toggle could be forgotten-on -- it only ever matters for a local non-Entra
  // OIDC-compatible test IdP reachable over plain HTTP.
  const allowInsecure = issuer.protocol === 'http:';
  const execute: ((config: client.Configuration) => void)[] = [];
  if (allowInsecure) execute.push(client.allowInsecureRequests);
  // canvas-haz: openid-client does NOT verify an ID token's JWS signature by default -- it treats
  // TLS-to-the-token-endpoint as sufficient trust per OIDC Core 3.1.3.7 (confirmed directly in the
  // installed package's own doc comments on this function). That's a reasonable default for an
  // IdP reached directly over HTTPS, but the spec driving this migration
  // (docs/Entra ID Auth & Authz Specification.md, AUTH-4) explicitly calls for verifying the
  // signature against the IdP's own published JWKS, so it's turned on unconditionally here rather
  // than left as the library default.
  execute.push(client.enableNonRepudiationChecks);

  const oidcConfig = await client.discovery(issuer, clientId, clientSecret, undefined, { execute });

  // canvas-252: RP-Initiated Logout needs the discovered end_session_endpoint. Read defensively
  // (optional chaining + try/catch) rather than assuming oidcConfig.serverMetadata() exists --
  // this codebase's own oidc.test.ts mocks client.discovery() to resolve a bare `{}`, which has
  // no such method, and a real IdP without RP-Initiated Logout support simply omits the field.
  // Either way, the effect is the same: buildOidcLogoutUrl is left undecorated, and
  // session.ts's /auth/logout falls back to local-session-only logout exactly as it did before
  // this feature existed.
  let endSessionEndpoint: string | undefined;
  try {
    endSessionEndpoint = oidcConfig.serverMetadata?.().end_session_endpoint;
  } catch {
    endSessionEndpoint = undefined;
  }
  if (endSessionEndpoint) {
    const postLogoutRedirectUri = config.webOrigins[0];
    app.decorate('buildOidcLogoutUrl', (idTokenHint: string) =>
      buildEndSessionUrl(endSessionEndpoint, { clientId, idTokenHint, postLogoutRedirectUri }).href,
    );
  }

  app.get(
    '/auth/login',
    // canvas-lfc: no preHandler enforces auth -- this route starts a fresh login, so a caller
    // can't be authenticated yet.
    { schema: { tags: ['Auth'], security: [] } },
    async (request, reply) => {
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const state = client.randomState();
      const nonce = client.randomNonce();

      request.session.oidcCodeVerifier = codeVerifier;
      request.session.oidcState = state;
      request.session.oidcNonce = nonce;

      const authorizationUrl = client.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });

      reply.redirect(authorizationUrl.href);
    },
  );

  app.get(
    '/auth/callback',
    // canvas-lfc: no preHandler enforces auth -- this route IS what establishes the session, and
    // its own pending-state check (below) is a business rule, not a canvas cookieAuth check.
    { schema: { tags: ['Auth'], security: [] } },
    async (request, reply) => {
      const { oidcCodeVerifier, oidcState, oidcNonce } = request.session;
      if (!oidcCodeVerifier || !oidcState || !oidcNonce) {
        reply.code(400).send({ error: 'No pending OIDC login for this session' });
        return;
      }
      // Cleared up front, not just on success -- a failed login (bad signature, denied
      // authorization, ...) must not leave a stale pending-login state a retry could reuse.
      delete request.session.oidcCodeVerifier;
      delete request.session.oidcState;
      delete request.session.oidcNonce;

      try {
        // canvas-mi9: Fastify's `request.hostname` strips the port (it's derived from the Host
        // header but deliberately port-less, per Fastify's own docs) -- reconstructing the
        // callback URL from it silently dropped `:3000` here, producing
        // `http://localhost/auth/callback` instead of `http://localhost:3000/auth/callback`.
        // openid-client's authorizationCodeGrant derives the redirect_uri it sends to the token
        // endpoint from this URL's own origin+path, so the mismatch against the redirect_uri
        // actually registered with the IdP made the token exchange fail with "Incorrect
        // redirect_uri" on every single OIDC login -- undetectable without a real IdP to test
        // against, which nothing in this codebase had done before canvas-mi9.
        // `request.headers.host` is the raw Host header value and does include the port.
        const currentUrl = new URL(request.url, `${request.protocol}://${request.headers.host}`);
        const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
          pkceCodeVerifier: oidcCodeVerifier,
          expectedState: oidcState,
          expectedNonce: oidcNonce,
        });
        const claims = tokens.claims();
        if (!claims?.sub) {
          reply.code(401).send({ error: 'OIDC provider did not return a subject claim' });
          return;
        }

        const identity = extractIdentityFromIdToken(claims);
        const user = await findOrCreateUserFromClaims({
          sub: identity.sub,
          email: identity.email,
          name: identity.name,
          roles: extractEntraRoles(claims),
        });

        request.session.user = user;
        // canvas-252: kept for the life of the session so /auth/logout can pass it as
        // id_token_hint on RP-Initiated Logout -- without it, signing out never actually clears
        // the IdP's own SSO session, so the very next SSO login silently re-authenticates the
        // same user instead of prompting, making it impossible to switch accounts.
        if (tokens.id_token) request.session.oidcIdToken = tokens.id_token;
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
        // canvas-haz: the IdP redirected back with its own `?error=...` params (e.g. Entra's
        // AADSTS50105 for a user with no app-role assignment) -- the user authenticated
        // successfully but isn't authorized for this app at all, a 403, not a token-validation
        // failure. `error_description` is logged (useful for diagnosing a misconfigured app
        // registration) but never shown to the end user, who can't act on an IdP error code.
        if (error instanceof client.AuthorizationResponseError) {
          app.log.warn({ error: error.error, description: error.error_description }, 'OIDC authorization denied');
          reply.code(403).send({ error: 'You are not authorized to access this application.' });
          return;
        }
        // Any other failure here is a token-validation problem (bad/tampered signature, wrong
        // issuer/audience, expired token, state/nonce mismatch, ...) -- previously surfaced as an
        // undifferentiated 500. Logged with the error's own message only, never the request's
        // tokens/claims, which can contain sensitive identity data.
        app.log.warn({ err: (error as Error).message }, 'OIDC callback failed validation');
        reply.code(401).send({ error: 'SSO sign-in failed' });
      }
    },
  );
}
