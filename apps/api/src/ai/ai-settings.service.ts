import { getPool } from '../db/pool.js';

export type AiProviderKind = 'anthropic' | 'openai' | 'mock' | 'unconfigured';

export interface AiSettings {
  chatEnabled: boolean;
  provider: AiProviderKind;
}

/**
 * canvas-wuc: which provider `AI_PROVIDER` currently resolves to, for display only — never used
 * to decide whether to actually route a request (provider.ts's `getLanguageModel` remains the
 * sole source of truth for that, and still throws its own `UnconfiguredAiProviderError` if
 * misconfigured). `AI_PROVIDER=mock` is meant for E2E/local testing only (server.ts); exposing it
 * here lets the client warn if a real deployment ever ends up running it by mistake — the exact
 * env-var-lost-on-restart drift that motivated this bead — instead of silently degrading to the
 * rule-based fake NLU with no visible sign anything is wrong. Takes an `env` parameter (default
 * `process.env`) purely so it's unit-testable without mutating the real process env, mirroring
 * `provider.ts`'s own `getLanguageModel(env = process.env)` and `config.ts`'s `loadConfig`.
 */
export function resolveAiProviderKind(env: NodeJS.ProcessEnv = process.env): AiProviderKind {
  if (env.AI_PROVIDER === 'mock') return 'mock';
  if (env.AI_PROVIDER === 'anthropic') return 'anthropic';
  if (env.AI_PROVIDER === 'openai') return 'openai';
  return 'unconfigured';
}

/** Singleton `ai_settings` row (FR-020) — platform-wide AI chat on/off, separate from and in
 * addition to which provider is configured (research.md §5). */
export async function getAiSettings(): Promise<AiSettings> {
  const pool = getPool();
  const { rows } = await pool.query<{ chat_enabled: boolean }>('SELECT chat_enabled FROM ai_settings');
  return { chatEnabled: rows[0].chat_enabled, provider: resolveAiProviderKind() };
}

/** `provider` is read-only/derived from the environment, not stored — only `chatEnabled` is ever
 *  written. Deliberately a separate, narrower input type from `AiSettings` rather than reusing it
 *  with an ignored field, so a caller can't be misled into thinking they can set the provider. */
export interface SetAiSettingsInput {
  chatEnabled: boolean;
}

export async function setAiSettings(input: SetAiSettingsInput): Promise<AiSettings> {
  const pool = getPool();
  await pool.query('UPDATE ai_settings SET chat_enabled = $1, updated_at = now()', [input.chatEnabled]);
  return getAiSettings();
}
