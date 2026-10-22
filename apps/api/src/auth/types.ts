export type UserRole = 'admin' | 'architect' | 'viewer';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  personas: string[];
  /** canvas-ez1.2: signed in with a Canvas password (not SSO), so it can be changed. */
  localAccount?: boolean;
  /** canvas-ez1.2: signed in with a one-time password -- must change it before anything else. */
  mustChangePassword?: boolean;
  /** canvas-ez1.5: two-step verification is required but not set up yet -- set it up first. */
  mustEnrollMfa?: boolean;
  /** canvas-ez1.5: two-step verification is set up for this account. */
  mfaEnabled?: boolean;
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    user?: SessionUser;
    /** canvas-4xo: when this session signed in (epoch ms); the absolute lifetime runs from it. */
    authenticatedAt?: number;
    /** canvas-ez1.5: the password was right; waiting for the second step (not signed in yet). */
    mfaPending?: { userId: string; startedAt: number };
  }
}
