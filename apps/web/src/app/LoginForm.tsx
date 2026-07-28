import { useState } from 'react';
import { api, type SessionUser } from './api';
import { Icon } from '../ui/Icon';

export interface LoginFormProps {
  onSuccess: (user: SessionUser) => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

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
      </form>
    </div>
  );
}
