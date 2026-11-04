import { useEffect, useState } from 'react';
import { GITHUB_MERMAID_VERSION, MERMAID_SUPPORT_NOTES, MERMAID_SYNTAX_VERSION, mermaidMajorVersion } from '@canvas/diagram-core';
import { HelpLink } from '../help/HelpLink';
import { api, type AdminOverviewDto, type AppSettingsDto } from '../app/api';

/** '2026-10-31' -> '31 Oct 2026' (UTC, so the day never shifts with the viewer's time zone). */
function readableDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** canvas-7p3y: which Mermaid release Canvas follows, and the one GitHub draws with. */
function MermaidVersionPanel() {
  const githubNewer = mermaidMajorVersion(GITHUB_MERMAID_VERSION.version) > mermaidMajorVersion(MERMAID_SYNTAX_VERSION);
  const gaps = MERMAID_SUPPORT_NOTES.filter((n) => n.notes.length > 0);
  return (
    <section className="admin-settings" aria-labelledby="admin-mermaid-heading" data-testid="mermaid-version-panel">
      <h2 id="admin-mermaid-heading" className="section-label">
        Mermaid version{' '}
        <HelpLink page="admin/operations" section="moving-to-a-newer-mermaid-version" topic="moving to a newer Mermaid version" />
      </h2>
      <div className="card stack">
        <p data-testid="mermaid-syntax-version">Canvas reads and writes Mermaid {MERMAID_SYNTAX_VERSION} syntax.</p>
        <p data-testid="github-mermaid-version">
          GitHub draws diagrams with Mermaid {GITHUB_MERMAID_VERSION.version} (checked {readableDate(GITHUB_MERMAID_VERSION.checkedOn)}).
        </p>
        {githubNewer && (
          <p className="meta" data-testid="mermaid-major-note">
            GitHub may lay out and colour diagrams differently from Canvas. Mermaid {mermaidMajorVersion(GITHUB_MERMAID_VERSION.version)}{' '}
            changed its default layout and look, not the syntax, so diagrams still open there but can look different.
          </p>
        )}
        <details>
          <summary>What Canvas doesn&rsquo;t read yet</summary>
          <ul>
            {gaps.map((g) => (
              <li key={g.family}>
                <strong>{g.label}:</strong> {g.notes.join(' ')}
              </li>
            ))}
          </ul>
          <p className="meta">
            {MERMAID_SUPPORT_NOTES.filter((n) => n.notes.length === 0)
              .map((n) => n.label)
              .join(', ') || 'No other diagram type'}{' '}
            {MERMAID_SUPPORT_NOTES.length - gaps.length > 1 ? 'have' : 'has'} nothing missing.
          </p>
        </details>
      </div>
    </section>
  );
}

/**
 * Admin-console landing view (FR-023): the console's numbers at a glance. canvas-789: each count
 * is a card that opens its page -- the "Manage Standards"/"Manage Users" links it used to end
 * with duplicated the admin tab row directly above (and covered only two of its destinations).
 * canvas-3dq: the libraries card opens the Libraries page too.
 */
export function AdminOverview() {
  const [overview, setOverview] = useState<AdminOverviewDto | null>(null);
  // canvas-8em: platform feature switches.
  const [settings, setSettings] = useState<AppSettingsDto | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    api.getAdminOverview().then(({ overview }) => setOverview(overview));
    api
      .getAppSettings()
      .then(setSettings)
      .catch(() => setSettingsError("Couldn't load the settings."));
  }, []);

  const toggleSharing = async (sharingEnabled: boolean) => {
    setSettingsError(null);
    const previous = settings;
    setSettings((s) => (s ? { ...s, sharingEnabled } : s));
    try {
      setSettings(await api.setAppSettings({ sharingEnabled }));
    } catch {
      setSettings(previous);
      setSettingsError("Couldn't change the setting. Try again.");
    }
  };

  if (!overview) return <p>Loading…</p>;

  return (
    <div>
      {/* canvas-4pw: the page's <h1>, focused after an in-app navigation lands here. */}
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Admin Overview
      </h1>
      <ul className="admin-stats">
        <li>
          <a className="card admin-stat admin-stat--link" href="?admin=users" data-testid="overview-card-users">
            <span className="admin-stat__value" data-testid="overview-user-count">
              {overview.userCount}
            </span>
            <span className="admin-stat__label">{overview.userCount === 1 ? 'User' : 'Users'}</span>
          </a>
        </li>
        <li>
          <a className="card admin-stat admin-stat--link" href="?admin=standards" data-testid="overview-card-standards">
            <span className="admin-stat__value" data-testid="overview-standards-count">
              {overview.publishedStandardsCount} / {overview.standardsCount}
            </span>
            <span className="admin-stat__label">Standards published / total</span>
          </a>
        </li>
        <li>
          <a className="card admin-stat admin-stat--link" href="?admin=libraries" data-testid="overview-card-libraries">
            <span className="admin-stat__value" data-testid="overview-library-count">
              {overview.libraryCount}
            </span>
            <span className="admin-stat__label">Icon/shape libraries</span>
          </a>
        </li>
      </ul>
      <section className="admin-settings" aria-labelledby="admin-settings-heading">
        <h2 id="admin-settings-heading" className="section-label">
          Settings
        </h2>
        <div className="card">
          <label className="row">
            <input
              type="checkbox"
              data-testid="sharing-enabled-toggle"
              checked={settings?.sharingEnabled ?? false}
              disabled={!settings}
              onChange={(e) => void toggleSharing(e.target.checked)}
            />
            <span className="row__main">
              <span className="row__title">Show the Share button in the diagram editor</span>
              <span className="meta">
                When off, people can&rsquo;t share new diagrams from the editor. Existing shares keep working, and shared
                diagrams still appear under &ldquo;Shared with me&rdquo;.
              </span>
            </span>
          </label>
        </div>
        {settingsError && (
          <p role="alert" data-testid="admin-settings-error">
            {settingsError}
          </p>
        )}
      </section>
      <MermaidVersionPanel />
    </div>
  );
}
