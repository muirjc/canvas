import pg from 'pg';
import { loadConfig } from '../config.js';

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.databaseUrl });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
