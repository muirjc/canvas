import type { FastifyInstance } from 'fastify';
import { getPool } from '../db/pool.js';
import { verifyPassword } from './password.js';
import type { SessionUser, UserRole } from './types.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  personas: string[];
  active: boolean;
}

/** Local email/password login — only registered when config.allowLocalAuth is true. */
export async function registerLocalAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email: string; password: string } }>('/auth/local/login', async (request, reply) => {
    const { email, password } = request.body;
    if (!email || !password) {
      reply.code(400).send({ error: 'email and password are required' });
      return;
    }

    const pool = getPool();
    const { rows } = await pool.query<UserRow & { password_hash: string; password_salt: string }>(
      `SELECT u.id, u.email, u.name, u.role, u.personas, u.active, c.password_hash, c.password_salt
       FROM users u JOIN local_credentials c ON c.user_id = u.id
       WHERE u.email = $1`,
      [email],
    );
    const row = rows[0];
    if (!row || !row.active || !verifyPassword(password, row.password_hash, row.password_salt)) {
      reply.code(401).send({ error: 'Invalid email or password' });
      return;
    }

    const user: SessionUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      personas: row.personas,
    };
    request.session.user = user;
    reply.send({ user });
  });

  app.post('/auth/logout', async (request, reply) => {
    await request.session.destroy();
    reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    if (!request.session.user) {
      reply.code(401).send({ error: 'Not authenticated' });
      return;
    }
    reply.send({ user: request.session.user });
  });
}
