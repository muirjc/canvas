import { getPool } from '../db/pool.js';

export interface AiSettings {
  chatEnabled: boolean;
}

/** Singleton `ai_settings` row (FR-020) — platform-wide AI chat on/off, separate from and in
 * addition to which provider is configured (research.md §5). */
export async function getAiSettings(): Promise<AiSettings> {
  const pool = getPool();
  const { rows } = await pool.query<{ chat_enabled: boolean }>('SELECT chat_enabled FROM ai_settings');
  return { chatEnabled: rows[0].chat_enabled };
}

export async function setAiSettings(input: AiSettings): Promise<AiSettings> {
  const pool = getPool();
  await pool.query('UPDATE ai_settings SET chat_enabled = $1, updated_at = now()', [input.chatEnabled]);
  return getAiSettings();
}
