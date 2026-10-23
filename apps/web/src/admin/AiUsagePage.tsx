import { useEffect, useMemo, useState } from 'react';
import { api, type AiUsageDetailDto, type AiUsageTotals, type AiUsageUserDto } from '../app/api';

type Period = '7d' | '30d' | 'month' | 'custom';
type SortKey = 'name' | 'requests' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'lastUsedAt';

const number = new Intl.NumberFormat();
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const DAY_MS = 24 * 60 * 60 * 1000;

const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The [from, to) range for a period, as ISO strings. Custom dates are local days, `to` inclusive. */
function rangeFor(period: Period, customFrom: string, customTo: string): { from: string; to: string } | null {
  const now = new Date();
  if (period === '7d') return { from: new Date(now.getTime() - 7 * DAY_MS).toISOString(), to: now.toISOString() };
  if (period === '30d') return { from: new Date(now.getTime() - 30 * DAY_MS).toISOString(), to: now.toISOString() };
  if (period === 'month') return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: now.toISOString() };
  if (!customFrom || !customTo) return null;
  const from = new Date(`${customFrom}T00:00:00`);
  const to = new Date(`${customTo}T00:00:00`);
  to.setDate(to.getDate() + 1);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

const labelOf = (u: AiUsageUserDto) => u.name || u.email || 'Unknown user';

/** Admin view of AI token usage per user (canvas-9af). */
export function AiUsagePage() {
  const [period, setPeriod] = useState<Period>('30d');
  const [customFrom, setCustomFrom] = useState(() => toDateInput(new Date(Date.now() - 30 * DAY_MS)));
  const [customTo, setCustomTo] = useState(() => toDateInput(new Date()));
  const [users, setUsers] = useState<AiUsageUserDto[]>([]);
  const [totals, setTotals] = useState<AiUsageTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'totalTokens', dir: 'desc' });
  const [selected, setSelected] = useState<AiUsageUserDto | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  const invalidCustom = period === 'custom' && !rangeFor(period, customFrom, customTo);

  useEffect(() => {
    const next = rangeFor(period, customFrom, customTo);
    if (!next) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getAiUsage(next)
      .then((result) => {
        if (cancelled) return;
        setUsers(result.users);
        setTotals(result.totals);
        setRange(next);
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [period, customFrom, customTo]);

  const sorted = useMemo(() => {
    const value = (u: AiUsageUserDto): string | number => {
      if (sort.key === 'name') return labelOf(u).toLowerCase();
      if (sort.key === 'lastUsedAt') return u.lastUsedAt ? Date.parse(u.lastUsedAt) : 0;
      return u[sort.key];
    };
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...users].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * factor;
    });
  }, [users, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  const showCache = users.some((u) => u.cacheReadTokens > 0 || u.cacheWriteTokens > 0);

  if (selected && range) {
    return <UsageDetail user={selected} range={range} onBack={() => setSelected(null)} />;
  }

  const header = (key: SortKey, label: string, numeric = true) => (
    <th scope="col" className={numeric ? 'num' : undefined} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" data-testid={`ai-usage-sort-${key}`} onClick={() => toggleSort(key)}>
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );

  return (
    <div>
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        AI usage
      </h1>
      <div className="cluster" style={{ marginBlockEnd: 'var(--space-4)', alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBlockEnd: 0 }}>
          <label className="field__label" htmlFor="ai-usage-period">
            Period
          </label>
          <select id="ai-usage-period" data-testid="ai-usage-period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="month">This month</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        {period === 'custom' && (
          <>
            <div className="field" style={{ marginBlockEnd: 0 }}>
              <label className="field__label" htmlFor="ai-usage-from">
                From
              </label>
              <input id="ai-usage-from" data-testid="ai-usage-from" type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
            </div>
            <div className="field" style={{ marginBlockEnd: 0 }}>
              <label className="field__label" htmlFor="ai-usage-to">
                To
              </label>
              <input id="ai-usage-to" data-testid="ai-usage-to" type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          </>
        )}
      </div>
      {invalidCustom && <p role="alert">Choose a start date that is on or before the end date.</p>}
      {error && <p role="alert">{error}</p>}
      <p className="meta">Numbers come from the provider's reported usage for each chat turn. With the mock provider they are estimates.</p>

      {totals && (
        <ul className="admin-stats" aria-label="Totals for the period">
          <StatCard testId="ai-usage-total-tokens" label="Total tokens" value={totals.totalTokens} />
          <StatCard testId="ai-usage-total-input" label="Input tokens" value={totals.inputTokens} />
          <StatCard testId="ai-usage-total-output" label="Output tokens" value={totals.outputTokens} />
          <StatCard testId="ai-usage-total-requests" label="Requests" value={totals.requests} />
          {totals.failedRequests > 0 && <StatCard testId="ai-usage-total-failed" label="Failed requests" value={totals.failedRequests} />}
        </ul>
      )}

      {!loading && !error && users.length === 0 ? (
        <p className="state" data-testid="ai-usage-empty">
          No AI usage in this period
        </p>
      ) : (
        users.length > 0 && (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="AI usage by user">
            <table data-testid="ai-usage-table">
              <caption className="visually-hidden">AI usage by user for the selected period</caption>
              <thead>
                <tr>
                  {header('name', 'User', false)}
                  {header('requests', 'Requests')}
                  {header('inputTokens', 'Input')}
                  {header('outputTokens', 'Output')}
                  {header('totalTokens', 'Total')}
                  {showCache && (
                    <th scope="col" className="num">
                      Cache read / write
                    </th>
                  )}
                  {header('lastUsedAt', 'Last used', false)}
                </tr>
              </thead>
              <tbody>
                {sorted.map((u) => (
                  <tr key={u.userId ?? 'unknown'} data-testid={`ai-usage-row-${u.userId ?? 'unknown'}`}>
                    <th scope="row">
                      {u.userId ? (
                        <button type="button" className="link-button" data-testid={`ai-usage-user-${u.userId}`} onClick={() => setSelected(u)}>
                          {labelOf(u)}
                        </button>
                      ) : (
                        labelOf(u)
                      )}
                      {u.name && u.email && <span className="meta"> {u.email}</span>}
                    </th>
                    <td className="num">{number.format(u.requests)}</td>
                    <td className="num">{number.format(u.inputTokens)}</td>
                    <td className="num">{number.format(u.outputTokens)}</td>
                    <td className="num">{number.format(u.totalTokens)}</td>
                    {showCache && (
                      <td className="num">
                        {number.format(u.cacheReadTokens)} / {number.format(u.cacheWriteTokens)}
                      </td>
                    )}
                    <td>{u.lastUsedAt ? dateTime.format(new Date(u.lastUsedAt)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function StatCard({ testId, label, value }: { testId: string; label: string; value: number }) {
  return (
    <li>
      <div className="card admin-stat">
        <span className="admin-stat__value" data-testid={testId}>
          {number.format(value)}
        </span>
        <span className="admin-stat__label">{label}</span>
      </div>
    </li>
  );
}

function UsageDetail({ user, range, onBack }: { user: AiUsageUserDto; range: { from: string; to: string }; onBack: () => void }) {
  const [detail, setDetail] = useState<AiUsageDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user.userId) return;
    api
      .getAiUsageForUser(user.userId, range)
      .then(setDetail)
      .catch((err) => setError((err as Error).message));
  }, [user.userId, range]);

  const showCache = !!detail && [...detail.byDay, ...detail.byModel].some((r) => r.cacheReadTokens > 0 || r.cacheWriteTokens > 0);

  const cells = (r: AiUsageTotals) => (
    <>
      <td className="num">{number.format(r.requests)}</td>
      <td className="num">{number.format(r.inputTokens)}</td>
      <td className="num">{number.format(r.outputTokens)}</td>
      <td className="num">{number.format(r.totalTokens)}</td>
      {showCache && (
        <td className="num">
          {number.format(r.cacheReadTokens)} / {number.format(r.cacheWriteTokens)}
        </td>
      )}
    </>
  );
  const heads = (first: string) => (
    <tr>
      <th scope="col">{first}</th>
      <th scope="col" className="num">Requests</th>
      <th scope="col" className="num">Input</th>
      <th scope="col" className="num">Output</th>
      <th scope="col" className="num">Total</th>
      {showCache && (
        <th scope="col" className="num">
          Cache read / write
        </th>
      )}
    </tr>
  );

  return (
    <div data-testid="ai-usage-detail">
      <p>
        <button type="button" className="btn btn--secondary btn--compact" data-testid="ai-usage-back" onClick={onBack}>
          Back to all users
        </button>
      </p>
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        AI usage: {labelOf(user)}
      </h1>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p>Loading…</p>}
      {detail && (
        <div className="stack">
          <div className="table-scroll" tabIndex={0} role="region" aria-label="AI usage by day">
            <table data-testid="ai-usage-by-day">
              <caption className="visually-hidden">AI usage by day (UTC)</caption>
              <thead>{heads('Day (UTC)')}</thead>
              <tbody>
                {detail.byDay.map((r) => (
                  <tr key={r.day}>
                    <th scope="row">{r.day}</th>
                    {cells(r)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="AI usage by model">
            <table data-testid="ai-usage-by-model">
              <caption className="visually-hidden">AI usage by model</caption>
              <thead>{heads('Model')}</thead>
              <tbody>
                {detail.byModel.map((r) => (
                  <tr key={`${r.provider}/${r.modelId}`}>
                    <th scope="row">
                      {r.provider} / {r.modelId}
                    </th>
                    {cells(r)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
