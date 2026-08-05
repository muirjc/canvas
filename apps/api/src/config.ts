export interface AppConfig {
  port: number;
  databaseUrl: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isTest = env.NODE_ENV === 'test';
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: isTest ? TEST_DATABASE_URL : requireEnv('DATABASE_URL'),
    sessionSecret: isTest ? TEST_SESSION_SECRET : requireEnv('SESSION_SECRET'),
    oidc: {
      issuerUrl: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI,
    },
    allowLocalAuth: env.ALLOW_LOCAL_AUTH === 'true',
    webOrigins: (env.WEB_ORIGINS ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()),
  };
}
