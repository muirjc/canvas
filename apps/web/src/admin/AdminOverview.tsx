import { useEffect, useState } from 'react';
import { api, type AdminOverviewDto } from '../app/api';

/**
 * Admin-console landing view (FR-023): the console's numbers at a glance. canvas-789: each count
 * is a card that opens its page -- the "Manage Standards"/"Manage Users" links it used to end
 * with duplicated the admin tab row directly above (and covered only two of its destinations).
 * canvas-3dq: the libraries card opens the Libraries page too.
 */
export function AdminOverview() {
  const [overview, setOverview] = useState<AdminOverviewDto | null>(null);

  useEffect(() => {
    api.getAdminOverview().then(({ overview }) => setOverview(overview));
  }, []);

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
    </div>
  );
}
