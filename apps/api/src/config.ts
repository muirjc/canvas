import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
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
    /** canvas-haz.9: 'managed-identity' = authenticate to Entra with the managed identity's token
     *  (a federated credential), no client secret. Default 'secret'. */
    clientAuth?: 'secret' | 'managed-identity';
    /** canvas-haz.9: the user-assigned managed identity's client id (AZURE_CLIENT_ID). */
    managedIdentityClientId?: string;
  };
  /**
   * canvas-ez1.1: how people sign in. 'entra' (the default): Entra ID SSO when OIDC_* is set, plus
   * the dev-only local fallback below when ALLOW_LOCAL_AUTH=true. 'local': Canvas-managed email +
   * password accounts only -- local sign-in is forced on and the Entra routes are never registered,
   * even if OIDC_* is set (docs/ip-allowlist-security-plan.md option B; meant to run inside the IP
   * allow-list).
   */
  authMode: 'entra' | 'local';
  /** Local email/password auth (research.md §7) — off unless ALLOW_LOCAL_AUTH=true in entra mode;
   *  always on in local mode. */
  allowLocalAuth: boolean;
  /** canvas-ez1.4: password sign-in attempts allowed per client IP per minute (0 = no limit).
   *  LOGIN_RATE_LIMIT; defaults to 20 in local mode and off otherwise (dev/e2e sign in constantly). */
  loginRateLimitPerMinute: number;
  /** canvas-ez1.5: every Canvas-password account must set up two-step verification (TOTP).
   *  MFA_REQUIRED; defaults to true in local mode, false otherwise (dev/e2e opt in per account). */
  mfaRequired: boolean;
  /** canvas-ez1.5: 32-byte AES-256-GCM key encrypting stored TOTP secrets (MFA_ENCRYPTION_KEY,
   *  base64). Required in production local mode; otherwise derived from the session secret. */
  mfaEncryptionKey: Buffer;
  /** canvas-3s5.1: the GitHub App Canvas submits diagrams with; undefined = the integration is off
   *  (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY both needed; 'unset' counts as missing). */
  github?: GitHubAppConfig;
  /** canvas-3s5.1: the web app's public address, for links back to Canvas (CANVAS_PUBLIC_URL;
   *  defaults to the first WEB_ORIGINS entry). */
  publicUrl: string;
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
  /** canvas-4xo: a session unused for this long expires (the cookie's Max-Age, refreshed on every
   *  request). SESSION_IDLE_MINUTES, default 480 (8 hours). */
  sessionIdleMinutes: number;
  /** canvas-4xo: a signed-in session ends this long after sign-in, however active.
   *  SESSION_MAX_HOURS, default 12. */
  sessionMaxHours: number;
  /** Serves an OpenAPI/Swagger spec + interactive UI at /docs (app.ts). Opt-in, same posture as
   *  allowLocalAuth above: false unless explicitly enabled, so the public Azure deployment doesn't
   *  expose its full route surface by default just because this repo added the capability — a
   *  deliberate choice to make later, not an accidental default. */
  enableApiDocs: boolean;
  /** canvas-r3y: the built web app to serve from this origin (the container image sets it). */
  webDistDir?: string;
  /** canvas-1bty.3: the Python service (move to Python, docs/python-backend-assessment.md). When set,
   *  requests under pythonRoutePrefixes are forwarded there; unset = nothing is forwarded. */
  pythonApiUrl?: string;
  /** canvas-1bty.3: route prefixes the Python service now answers (PYTHON_ROUTES, comma-separated). */
  pythonRoutePrefixes: string[];
  /** canvas-r3y: pause.sh sets CANVAS_PAUSED=true -- every request gets the "paused" page / a 503. */
  paused: boolean;
  /** canvas-r3y: the page shown while paused. */
  pausedPagePath?: string;
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

  const authMode = env.AUTH_MODE ?? 'entra';
  if (authMode !== 'entra' && authMode !== 'local') {
    throw new Error(`AUTH_MODE must be "entra" or "local" (got: ${authMode})`);
  }
  // In local mode the Entra settings are ignored entirely -- including validating them.
  if (authMode === 'entra') validateOidcIssuerUrl(env.OIDC_ISSUER_URL);

  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: isTest
      ? dbClient === 'sqlite'
        ? TEST_SQLITE_DATABASE_URL
        : TEST_DATABASE_URL
      : requireEnv(env, 'DATABASE_URL'),
    dbClient,
    sessionSecret: isTest ? TEST_SESSION_SECRET : requireEnv(env, 'SESSION_SECRET'),
    oidc:
      authMode === 'local'
        ? {}
        : {
            issuerUrl: env.OIDC_ISSUER_URL,
            clientId: env.OIDC_CLIENT_ID,
            clientSecret: env.OIDC_CLIENT_SECRET,
            redirectUri: env.OIDC_REDIRECT_URI,
            clientAuth: env.OIDC_CLIENT_AUTH === 'managed-identity' ? 'managed-identity' : 'secret',
            ...(env.AZURE_CLIENT_ID ? { managedIdentityClientId: env.AZURE_CLIENT_ID } : {}),
          },
    authMode,
    allowLocalAuth: authMode === 'local' || env.ALLOW_LOCAL_AUTH === 'true',
    loginRateLimitPerMinute: parseLoginRateLimit(env.LOGIN_RATE_LIMIT, authMode),
    mfaRequired: env.MFA_REQUIRED === undefined || env.MFA_REQUIRED === '' ? authMode === 'local' : env.MFA_REQUIRED === 'true',
    mfaEncryptionKey: parseMfaEncryptionKey(env, authMode, isTest ? TEST_SESSION_SECRET : env.SESSION_SECRET),
    github: parseGitHubConfig(env),
    publicUrl: (env.CANVAS_PUBLIC_URL ?? (env.WEB_ORIGINS ?? 'http://localhost:5173').split(',')[0]).trim().replace(/\/+$/, ''),
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()),
    cookieSecure,
    cookieSameSite,
    enableApiDocs: env.ENABLE_API_DOCS === 'true',
    ...(env.WEB_DIST_DIR ? { webDistDir: env.WEB_DIST_DIR } : {}),
    paused: env.CANVAS_PAUSED === 'true',
    ...parsePythonRouting(env),
    ...(env.PAUSED_PAGE_PATH ? { pausedPagePath: env.PAUSED_PAGE_PATH } : {}),
    sessionIdleMinutes: positiveNumber(env, 'SESSION_IDLE_MINUTES', 480),
    sessionMaxHours: positiveNumber(env, 'SESSION_MAX_HOURS', 12),
  };
}

/** canvas-4xo: a positive number from the environment, or the fallback when unset; anything else is
 *  a startup error rather than a silently ignored setting. */
/** canvas-1bty.3: PYTHON_API_URL (http/https) and PYTHON_ROUTES (default "/py"). Each prefix is a plain
 *  path ("/py", "/projects") -- never "/" (that would forward everything, the web app included). */
function parsePythonRouting(env: NodeJS.ProcessEnv): Pick<AppConfig, 'pythonApiUrl' | 'pythonRoutePrefixes'> {
  const url = env.PYTHON_API_URL?.trim();
  if (!url) return { pythonRoutePrefixes: [] };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`PYTHON_API_URL is not a URL (got: ${url})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('PYTHON_API_URL must be http:// or https://');
  const prefixes = (env.PYTHON_ROUTES ?? '/py')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p === '/' ? p : p.replace(/\/+$/, '')));
  for (const prefix of prefixes) {
    if (!/^(\/[a-z0-9][a-z0-9-]*)+$/.test(prefix)) throw new Error(`PYTHON_ROUTES: "${prefix}" is not a route prefix like /py or /projects`);
  }
  return { pythonApiUrl: url.replace(/\/+$/, ''), pythonRoutePrefixes: prefixes };
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (got "${raw}").`);
  }
  return value;
}

function parseLoginRateLimit(value: string | undefined, authMode: 'entra' | 'local'): number {
  if (value === undefined || value === '') return authMode === 'local' ? 20 : 0;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`LOGIN_RATE_LIMIT must be a whole number, 0 or more (got: ${value})`);
  }
  return limit;
}

function parseMfaEncryptionKey(env: NodeJS.ProcessEnv, authMode: 'entra' | 'local', sessionSecret: string | undefined): Buffer {
  if (env.MFA_ENCRYPTION_KEY) {
    const key = Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`).');
    return key;
  }
  if (authMode === 'local' && env.NODE_ENV === 'production') {
    throw new Error('MFA_ENCRYPTION_KEY is required with AUTH_MODE=local in production.');
  }
  // Dev/test: a key derived from the session secret, so nothing extra has to be configured.
  return createHash('sha256').update(`canvas-mfa-key:${sessionSecret ?? ''}`).digest();
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: KeyObject;
  /** REST API base, e.g. https://api.github.com (configurable for tests / later GitHub Enterprise). */
  apiUrl: string;
}

/** canvas-3s5.1: GitHub App settings. A bad private key fails startup here, not at first use. */
function parseGitHubConfig(env: NodeJS.ProcessEnv): GitHubAppConfig | undefined {
  const appId = env.GITHUB_APP_ID?.trim();
  const rawKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || appId === 'unset' || !rawKey || rawKey === 'unset') return undefined;
  if (!/^\d+$/.test(appId)) throw new Error(`GITHUB_APP_ID must be the App's numeric id (got: ${appId})`);
  // The PEM as downloaded from GitHub, or base64 of it (easier to keep in Key Vault).
  const pem = rawKey.includes('-----BEGIN') ? rawKey.replace(/\\n/g, '\n') : Buffer.from(rawKey, 'base64').toString('utf8');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not a valid private key (PEM, or base64 of the PEM).');
  }
  // Not GITHUB_API_URL: GitHub Actions sets that on every runner and won't let a workflow override it.
  const apiUrl = (env.GITHUB_APP_API_URL ?? 'https://api.github.com').trim().replace(/\/+$/, '');
  const url = new URL(apiUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) throw new Error(`GITHUB_APP_API_URL must use https (got: ${apiUrl})`);
  return { appId, privateKey, apiUrl };
}
