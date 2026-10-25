import { getDb } from '../db/client.js';
import { currentTimestamp, dbBoolean, fromDbBoolean } from '../db/sql-helpers.js';
import { defaultModelId } from './provider.js';

export type AiProviderKind = 'anthropic' | 'openai' | 'mock' | 'unconfigured';

export interface AiSettings {
  chatEnabled: boolean;
  /** canvas-4k9: show token counts in the chat panel to non-admins (admins always see them). */
  showUsageToUsers: boolean;
  provider: AiProviderKind;
  /** canvas-tj1: the model the admin chose (null = the default). */
  modelId: string | null;
  /** The model used when none is chosen (AI_MODEL, else the provider's built-in default). */
  defaultModelId: string | null;
  /** What chats actually use. */
  effectiveModelId: string | null;
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
  const db = getDb();
  const row = await db.selectFrom('ai_settings').select(['chat_enabled', 'show_usage_to_users', 'model_id']).executeTakeFirstOrThrow();
  const provider = resolveAiProviderKind();
  const fallback = defaultModelId();
  // The mock has one model whatever is stored.
  const chosen = provider === 'mock' ? null : row.model_id;
  return {
    chatEnabled: fromDbBoolean(row.chat_enabled),
    showUsageToUsers: fromDbBoolean(row.show_usage_to_users),
    provider,
    modelId: chosen,
    defaultModelId: fallback,
    effectiveModelId: chosen ?? fallback,
  };
}

/** `provider` is read-only/derived from the environment, not stored — only `chatEnabled` is ever
 *  written. Deliberately a separate, narrower input type from `AiSettings` rather than reusing it
 *  with an ignored field, so a caller can't be misled into thinking they can set the provider. */
export interface SetAiSettingsInput {
  chatEnabled?: boolean;
  showUsageToUsers?: boolean;
  /** canvas-tj1: null = back to the default. Validated against the provider's list by the route. */
  modelId?: string | null;
}

export async function setAiSettings(input: SetAiSettingsInput): Promise<AiSettings> {
  const db = getDb();
  await db
    .updateTable('ai_settings')
    .set({
      chat_enabled: input.chatEnabled === undefined ? undefined : dbBoolean(input.chatEnabled),
      show_usage_to_users: input.showUsageToUsers === undefined ? undefined : dbBoolean(input.showUsageToUsers),
      model_id: input.modelId,
      updated_at: currentTimestamp(),
    })
    .execute();
  return getAiSettings();
}

/** canvas-4k9: whether this user may see token counts (admins always may). */
export async function canSeeUsage(role: string | undefined): Promise<boolean> {
  if (role === 'admin') return true;
  return (await getAiSettings()).showUsageToUsers;
}

/** canvas-tj1: the admin's chosen model, for building the chat's language model. */
export async function chosenModelId(): Promise<string | null> {
  const row = await getDb().selectFrom('ai_settings').select('model_id').executeTakeFirst();
  return row?.model_id ?? null;
}
