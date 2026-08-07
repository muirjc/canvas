import { useEffect, useState } from 'react';
import { api, type SessionUser } from './api';
import { Icon } from '../ui/Icon';
import { loadWebConfig } from '../config';

export interface LoginFormProps {
  onSuccess: (user: SessionUser) => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // canvas-mi9: null while unknown -- no SSO link/divider rendered until we actually know,
  // rather than flashing one in and out on every load.
  const [oidcEnabled, setOidcEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .getAuthConfig()
      .then(({ oidcEnabled }) => setOidcEnabled(oidcEnabled))
      .catch(() => setOidcEnabled(false));
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const { user } = await api.login(email, password);
      onSuccess(user);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // canvas-mi9: a real (not fetch/XHR) navigation -- the browser itself must follow the
  // server's redirect chain to Keycloak's own login page, then back to /auth/callback, which a
  // same-page API call can't do.
  const ssoLoginUrl = `${loadWebConfig().apiBaseUrl}/auth/login`;

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={handleSubmit}>
        <span className="auth__brand">
          <Icon name="diamond" />
          Canvas
        </span>
        <h1>Sign in</h1>
        <div className="field">
          <label className="field__label" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            data-testid="login-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            data-testid="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </div>
        <button type="submit" className="btn btn--primary auth__submit" data-testid="login-submit">
          Sign in
        </button>
        {error && (
          <p role="alert" data-testid="login-error">
            {error}
          </p>
        )}
        {oidcEnabled && (
          <>
            <div className="auth__divider" role="separator">
              or
            </div>
            <a className="btn btn--secondary auth__submit" data-testid="sso-login-link" href={ssoLoginUrl}>
              Sign in with SSO
            </a>
          </>
        )}
      </form>
    </div>
  );
}
