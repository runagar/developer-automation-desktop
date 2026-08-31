import React, { useRef } from 'react';
import { usePanelFocus } from '../dashboard/usePanelFocus';
import { useRestStore } from '../stores/restStore';
import './RestResponsePane.css';

/**
 * Minimal response view.
 *
 * R3 only has to make the executed call observable; all formatting — pretty
 * printing, highlighting, history — belongs to R4, so the body is shown raw
 * and unmodified here.
 */
export default function RestResponsePane(): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  usePanelFocus(rootRef);

  const response = useRestStore((s) => s.response);
  const sending = useRestStore((s) => s.sending);

  if (sending && !response) {
    return (
      <div className="app-empty" ref={rootRef}>
        <div className="app-empty__text">REST RESPONSE</div>
        <div className="app-empty__sub">WAITING FOR A RESPONSE…</div>
      </div>
    );
  }

  if (!response) {
    return (
      <div className="app-empty" ref={rootRef}>
        <div className="app-empty__text">REST RESPONSE</div>
        <div className="app-empty__sub">NO REQUEST SENT YET</div>
      </div>
    );
  }

  const failed = !response.ok;
  const statusClass = failed || response.status >= 400
    ? 'rest-response-pane__status--bad'
    : 'rest-response-pane__status--good';

  return (
    <div className="rest-response-pane" ref={rootRef}>
      <div className="rest-response-pane__bar">
        <span className={`rest-response-pane__status ${statusClass}`}>
          {failed ? 'FAILED' : `${response.status} ${response.statusText}`.trim()}
        </span>
        <span className="rest-response-pane__method">{response.method}</span>
        <span className="rest-response-pane__url" title={response.url}>{response.url}</span>
        <span className="rest-response-pane__time">{response.durationMs} ms</span>
      </div>

      {failed && <div className="rest-response-pane__error">{response.error}</div>}

      {response.truncated && (
        <div className="rest-response-pane__notice">
          Response truncated — only the first 5 MB is shown.
        </div>
      )}

      {!failed && (
        <pre className="rest-response-pane__body">{response.body}</pre>
      )}
    </div>
  );
}
