import { useEffect, useState } from 'react';
import { api, type MyAiUsageDto } from '../app/api';
import { formatTokens } from './usage-format';

/** "Your AI usage this month" on the account screen; hidden when the admin turned counts off. */
export function MyAiUsage() {
  const [usage, setUsage] = useState<MyAiUsageDto | null>(null);

  useEffect(() => {
    api.getMyAiUsage().then(setUsage).catch(() => setUsage(null));
  }, []);

  if (!usage || !usage.visible) return null;
  return (
    <section className="card stack" data-testid="my-ai-usage" aria-labelledby="my-ai-usage-heading" style={{ marginBlockStart: 'var(--space-6)' }}>
      <h2 id="my-ai-usage-heading">Your AI usage this month</h2>
      <p>
        {formatTokens(usage.totalTokens)} tokens across {formatTokens(usage.requests)} {usage.requests === 1 ? 'request' : 'requests'}
        <span className="meta">
          {' '}
          ({formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out)
        </span>
      </p>
    </section>
  );
}
