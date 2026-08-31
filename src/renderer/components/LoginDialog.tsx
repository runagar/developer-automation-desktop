import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AuthStatusInfo } from '../../main/types';
import './LoginDialog.css';

interface Props {
  status: AuthStatusInfo;
  onClose: () => void;
  onStatus: (status: AuthStatusInfo) => void;
  onSuccess: (status: AuthStatusInfo) => void;
}

/**
 * Nykredit login dialog.
 *
 * Deliberately separate from Settings → Jira: those credentials are Jira's
 * alone, while these are the user's organisation account. Both are stored in
 * `credentials.env`, but only the storage layer is shared.
 *
 * The password is never received from the main process — only its source is —
 * so this dialog always starts with an empty password field.
 */
export default function LoginDialog({ status, onClose, onStatus, onSuccess }: Props): React.ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const loginRef = useRef<HTMLButtonElement>(null);

  const [username, setUsername] = useState(status.username);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordFromEnv = status.passwordSource === 'env';

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Focus trap: INITIALS → PASSWORD → LOGIN → INITIALS.
  //
  // Needed because Workspace's window-level Tab handler calls preventDefault()
  // whenever focus is outside a panel, which includes every dialog. Moving
  // focus explicitly is how the other dialogs work around it.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
      e.stopImmediatePropagation();

      const order = passwordFromEnv
        ? [usernameRef, loginRef]
        : [usernameRef, passwordRef, loginRef];
      const idx = order.findIndex((r) => r.current === document.activeElement);

      e.preventDefault();
      if (idx === -1) {
        order[0].current?.focus();
        return;
      }
      const next = e.shiftKey
        ? order[(idx - 1 + order.length) % order.length]
        : order[(idx + 1) % order.length];
      next.current?.focus();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [passwordFromEnv]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const handleLogin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Always the manual path, even when the password comes from the
      // environment: it is the only route that bypasses and clears the
      // rejection latch, and it honours a corrected username.
      const next = await window.dad.authLogin(username.trim(), password);

      if (next.state === 'logged-in') {
        onSuccess(next);
      } else {
        onStatus(next);
        setError(next.message || 'Login failed');
      }
    } catch (err: any) {
      setError(err?.message ?? 'Login failed');
    } finally {
      setBusy(false);
    }
  }, [busy, username, password, onStatus, onSuccess]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleLogin();
    }
  }, [handleLogin]);

  const canSubmit = passwordFromEnv || (username.trim().length > 0 && password.length > 0);

  return (
    <div className="dialog-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="credentials-dialog login-dialog">
        <div className="credentials-dialog__header">
          <span className="credentials-dialog__title">NYKREDIT LOGIN</span>
          <button className="btn btn--micro" tabIndex={-1} onClick={onClose} title="Close">✕</button>
        </div>

        <div className="credentials-dialog__body">
          <div className="credentials-dialog__group">
            <div className="credentials-dialog__group-label">Organisation credentials</div>

            <div className="credentials-dialog__row">
              <div className="credentials-dialog__field-header">
                <label className="credentials-dialog__label">Initials</label>
                <span className="credentials-dialog__key">NYK_USERNAME</span>
              </div>
              <div className="credentials-dialog__field-body">
                <input
                  ref={usernameRef}
                  className="credentials-dialog__input"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="abcd"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
            </div>

            <div className="credentials-dialog__row">
              <div className="credentials-dialog__field-header">
                <label className="credentials-dialog__label">Password</label>
                <span className="credentials-dialog__key">NYK_PASSWORD</span>
              </div>
              <div className="credentials-dialog__field-body">
                <input
                  ref={passwordRef}
                  className={`credentials-dialog__input${passwordFromEnv ? ' credentials-dialog__input--env' : ''}`}
                  type={showPassword ? 'text' : 'password'}
                  value={passwordFromEnv ? '' : password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={passwordFromEnv ? 'Set via environment variable' : ''}
                  spellCheck={false}
                  disabled={busy || passwordFromEnv}
                />
                {!passwordFromEnv && (
                  <button
                    className="btn btn--micro credentials-dialog__toggle"
                    tabIndex={-1}
                    onClick={() => setShowPassword((v) => !v)}
                    title={showPassword ? 'Hide' : 'Show'}
                  >
                    {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                )}
              </div>
              <div className="credentials-dialog__field-status">
                {passwordFromEnv && (
                  <span className="credentials-dialog__env-note">Set via environment variable</span>
                )}
              </div>
            </div>
          </div>

          {error && <div className="login-dialog__error">{error}</div>}

          <div className="login-dialog__actions">
            <button
              ref={loginRef}
              className="btn btn--primary"
              onClick={() => void handleLogin()}
              disabled={busy || !canSubmit}
            >
              {busy ? 'VERIFYING…' : 'LOGIN'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
