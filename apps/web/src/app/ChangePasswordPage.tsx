import { useState } from 'react';
import { api, type SessionUser } from './api';

const MIN_LENGTH = 12;

export interface ChangePasswordPageProps {
  /** True at first sign-in with a one-time password: the user can do nothing else until done. */
  forced: boolean;
  onChanged: (user: SessionUser) => void;
  /** Voluntary mode only: the way back after the success confirmation. */
  projectsHref?: string;
  onNavigateProjects?: () => void;
}

/** Change-password screen, shared by the forced first-sign-in step and the voluntary header link. */
export function ChangePasswordPage({ forced, onChanged, projectsHref, onNavigateProjects }: ChangePasswordPageProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (next.length < MIN_LENGTH) {
      setError(`New password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const { user } = await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      onChanged(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page page--narrow" data-testid="change-password-page">
      <h1 className="page__title" tabIndex={-1} data-browse-heading>
        Change password
      </h1>
      {done && !forced ? (
        <div className="card stack">
          <p role="status" data-testid="change-password-success">
            Your password has been changed. Your other sessions were signed out.
          </p>
          {projectsHref && (
            <a
              className="btn btn--primary"
              href={projectsHref}
              data-testid="change-password-back"
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onNavigateProjects?.();
              }}
            >
              Back to Projects
            </a>
          )}
        </div>
      ) : (
        <form className="card" onSubmit={handleSubmit} noValidate>
          {forced && (
            <p>
              You signed in with a one-time password. Choose your own password to continue.
            </p>
          )}
          <div className="field">
            <label className="field__label" htmlFor="change-password-current">
              {forced ? 'One-time password' : 'Current password'}
            </label>
            <input
              id="change-password-current"
              data-testid="change-password-current"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="change-password-new">
              New password
            </label>
            <input
              id="change-password-new"
              data-testid="change-password-new"
              type="password"
              autoComplete="new-password"
              required
              aria-describedby="change-password-hint"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <span id="change-password-hint" className="meta">
              At least {MIN_LENGTH} characters
            </span>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="change-password-confirm">
              Confirm new password
            </label>
            <input
              id="change-password-confirm"
              data-testid="change-password-confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="field__error" data-testid="change-password-error">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn--primary" data-testid="change-password-submit" disabled={submitting}>
            Change password
          </button>
        </form>
      )}
    </main>
  );
}
