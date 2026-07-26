export type UserRole = 'admin' | 'architect' | 'viewer';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  personas: string[];
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    user?: SessionUser;
  }
}
