import React, { useEffect, useState } from 'react';
import './UpdateIndicator.css';

interface Status {
  state: 'downloading' | 'ready' | 'installing' | 'manual';
  version: string;
  command?: string;
}

export default function UpdateIndicator(): React.ReactElement | null {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsub = window.dad.onUpdaterStatus((s) => { setStatus(s); setCopied(false); });
    return unsub;
  }, []);

  if (!status || dismissed) return null;

  if (status.state === 'downloading') {
    return (
      <div className="update-indicator">
        <span className="update-indicator__text">Downloading v{status.version}...</span>
      </div>
    );
  }

  if (status.state === 'installing') {
    return (
      <div className="update-indicator">
        <span className="update-indicator__text">Installing v{status.version}...</span>
      </div>
    );
  }

  if (status.state === 'manual') {
    return (
      <div className="update-indicator">
        <span
          className="update-indicator__text update-indicator__text--warn"
          title={`Automatic update failed — no way to get administrator rights.\nRun this in a terminal, then restart:\n${status.command ?? ''}`}
        >
          v{status.version} needs manual install
        </span>
        <button
          className="btn btn--micro update-indicator__restart"
          title={status.command}
          onClick={() => {
            if (status.command) window.dad.clipboardWrite(status.command);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy command'}
        </button>
        <button
          className="update-indicator__dismiss"
          onClick={() => setDismissed(true)}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="update-indicator">
      <span className="update-indicator__text">v{status.version} ready</span>
      <button
        className="btn btn--micro update-indicator__restart"
        onClick={() => window.dad.updaterInstall()}
      >
        Restart
      </button>
      <button
        className="update-indicator__dismiss"
        onClick={() => setDismissed(true)}
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
