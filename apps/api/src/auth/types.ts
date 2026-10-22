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
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    user?: SessionUser;
    /** canvas-4xo: when this session signed in (epoch ms); the absolute lifetime runs from it. */
    authenticatedAt?: number;
  }
}
