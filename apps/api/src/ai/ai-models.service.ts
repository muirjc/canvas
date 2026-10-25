/**
 * canvas-tj1: the models the configured provider offers, for the admin's model picker -- from the
 * provider's own list-models API (Anthropic GET /v1/models, OpenAI GET /v1/models), cached for a
 * few minutes. OpenAI's list includes embedding, image, audio and moderation models; only chat
 * models are offered.
 */
export class AiModelListError extends Error {}

export interface AiModelOption {
  id: string;
  name: string;
  createdAt: string | null;
}

const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
let cache: { key: string; at: number; models: AiModelOption[] } | null = null;

/** Tests only. */
export function clearAiModelCache(): void {
  cache = null;
}

const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|computer-use|dall-e|whisper)/;

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AiModelListError('The AI provider could not be reached to list its models.');
  }
  if (!response.ok) {
    throw new AiModelListError(
      response.status === 401 || response.status === 403
        ? 'The AI provider rejected the API key while listing models.'
        : `The AI provider returned ${response.status} while listing models.`,
    );
  }
  return response.json();
}

async function listAnthropic(fetchImpl: typeof fetch, apiKey: string): Promise<AiModelOption[]> {
  const models: AiModelOption[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const url = `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const body = (await getJson(fetchImpl, url, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })) as {
      data: { id: string; display_name?: string; created_at?: string }[];
      has_more?: boolean;
      last_id?: string;
    };
    models.push(...body.data.map((m) => ({ id: m.id, name: m.display_name || m.id, createdAt: m.created_at ?? null })));
    if (!body.has_more || !body.last_id) break;
    after = body.last_id;
  }
  return models;
}

async function listOpenAi(fetchImpl: typeof fetch, apiKey: string): Promise<AiModelOption[]> {
  const body = (await getJson(fetchImpl, 'https://api.openai.com/v1/models', { authorization: `Bearer ${apiKey}` })) as {
    data: { id: string; created?: number }[];
  };
  return body.data
    .filter((m) => OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id))
    .map((m) => ({ id: m.id, name: m.id, createdAt: m.created ? new Date(m.created * 1000).toISOString() : null }));
}

/** Newest first; the provider's list, or the mock's one model. */
export async function listAiModels(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<AiModelOption[]> {
  const provider = env.AI_PROVIDER;
  if (provider === 'mock') return [{ id: 'mock', name: 'Mock (rule-based, no AI provider)', createdAt: null }];
  const apiKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : undefined;
  if (!apiKey || apiKey === 'unset') throw new AiModelListError('No AI provider is configured (AI_PROVIDER and its API key).');
  const key = `${provider}:${apiKey.slice(-6)}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.models;
  const models = provider === 'anthropic' ? await listAnthropic(fetchImpl, apiKey) : await listOpenAi(fetchImpl, apiKey);
  models.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
  cache = { key, at: Date.now(), models };
  return models;
}
