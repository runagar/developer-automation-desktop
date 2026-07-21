import React, { useEffect, useState } from 'react';
import UpdateIndicator from './UpdateIndicator';
import './TitleBar.css';

export default function TitleBar(): React.ReactElement {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const unsub = window.dad.onWindowMaximized((m) => setMaximized(m));
    return unsub;
  }, []);

  return (
    <div className="titlebar">
      <span className="titlebar__title">Developer Automation Desktop</span>
      <div className="titlebar__drag" />
      <UpdateIndicator />
      <div className="titlebar__controls">
        <button
          className="titlebar__btn titlebar__btn--minimize"
          onClick={() => window.dad.windowMinimize()}
          title="Minimize"
        >
          ─
        </button>
        <button
          className="titlebar__btn titlebar__btn--maximize"
          onClick={() => window.dad.windowMaximize()}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? '❐' : '⊡'}
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          onClick={() => window.dad.windowClose()}
          title="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
