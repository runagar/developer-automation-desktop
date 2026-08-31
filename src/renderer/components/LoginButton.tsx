import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AuthStatusInfo } from '../../main/types';
import LoginDialog from './LoginDialog';
import './LoginButton.css';

const SUCCESS_MESSAGE_MS = 5000;

const INITIAL_STATUS: AuthStatusInfo = {
  state: 'no-credentials', reason: null, message: '', username: '', passwordSource: 'none',
};

function indicatorFor(status: AuthStatusInfo): { text: string; modifier: string; title: string } | null {
  switch (status.state) {
    case 'logged-in':
      return { text: 'LOGGED IN', modifier: 'ok', title: `Signed in as ${status.username}` };
    case 'login-failed':
      return { text: 'LOGIN FAILED', modifier: 'failed', title: status.message };
    case 'unavailable':
      return { text: 'UNAVAILABLE', modifier: 'unavailable', title: status.message };
    default:
      return null;
  }
}

/**
 * Nykredit login control in the tool tab bar.
 *
 * Owns the auth status subscription and renders the three-state indicator:
 * a rejected password and an unreachable server are different problems with
 * different fixes, so they must not share one "unsuccessful" label.
 */
export default function LoginButton(): React.ReactElement {
  const [status, setStatus] = useState<AuthStatusInfo>(INITIAL_STATUS);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [justSucceeded, setJustSucceeded] = useState(false);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe before asking for the current status: the startup login attempt
  // can push a state change before this component has mounted its listener,
  // and that push would otherwise be lost.
  useEffect(() => {
    const unsubscribe = window.dad.onAuthStateChanged(setStatus);
    void window.dad.authStatus().then(setStatus).catch(() => { /* keep initial */ });
    return unsubscribe;
  }, []);

  useEffect(() => () => {
    if (successTimer.current) clearTimeout(successTimer.current);
  }, []);

  const handleSuccess = useCallback((next: AuthStatusInfo) => {
    setStatus(next);
    setDialogOpen(false);
    setJustSucceeded(true);
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setJustSucceeded(false), SUCCESS_MESSAGE_MS);
  }, []);

  const indicator = justSucceeded
    ? { text: 'LOGIN SUCCESSFUL', modifier: 'success', title: '' }
    : indicatorFor(status);

  return (
    <>
      <div className="login-button">
        {indicator && (
          <span
            className={`login-button__indicator login-button__indicator--${indicator.modifier}`}
            title={indicator.title}
          >
            {indicator.text}
          </span>
        )}
        <button
          className="btn btn--micro"
          onClick={() => setDialogOpen(true)}
          title="Nykredit credentials"
          tabIndex={-1}
        >
          LOGIN
        </button>
      </div>

      {dialogOpen && (
        <LoginDialog
          status={status}
          onClose={() => setDialogOpen(false)}
          onStatus={setStatus}
          onSuccess={handleSuccess}
        />
      )}
    </>
  );
}
