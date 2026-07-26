import { useState } from 'react';
import { api, type SessionUser } from './api';

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
    <form onSubmit={handleSubmit}>
      <h1>Sign in</h1>
      <label>
        Email
        <input data-testid="login-email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
      </label>
      <label>
        Password
        <input
          data-testid="login-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
        />
      </label>
      <button type="submit" data-testid="login-submit">
        Sign in
      </button>
      {error && (
        <p role="alert" data-testid="login-error">
          {error}
        </p>
      )}
    </form>
  );
}
