import { useEffect, useState } from 'react';
import { api, type AiPriceDto } from '../app/api';
import { Modal } from '../ui/Modal';

const blank = { provider: '', modelId: '', input: '', output: '', cacheRead: '', cacheWrite: '' };

/** Price editor for AI models (USD per million tokens); the numbers behind the estimated cost. */
export function AiPrices({ onChanged }: { onChanged: () => void }) {
  const [prices, setPrices] = useState<AiPriceDto[]>([]);
  const [unpriced, setUnpriced] = useState<Array<{ provider: string; modelId: string }>>([]);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<AiPriceDto | null>(null);

  const refresh = () =>
    api.listAiPrices().then((result) => {
      setPrices(result.prices);
      setUnpriced(result.unpricedModels);
    });

  useEffect(() => {
    void refresh().catch((err) => setError((err as Error).message));
  }, []);

  const set = (key: keyof typeof blank, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const toNumber = (value: string) => (value.trim() === '' ? undefined : Number(value));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const input = Number(form.input);
    const output = Number(form.output);
    const cacheRead = toNumber(form.cacheRead);
    const cacheWrite = toNumber(form.cacheWrite);
    const bad = [input, output, cacheRead, cacheWrite].some((n) => n !== undefined && (!Number.isFinite(n) || n < 0));
    if (!form.provider.trim() || !form.modelId.trim() || form.input.trim() === '' || form.output.trim() === '' || bad) {
      setError('Enter a provider, a model, and input and output prices of 0 or more.');
      return;
    }
    setSaving(true);
    try {
      await api.saveAiPrice({
        provider: form.provider.trim(),
        modelId: form.modelId.trim(),
        inputPerMillion: input,
        outputPerMillion: output,
        cacheReadPerMillion: cacheRead,
        cacheWritePerMillion: cacheWrite,
      });
      setForm(blank);
      await refresh();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const edit = (p: AiPriceDto) =>
    setForm({
      provider: p.provider,
      modelId: p.modelId,
      input: String(p.inputPerMillion),
      output: String(p.outputPerMillion),
      cacheRead: String(p.cacheReadPerMillion),
      cacheWrite: String(p.cacheWritePerMillion),
    });

  const confirmRemove = async () => {
    const target = removing;
    setRemoving(null);
    if (!target) return;
    try {
      await api.deleteAiPrice(target.provider, target.modelId);
      await refresh();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const field = (key: keyof typeof blank, label: string, testId: string, numeric = true) => (
    <div className="field">
      <label className="field__label" htmlFor={testId}>
        {label}
      </label>
      <input
        id={testId}
        data-testid={testId}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        {...(numeric ? { type: 'number', min: 0, step: 'any', inputMode: 'decimal' as const } : { type: 'text', autoComplete: 'off' })}
      />
    </div>
  );

  return (
    <section id="ai-prices" className="stack" data-testid="ai-prices" aria-labelledby="ai-prices-heading" style={{ marginBlockStart: 'var(--space-8)' }}>
      <h2 id="ai-prices-heading">Model prices</h2>
      <p className="meta">US dollars per million tokens. Used only to estimate cost.</p>

      {unpriced.length > 0 && (
        <div data-testid="ai-unpriced-models">
          <p>Models used but with no price set:</p>
          <ul className="cluster" style={{ listStyle: 'none', padding: 0 }}>
            {unpriced.map((m, i) => (
              <li key={`${m.provider}/${m.modelId}`}>
                <button
                  type="button"
                  className="btn btn--secondary btn--compact"
                  data-testid={`ai-price-add-${i}`}
                  onClick={() => setForm({ ...blank, provider: m.provider, modelId: m.modelId })}
                >
                  Set price: {m.provider} / {m.modelId}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {prices.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Model prices">
          <table data-testid="ai-price-table">
            <caption className="visually-hidden">Model prices in US dollars per million tokens</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col" className="num">Input</th>
                <th scope="col" className="num">Output</th>
                <th scope="col" className="num">Cache read</th>
                <th scope="col" className="num">Cache write</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p, i) => (
                <tr key={`${p.provider}/${p.modelId}`} data-testid={`ai-price-row-${i}`}>
                  <td>{p.provider}</td>
                  <td>{p.modelId}</td>
                  <td className="num">{p.inputPerMillion}</td>
                  <td className="num">{p.outputPerMillion}</td>
                  <td className="num">{p.cacheReadPerMillion}</td>
                  <td className="num">{p.cacheWritePerMillion}</td>
                  <td>
                    <button type="button" className="btn btn--secondary btn--compact" data-testid={`ai-price-edit-${i}`} aria-label={`Edit price for ${p.modelId}`} onClick={() => edit(p)}>
                      Edit
                    </button>{' '}
                    <button type="button" className="btn btn--secondary btn--compact" data-testid={`ai-price-remove-${i}`} aria-label={`Remove price for ${p.modelId}`} onClick={() => setRemoving(p)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="card" onSubmit={save} noValidate aria-label="Add or edit a price">
        {field('provider', 'Provider', 'ai-price-provider', false)}
        {field('modelId', 'Model', 'ai-price-model', false)}
        {field('input', 'Input ($ per 1M tokens)', 'ai-price-input')}
        {field('output', 'Output ($ per 1M tokens)', 'ai-price-output')}
        {field('cacheRead', 'Cache read ($ per 1M, optional)', 'ai-price-cache-read')}
        {field('cacheWrite', 'Cache write ($ per 1M, optional)', 'ai-price-cache-write')}
        {error && (
          <p role="alert" className="field__error" data-testid="ai-price-error">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary" data-testid="ai-price-save" disabled={saving}>
          Save price
        </button>
      </form>

      {removing && (
        <Modal
          role="alertdialog"
          label="Remove price"
          testId="ai-price-remove-dialog"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" data-testid="ai-price-remove-confirm" onClick={confirmRemove}>
                Remove
              </button>
            </>
          }
        >
          <p>
            Remove the price for {removing.provider} / {removing.modelId}? Its usage will then count as unpriced.
          </p>
        </Modal>
      )}
    </section>
  );
}
