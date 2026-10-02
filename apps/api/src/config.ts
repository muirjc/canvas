export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** canvas-jtm.7: which Kysely dialect db/client.ts should construct. Derived from `DB_CLIENT`
   * (default 'postgres', preserving every existing deployment's behavior unchanged) in normal
   * mode, or `TEST_DB_CLIENT` in test mode — kept as a separate env var so a developer's real
   * `DB_CLIENT=sqlite` shell export (for running the app locally) can't accidentally redirect the
   * test suite, mirroring DATABASE_URL/TEST_DATABASE_URL's existing test-mode isolation above. */
  dbClient: 'postgres' | 'sqlite';
  sessionSecret: string;
  oidc: {
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
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
  /** Serves an OpenAPI/Swagger spec + interactive UI at /docs (app.ts). Opt-in, same posture as
   *  allowLocalAuth above: false unless explicitly enabled, so the public Azure deployment doesn't
   *  expose its full route surface by default just because this repo added the capability — a
   *  deliberate choice to make later, not an accidental default. */
  enableApiDocs: boolean;
}

// canvas-ai2: reads from the given `env` (loadConfig's own override parameter) rather than
// `process.env` directly, so `loadConfig(customEnv)` is fully dependency-injectable for every
// field, not just the test-mode ones (databaseUrl/sessionSecret previously ignored `env` entirely
// outside test mode, forcing tests to stub real `process.env` instead — see config.test.ts).
function requireEnv(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
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
// canvas-jtm.7: better-sqlite3's own `:memory:` special-case database name — a fresh, private
// database per process, needing no file cleanup between runs.
const TEST_SQLITE_DATABASE_URL = ':memory:';
const TEST_SESSION_SECRET = 'test-secret-at-least-32-characters-long';

const VALID_SAME_SITE = new Set(['lax', 'none', 'strict']);

// canvas-haz: a misconfigured OIDC_ISSUER_URL against Entra fails deep inside openid-client with
// an opaque issuer-mismatch error (the discovered metadata's own `issuer` field won't match what
// was passed to `discovery()`) -- this catches the two actual mistakes early, with a message that
// says what's wrong and how to fix it, specifically for Entra's own issuer shape. Every other
// IdP's issuer URL is left entirely unvalidated here, same as before this check existed.
function validateOidcIssuerUrl(issuerUrl: string | undefined): void {
  if (!issuerUrl) return;
  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    throw new Error(`OIDC_ISSUER_URL is not a valid URL: "${issuerUrl}"`);
  }
  if (url.hostname !== 'login.microsoftonline.com') return;

  const segments = url.pathname.split('/').filter(Boolean);
  const tenantSegment = segments[0];
  // The multi-tenant aliases resolve to an issuer containing a literal `{tenantid}` placeholder,
  // not a real tenant ID -- this app always authenticates against one specific tenant.
  if (tenantSegment === 'common' || tenantSegment === 'organizations' || tenantSegment === 'consumers') {
    throw new Error(
      `OIDC_ISSUER_URL uses Entra's multi-tenant alias "/${tenantSegment}/..." -- this app needs a ` +
        `real tenant ID in the issuer path instead: https://login.microsoftonline.com/<tenant-id>/v2.0`,
    );
  }
  // Without the /v2.0 suffix, Entra's discovery document reports v1 metadata instead (issuer
  // https://sts.windows.net/<tenant-id>/), which carries a different claims shape than this app
  // expects (e.g. no flat top-level `roles` claim the way v2 tokens have it).
  if (segments[segments.length - 1] !== 'v2.0') {
    throw new Error(
      `OIDC_ISSUER_URL must end in "/v2.0" (got: "${issuerUrl}") -- use ` +
        `https://login.microsoftonline.com/<tenant-id>/v2.0`,
    );
  }
}

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

  const dbClientEnvVar = isTest ? env.TEST_DB_CLIENT : env.DB_CLIENT;
  const dbClient: AppConfig['dbClient'] = dbClientEnvVar === 'sqlite' ? 'sqlite' : 'postgres';

  validateOidcIssuerUrl(env.OIDC_ISSUER_URL);

  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: isTest
      ? dbClient === 'sqlite'
        ? TEST_SQLITE_DATABASE_URL
        : TEST_DATABASE_URL
      : requireEnv(env, 'DATABASE_URL'),
    dbClient,
    sessionSecret: isTest ? TEST_SESSION_SECRET : requireEnv(env, 'SESSION_SECRET'),
    oidc: {
      issuerUrl: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI,
    },
    allowLocalAuth: env.ALLOW_LOCAL_AUTH === 'true',
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()),
    cookieSecure,
    cookieSameSite,
    enableApiDocs: env.ENABLE_API_DOCS === 'true',
  };
}
