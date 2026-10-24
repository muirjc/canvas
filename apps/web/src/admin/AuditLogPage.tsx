import { useEffect, useState } from 'react';
import { api, type AuditEventDto } from '../app/api';

const PAGE_SIZE = 50;

const SIGN_IN_FAILURE_REASONS: Record<string, string> = {
  unknown_email: 'unknown email',
  // A display label for the audit reason code, not a credential (Bearer reads `*password: '...'`
  // as a hard-coded secret).
  // bearer:disable javascript_lang_hardcoded_secret
  wrong_password: 'wrong password',
  locked: 'account locked',
  inactive: 'account inactive',
  wrong_mfa_code: 'wrong verification code',
};

/** Plain-language text for an audit event. */
export function describeEvent(event: AuditEventDto): string {
  const detail = event.detail ?? {};
  switch (event.event) {
    case 'sign_in': {
      if (detail.method === 'password+authenticator') return 'Signed in (password and authenticator app)';
      if (detail.method === 'password+recovery_code') return 'Signed in (password and recovery code)';
      return 'Signed in';
    }
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
    case 'mfa_enrolled':
      return 'Two-step verification set up';
    case 'mfa_reset':
      return 'Two-step verification reset';
    case 'user_deleted':
      return 'User deleted';
    case 'user_created':
      return 'User created';
    case 'user_updated': {
      const fields = Object.keys(detail);
      return fields.length ? `User updated (${fields.join(', ')})` : 'User updated';
    }
    case 'github_link_set': {
      const where = githubWhere(detail);
      return where ? `Linked a project to GitHub (${where})` : 'Linked a project to GitHub';
    }
    case 'github_link_removed': {
      const where = githubWhere(detail);
      return where ? `Removed a project's GitHub link (${where})` : "Removed a project's GitHub link";
    }
    case 'diagram_submitted': {
      const repo = typeof detail.repo === 'string' ? detail.repo : null;
      const pr = detail.pullRequest !== undefined && detail.pullRequest !== null ? ` PR #${String(detail.pullRequest)}` : '';
      const version = detail.versionSequence !== undefined ? `, version ${String(detail.versionSequence)}` : '';
      const verb = detail.update ? 'Pushed an update to' : 'Submitted a diagram for approval in';
      return `${verb}${repo ? ` ${repo}` : ' GitHub'}${pr}${version}`;
    }
    default:
      return event.event;
  }
}

function githubWhere(detail: Record<string, unknown>): string {
  const repo = typeof detail.repo === 'string' ? detail.repo : '';
  const folder = typeof detail.folder === 'string' ? detail.folder : '';
  const branch = typeof detail.baseBranch === 'string' ? detail.baseBranch : '';
  const path = [repo, folder].filter(Boolean).join('/');
  return branch && path ? `${path} on ${branch}` : path;
}

/** Who an event was about. A deleted user's target is a placeholder, so show the recorded email. */
function aboutText(event: AuditEventDto): string {
  const detail = event.detail ?? {};
  const email = typeof detail.email === 'string' ? detail.email : null;
  if (event.event === 'user_deleted') {
    const name = typeof detail.name === 'string' ? detail.name : null;
    const who = email ? (name ? `${name} (${email})` : email) : 'Deleted user';
    const recipient = typeof detail.transferredToEmail === 'string' ? ` to ${detail.transferredToEmail}` : '';
    const transferred = detail.transferredTo
      ? `; ${plural(Number(detail.projects ?? 0), 'project')} and ${plural(Number(detail.diagrams ?? 0), 'diagram')} transferred${recipient}`
      : '';
    return `${who}${transferred}`;
  }
  return event.targetEmail ?? email ?? '—';
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
                  <td>{aboutText(event)}</td>
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
