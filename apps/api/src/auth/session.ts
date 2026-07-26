import cookie from '@fastify/cookie';
import session from '@fastify/session';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

export async function registerSession(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
    },
  });
}
