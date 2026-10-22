import { useEffect, useState } from 'react';
import { api, type AuditEventDto } from '../app/api';

const PAGE_SIZE = 50;

const SIGN_IN_FAILURE_REASONS: Record<string, string> = {
  unknown_email: 'unknown email',
  wrong_password: 'wrong password',
  locked: 'account locked',
  inactive: 'account inactive',
};

/** Plain-language text for an audit event. */
export function describeEvent(event: AuditEventDto): string {
  const detail = event.detail ?? {};
  switch (event.event) {
    case 'sign_in':
      return 'Signed in';
    case 'sign_in_failed': {
      const reason = SIGN_IN_FAILURE_REASONS[String(detail.reason)];
      return reason ? `Failed sign-in (${reason})` : 'Failed sign-in';
    }
    case 'account_locked':
      return 'Account locked';
    case 'account_unlocked':
      return 'Account unlocked';
    case 'password_changed':
      return 'Password changed';
    case 'password_change_failed':
      return 'Failed password change';
    case 'password_reset':
      return detail.via === 'bootstrap-admin' ? 'Password reset (bootstrap admin)' : 'Password reset';
    case 'user_created':
      return 'User created';
    case 'user_updated': {
      const fields = Object.keys(detail);
      return fields.length ? `User updated (${fields.join(', ')})` : 'User updated';
    }
    default:
      return event.event;
  }
}

/** Admin-only, newest-first record of sign-in and account-management events (canvas-ez1.4). */
export function AuditLogPage() {
  const userId = new URLSearchParams(window.location.search).get('userId') ?? undefined;
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (before?: string) => {
    setLoading(true);
    setError(null);
    try {
      const { events: page } = await api.getAuditEvents({ limit: PAGE_SIZE, before, userId });
      setEvents((current) => (before ? [...current, ...page] : page));
      setHasMore(page.length >= PAGE_SIZE);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Loaded once per page visit; the filter comes from the address.
  }, []);

  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

  return (
    <div>
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Audit log
      </h1>
      {userId && (
        <p className="meta">
          Showing activity for one user. <a href="?admin=audit">Show all activity</a>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && events.length === 0 ? (
        <p className="state" data-testid="audit-empty">
          No audit events yet.
        </p>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Audit events">
          <table data-testid="audit-log">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Who</th>
                <th scope="col">About</th>
                <th scope="col">IP</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} data-testid={`audit-row-${event.id}`}>
                  <td>
                    <time dateTime={event.occurredAt}>{formatter.format(new Date(event.occurredAt))}</time>
                  </td>
                  <td>{describeEvent(event)}</td>
                  <td>{event.actorEmail ?? '—'}</td>
                  <td>{event.targetEmail ?? (typeof event.detail?.email === 'string' ? event.detail.email : '—')}</td>
                  <td className="mono">{event.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="audit-load-older"
          disabled={loading}
          onClick={() => void load(events[events.length - 1]?.occurredAt)}
        >
          Load older
        </button>
      )}
    </div>
  );
}
