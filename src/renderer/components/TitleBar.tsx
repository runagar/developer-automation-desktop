import React, { useEffect, useState } from 'react';
import './TitleBar.css';

export default function TitleBar(): React.ReactElement {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const unsub = window.agentSmith.onWindowMaximized((m) => setMaximized(m));
    return unsub;
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar__drag" />
      <div className="titlebar__controls">
        <button
          className="titlebar__btn titlebar__btn--minimize"
          onClick={() => window.agentSmith.windowMinimize()}
          title="Minimize"
        >
          ─
        </button>
        <button
          className="titlebar__btn titlebar__btn--maximize"
          onClick={() => window.agentSmith.windowMaximize()}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? '❐' : '⊡'}
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          onClick={() => window.agentSmith.windowClose()}
          title="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
