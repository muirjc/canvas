import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, type SessionUser } from './api';

export interface MfaSetupProps {
  /** True when the account must set this up before anything else (renders as its own screen). */
  forced: boolean;
  mfaEnabled: boolean;
  /** Called with the updated user once the user has confirmed they saved their recovery codes. */
  onDone: (user: SessionUser) => void;
}

type Step = 'intro' | 'scan' | 'codes';

const group4 = (secret: string) => secret.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

/**
 * Two-step verification set-up. The secret and recovery codes live only in this component's state:
 * never persisted, and dropped when it unmounts. The updated user is held back until "Done" so the
 * forced screen doesn't unmount before the recovery codes have been seen.
 */
export function MfaSetup({ forced, mfaEnabled, onDone }: MfaSetupProps) {
  const [step, setStep] = useState<Step>('intro');
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [updatedUser, setUpdatedUser] = useState<SessionUser | null>(null);
  const [saved, setSaved] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Move focus to the heading on each step (not on first load of the screen).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const begin = async () => {
    setError(null);
    setBusy(true);
    try {
      const { secret: newSecret, otpauthUri } = await api.enrollMfa();
      setSecret(newSecret);
      setQr(await QRCode.toDataURL(otpauthUri, { margin: 1, width: 220 }));
      setStep('scan');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.confirmMfaEnrollment(code.replace(/\s+/g, ''));
      setRecoveryCodes(result.recoveryCodes);
      setUpdatedUser(result.user);
      setSecret('');
      setQr('');
      setCode('');
      setStep('codes');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const downloadCodes = () => {
    const blob = new Blob([`Canvas recovery codes\n\n${recoveryCodes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'canvas-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const done = () => {
    const user = updatedUser;
    setRecoveryCodes([]);
    setUpdatedUser(null);
    setSaved(false);
    // Back to the first step so the voluntary screen shows its "on" status instead of an empty codes panel.
    setStep('intro');
    if (user) onDone(user);
  };

  const Heading = forced ? 'h1' : 'h2';
  const heading = (
    <Heading ref={headingRef} className={forced ? 'page__title' : undefined} tabIndex={-1} {...(forced ? { 'data-browse-heading': true } : {})}>
      Two-step verification
    </Heading>
  );

  let body: React.ReactNode;
  if (mfaEnabled && step !== 'codes') {
    body = (
      <p data-testid="mfa-status" role="status">
        Two-step verification is on for your account.
      </p>
    );
  } else if (step === 'intro') {
    body = (
      <>
        <p>
          {forced
            ? 'Your account needs two-step verification. '
            : 'Add a second step to signing in. '}
          You will need an authenticator app on your phone (for example Microsoft Authenticator, Google Authenticator or 1Password).
        </p>
        {error && (
          <p role="alert" className="field__error" data-testid="mfa-error">
            {error}
          </p>
        )}
        <button type="button" className="btn btn--primary" data-testid="mfa-begin" disabled={busy} onClick={begin}>
          Set up two-step verification
        </button>
      </>
    );
  } else if (step === 'scan') {
    body = (
      <form onSubmit={confirm} noValidate>
        <p>Scan this QR code with your authenticator app, or enter the key by hand.</p>
        <div className="mfa-qr">
          <img
            src={qr}
            width={220}
            height={220}
            data-testid="mfa-qr"
            alt="QR code for your authenticator app. If you cannot scan it, use the setup key shown below."
          />
        </div>
        <p className="meta">Setup key</p>
        <code className="one-time-password" data-testid="mfa-secret">
          {group4(secret)}
        </code>
        <div className="field" style={{ marginBlockStart: 'var(--space-4)' }}>
          <label className="field__label" htmlFor="mfa-confirm-code">
            Enter the 6-digit code your app shows
          </label>
          <input
            id="mfa-confirm-code"
            data-testid="mfa-confirm-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="field__error" data-testid="mfa-error">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary" data-testid="mfa-confirm-submit" disabled={busy}>
          Confirm
        </button>
      </form>
    );
  } else {
    body = (
      <div className="stack">
        <p>
          Save these recovery codes somewhere safe. Each works once if you lose your phone. They are shown only now.
        </p>
        <ul className="mfa-recovery-codes mono" data-testid="mfa-recovery-codes">
          {recoveryCodes.map((rc) => (
            <li key={rc}>{rc}</li>
          ))}
        </ul>
        <div className="cluster">
          <button type="button" className="btn btn--secondary" data-testid="mfa-recovery-copy" onClick={copyCodes}>
            Copy
          </button>
          <button type="button" className="btn btn--secondary" data-testid="mfa-recovery-download" onClick={downloadCodes}>
            Download .txt
          </button>
          <span role="status" className="meta">
            {copyState === 'copied' && 'Copied to clipboard.'}
            {copyState === 'failed' && 'Could not copy automatically — select the codes and copy them.'}
          </span>
        </div>
        <label className="cluster" htmlFor="mfa-recovery-saved">
          <input id="mfa-recovery-saved" data-testid="mfa-recovery-saved" type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I've saved these recovery codes
        </label>
        <button type="button" className="btn btn--primary" data-testid="mfa-done" disabled={!saved} onClick={done}>
          Done
        </button>
      </div>
    );
  }

  if (forced) {
    return (
      <main className="page page--narrow" data-testid="mfa-setup-page">
        {heading}
        <div className="card">{body}</div>
      </main>
    );
  }
  return (
    <section className="card stack" data-testid="mfa-setup-page" aria-labelledby="mfa-heading" style={{ marginBlockStart: 'var(--space-6)' }}>
      <div id="mfa-heading">{heading}</div>
      {body}
    </section>
  );
}
