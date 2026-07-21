import React, { useEffect, useState } from 'react';
import './UpdateIndicator.css';

export default function UpdateIndicator(): React.ReactElement | null {
  const [status, setStatus] = useState<{ state: 'downloading' | 'ready'; version: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unsub = window.dad.onUpdaterStatus((s) => setStatus(s));
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
