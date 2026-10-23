import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type SessionUser } from './api';
import { Icon } from '../ui/Icon';
import { loadWebConfig } from '../config';

export interface LoginFormProps {
  onSuccess: (user: SessionUser) => void;
  /** canvas-ao2: an Entra sign-in came back (?signin=sso) but no session arrived. */
  ssoCookieBlocked?: boolean;
}

/**
 * canvas-ao2: the web app and the API are on different sites, so the session cookie is a
 * third-party cookie -- private/incognito windows and Safari (every iPhone browser) block it.
 * Sign-in then "succeeds" and the very next step fails. Say what's happening instead.
 */
function CookieBlockedNotice() {
  return (
    <div role="alert" className="auth__notice" data-testid="login-cookie-blocked">
      <p>
        <strong>Your browser blocked Canvas&rsquo;s sign-in cookie,</strong> so you can&rsquo;t stay signed in.
      </p>
      <p>
        This happens in private or incognito windows, and in Safari (including every browser on an iPhone or iPad).
        Use a normal window in Chrome, Edge or Firefox, or allow third-party cookies for this site, then sign in
        again.
      </p>
    </div>
  );
}

export function LoginForm({ onSuccess, ssoCookieBlocked = false }: LoginFormProps) {
  const [cookieBlocked, setCookieBlocked] = useState(ssoCookieBlocked);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // canvas-mi9: null while unknown -- no SSO link/divider rendered until we actually know,
  // rather than flashing one in and out on every load.
  const [oidcEnabled, setOidcEnabled] = useState<boolean | null>(null);
  // canvas-cpa: same null-while-unknown treatment, but defaulting the *catch* case to true (not
  // false, unlike oidcEnabled above) -- an unreachable/erroring /auth/config shouldn't hide the
  // password form a user might still be able to use; it should only hide once the server has
  // actually said local auth is off.
  const [localAuthEnabled, setLocalAuthEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .getAuthConfig()
      .then(({ oidcEnabled, localAuthEnabled }) => {
        setOidcEnabled(oidcEnabled);
        setLocalAuthEnabled(localAuthEnabled);
      })
      .catch(() => {
        setOidcEnabled(false);
        setLocalAuthEnabled(true);
      });
  }, []);

  // Two-step verification: after a correct password the account may ask for a code.
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [code, setCode] = useState('');
  // A recovery code was used: hold the signed-in user until the "N remaining" notice is dismissed.
  const [recovery, setRecovery] = useState<{ user: SessionUser; remaining: number } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (step === 'code' || recovery) headingRef.current?.focus();
  }, [step, recovery]);

  const startOver = () => {
    setStep('password');
    setCode('');
    setPassword('');
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const result = await api.login(email, password);
      // canvas-ao2: the password was right -- but did the session cookie stick?
      const { session } = await api.sessionCheck().catch(() => ({ session: 'signed-in' as const }));
      if (session === 'none') {
        setCookieBlocked(true);
        setPassword('');
        return;
      }
      setCookieBlocked(false);
      if (result.mfaRequired) {
        setStep('code');
        return;
      }
      if (result.user) onSuccess(result.user);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const { user, recoveryCodesRemaining } = await api.verifyMfa(code.trim());
      setCode('');
      if (recoveryCodesRemaining !== undefined) setRecovery({ user, remaining: recoveryCodesRemaining });
      else onSuccess(user);
    } catch (err) {
      setError((err as Error).message);
      // Timed out or locked: the sign-in has to start again.
      if (err instanceof ApiError && (err.status === 423 || (err.status === 401 && /start|expired|timed/i.test(err.message)))) {
        setStep('password');
        setPassword('');
        setCode('');
      }
    }
  };

  // canvas-mi9: a real (not fetch/XHR) navigation -- the browser itself must follow the
  // server's redirect chain to Keycloak's own login page, then back to /auth/callback, which a
  // same-page API call can't do.
  const ssoLoginUrl = `${loadWebConfig().apiBaseUrl}/auth/login`;

  if (recovery) {
    return (
      <div className="auth">
        <div className="auth__card">
          <span className="auth__brand">
            <Icon name="diamond" />
            Canvas
          </span>
          <h1 ref={headingRef} tabIndex={-1}>
            Recovery code used
          </h1>
          <p role="status" data-testid="recovery-codes-remaining">
            You have {recovery.remaining} recovery {recovery.remaining === 1 ? 'code' : 'codes'} left. When they run out, an
            administrator must reset your two-step verification.
          </p>
          <button type="button" className="btn btn--primary auth__submit" data-testid="mfa-continue" onClick={() => onSuccess(recovery.user)}>
            Continue
          </button>
        </div>
      </div>
    );
  }

  if (step === 'code') {
    return (
      <div className="auth">
        <form className="auth__card" onSubmit={handleVerify}>
          <span className="auth__brand">
            <Icon name="diamond" />
            Canvas
          </span>
          <h1 ref={headingRef} tabIndex={-1}>
            Two-step verification
          </h1>
          <div className="field">
            <label className="field__label" htmlFor="mfa-code">
              Enter the 6-digit code from your authenticator app
            </label>
            <input
              id="mfa-code"
              data-testid="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              type="text"
              autoComplete="one-time-code"
              inputMode={/^[0-9\s]*$/.test(code) ? 'numeric' : 'text'}
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="mfa-code-hint"
              required
            />
            <span id="mfa-code-hint" className="meta">
              Lost your phone? Enter a recovery code instead (like abcde-12345).
            </span>
          </div>
          <button type="submit" className="btn btn--primary auth__submit" data-testid="mfa-submit">
            Verify
          </button>
          <button type="button" className="btn btn--secondary auth__submit" data-testid="mfa-start-over" onClick={startOver}>
            Start over
          </button>
          {cookieBlocked && <CookieBlockedNotice />}
          {error && (
            <p role="alert" data-testid="login-error">
              {error}
            </p>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={handleSubmit}>
        <span className="auth__brand">
          <Icon name="diamond" />
          Canvas
        </span>
        <h1>Sign in</h1>
        {/* canvas-cpa: password sign-in is hidden outright once the server has confirmed it's
            off (localAuthEnabled === false), rather than shown and left to 404 on submit with a
            raw "Not Found" -- exactly what happened on the Azure deployment, which defaults
            local auth off in favor of SSO-only (canvas-ycu.1). Stays visible while unknown
            (null) or on, so this changes nothing for a deployment with local auth enabled. */}
        {localAuthEnabled !== false && (
          <>
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
            {cookieBlocked && <CookieBlockedNotice />}
            {error && (
              <p role="alert" data-testid="login-error">
                {error}
              </p>
            )}
          </>
        )}
        {oidcEnabled && (
          <>
            {localAuthEnabled !== false && (
              <div className="auth__divider" role="separator">
                or
              </div>
            )}
            <a className="btn btn--secondary auth__submit" data-testid="sso-login-link" href={ssoLoginUrl}>
              Sign in with SSO
            </a>
          </>
        )}
        {localAuthEnabled === false && oidcEnabled === false && (
          <p role="alert" data-testid="login-unavailable">
            No sign-in method is configured for this deployment. Contact your administrator.
          </p>
        )}
      </form>
    </div>
  );
}
