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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: requireEnv(
      'DATABASE_URL',
      env.NODE_ENV === 'test'
        ? 'postgres://canvas:canvas_dev_password@localhost:5433/canvas_test'
        : undefined,
    ),
    sessionSecret: requireEnv(
      'SESSION_SECRET',
      env.NODE_ENV === 'test' ? 'test-secret-at-least-32-characters-long' : undefined,
    ),
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
