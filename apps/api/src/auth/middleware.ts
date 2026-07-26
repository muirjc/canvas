import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionUser, UserRole } from './types.js';

export function getSessionUser(request: FastifyRequest): SessionUser | undefined {
  return request.session.user;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.session.user) {
    reply.code(401).send({ error: 'Authentication required' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.session.user;
    if (!user) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(user.role)) {
      reply.code(403).send({
        error: `This action requires one of the following roles: ${roles.join(', ')}`,
      });
    }
  };
}
