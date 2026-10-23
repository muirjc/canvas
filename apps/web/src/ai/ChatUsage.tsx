import type { ChatUsageDto, ChatUsageTotalDto } from '../app/api';
import { formatTokens } from './usage-format';

/** Subtle per-reply token count; renders nothing when the API omitted usage. */
export function ChatUsageLine({ messageId, usage }: { messageId: string; usage?: ChatUsageDto }) {
  if (!usage) return null;
  return (
    <span className="meta chat-usage" data-testid={`chat-usage-${messageId}`} title={`${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`}>
      {formatTokens(usage.totalTokens)} tokens
    </span>
  );
}

export function ChatUsageTotal({ total }: { total?: ChatUsageTotalDto | null }) {
  if (!total) return null;
  return (
    <p className="meta chat-usage-total" data-testid="chat-usage-total">
      This conversation: {formatTokens(total.totalTokens)} tokens · {formatTokens(total.requests)} {total.requests === 1 ? 'request' : 'requests'}
    </p>
  );
}

export function addUsage(total: ChatUsageTotalDto | null | undefined, usage: ChatUsageDto | undefined): ChatUsageTotalDto | null {
  if (!usage) return total ?? null;
  const base = total ?? { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    requests: base.requests + 1,
    inputTokens: base.inputTokens + usage.inputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    totalTokens: base.totalTokens + usage.totalTokens,
  };
}
