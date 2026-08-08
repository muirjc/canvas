export interface AppConfig {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  oidc: {
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    /** canvas-ycu.1: when the IdP sits behind an internal-only Container App with the API's own
     * container reverse-proxying to it (see infra/azure/modules/keycloak.bicep), the API calling
     * `issuerUrl` (its own public FQDN) for discovery/token/userinfo requests does not reliably
     * route back to itself within Container Apps' network — the fix ADP hit the hard way for the
     * identical topology. When set, oidc.ts rewrites the origin of every such outgoing request
     * from `issuerUrl`'s to this one, while `issuerUrl` itself stays the public address used for
     * the browser-facing authorization redirect and for validating the token's own `iss` claim
     * (which Keycloak, told its own public address via KC_HOSTNAME, still reports as `issuerUrl`,
     * not this internal one). Unset locally — a local Keycloak has no internal/public split. */
    internalIssuerUrl?: string;
    /** canvas-ycu.1: internal (VNet-only) base URL of the Keycloak Container App, e.g.
     * https://canvas-keycloak.internal.<env>.azurecontainerapps.io -- when set, idp-proxy.routes.ts
     * registers a transparent reverse proxy at /idp/* forwarding to it, since Keycloak's own
     * ingress is internal-only and a real browser can never reach it directly. Unset locally --
     * a local Keycloak (infra/keycloak/) has no internal/public split, OIDC_ISSUER_URL points
     * straight at it. */
    keycloakInternalUrl?: string;
  };
  /** Local email/password auth fallback (research.md §7) — disabled unless explicitly enabled. */
  allowLocalAuth: boolean;
  /** Origins allowed to make credentialed cross-origin requests (CORS). Reflecting all origins
   * with credentials enabled would let any website ride a signed-in user's session cookie. */
  webOrigins: string[];
  /**
   * Session cookie attributes (canvas-azure-deploy). Local dev serves the web app and API as
   * same-site (different ports of localhost, which browsers still treat as one site for cookie
   * purposes) over plain HTTP, so the historical defaults — no Secure flag, SameSite=Lax — work
   * unmodified. A split-origin deployment (e.g. a static-hosted frontend calling a separately
   * hosted API, as on Azure) is genuinely cross-site: SameSite=Lax cookies are not attached to
   * cross-site fetch/XHR calls at all (only top-level navigation), so the session cookie would
   * silently never be sent back after being set. SameSite=None is required for that topology, and
   * browsers reject SameSite=None without the Secure flag — so the two are set together. Kept
   * configurable (not just switched on NODE_ENV) since a same-origin production deployment (the
   * frontend and API served from one host) has no reason to opt into cross-site cookie semantics.
   */
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'none' | 'strict';
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// canvas-uw8: fixed, non-overridable in test mode — not just a fallback for when DATABASE_URL/
// SESSION_SECRET happen to be unset. A plain `env[name] ?? fallback` let an ambient DATABASE_URL
// already exported in a developer's shell (e.g. from starting `npm run dev` in that same
// terminal) silently leak into `npm run test`, pointing the contract-test suite's own
// resetDatabase() TRUNCATE at the real dev database instead of the isolated canvas_test one.
// Test mode has no legitimate reason to point at a different database per run, so this is a hard
// override, not a soft default — CI's own unit-tests job already relies on exactly this fallback
// (see .github/workflows/*.yml's "no DATABASE_URL/SESSION_SECRET needed here" comment) and never
// sets these vars itself, so hardening this doesn't change CI behavior at all.
const TEST_DATABASE_URL = 'postgres://canvas:canvas_dev_password@localhost:5433/canvas_test';
const TEST_SESSION_SECRET = 'test-secret-at-least-32-characters-long';

const VALID_SAME_SITE = new Set(['lax', 'none', 'strict']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isTest = env.NODE_ENV === 'test';

  const rawSameSite = env.COOKIE_SAME_SITE ?? 'lax';
  if (!VALID_SAME_SITE.has(rawSameSite)) {
    throw new Error(`COOKIE_SAME_SITE must be one of "lax", "none", "strict" (got: ${rawSameSite})`);
  }
  const cookieSameSite = rawSameSite as AppConfig['cookieSameSite'];
  // SameSite=None without Secure is never valid — browsers reject it outright — so this can't be
  // a deliberate configuration; treat it as the same "always required together" fact a developer
  // setting COOKIE_SAME_SITE=none almost certainly meant, rather than a foot-gun to fail on later.
  const cookieSecure = cookieSameSite === 'none' ? true : env.COOKIE_SECURE === 'true';

  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: isTest ? TEST_DATABASE_URL : requireEnv('DATABASE_URL'),
    sessionSecret: isTest ? TEST_SESSION_SECRET : requireEnv('SESSION_SECRET'),
    oidc: {
      issuerUrl: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI,
      internalIssuerUrl: env.OIDC_INTERNAL_ISSUER_URL,
      keycloakInternalUrl: env.KEYCLOAK_INTERNAL_URL,
    },
    allowLocalAuth: env.ALLOW_LOCAL_AUTH === 'true',
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()),
    cookieSecure,
    cookieSameSite,
  };
}
