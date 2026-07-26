import { useEffect, useState } from 'react';
import { api, type AdminOverviewDto } from '../app/api';

/**
 * Single admin-console landing view aggregating standards, libraries, and users (FR-023 —
 * "a single place to manage" — this is the entry point; the individual editors are one click away).
 */
export function AdminOverview() {
  const [overview, setOverview] = useState<AdminOverviewDto | null>(null);

  useEffect(() => {
    api.getAdminOverview().then(({ overview }) => setOverview(overview));
  }, []);

  if (!overview) return <p>Loading…</p>;

  return (
    <div>
      <h2>Admin Overview</h2>
      <dl>
        <dt>Users</dt>
        <dd data-testid="overview-user-count">{overview.userCount}</dd>
        <dt>Standards (published / total)</dt>
        <dd data-testid="overview-standards-count">
          {overview.publishedStandardsCount} / {overview.standardsCount}
        </dd>
        <dt>Icon/Shape Libraries</dt>
        <dd data-testid="overview-library-count">{overview.libraryCount}</dd>
      </dl>
      <nav>
        <a data-testid="overview-link-standards" href="?admin=true">
          Manage Standards
        </a>
        <a data-testid="overview-link-users" href="?admin=users">
          Manage Users
        </a>
      </nav>
    </div>
  );
}
