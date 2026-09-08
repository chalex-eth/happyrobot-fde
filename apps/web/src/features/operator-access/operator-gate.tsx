'use client';

import type { ReactNode } from 'react';
import { FormEvent, useEffect, useState } from 'react';

type AccessState = 'checking' | 'locked' | 'ready' | 'unavailable';

function isOperatorSession(value: unknown) {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { ok?: unknown }).ok === true &&
    (value as { role?: unknown }).role === 'operator'
  );
}

async function readSession(): Promise<AccessState> {
  try {
    const response = await fetch('/api/operator/auth', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const value: unknown = await response.json();
    if (response.ok && isOperatorSession(value)) return 'ready';
    if (response.status === 401) return 'locked';
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function OperatorGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccessState>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void readSession().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      const response = await fetch('/api/operator/auth', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const value: unknown = await response.json();
      if (response.ok && isOperatorSession(value)) {
        setPassword('');
        setState('ready');
        return;
      }
      setError(
        response.status === 503
          ? 'Operator access is not configured on the server.'
          : 'Incorrect password or access unavailable.',
      );
    } catch {
      setError('Unable to reach operator access. Try again.');
    }
  };

  if (state === 'ready') return children;
  if (state === 'checking')
    return (
      <div className="auth-shell" role="status">
        <div className="auth-card">
          <span className="eyebrow">Private workspace</span>
          <h1>Checking access…</h1>
        </div>
      </div>
    );
  return (
    <div className="auth-shell">
      <section className="auth-card" aria-labelledby="operator-access-title">
        <span className="eyebrow">Private workspace</span>
        <h1 id="operator-access-title">Operator access</h1>
        <p>Enter the shared demo password to open the operations console.</p>
        {state === 'unavailable' && (
          <p className="error notice" role="alert">
            Operator access is not configured or unavailable.
          </p>
        )}
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="operator-password">Shared password</label>
          <input
            id="operator-password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            required
          />
          <button type="submit">Open console</button>
        </form>
        {error && (
          <p className="error notice" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
