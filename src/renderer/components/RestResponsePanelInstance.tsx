import React from 'react';
import { PanelInstance, PANEL_LABELS } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import RestResponsePane from './RestResponsePane';
import { useRestStore } from '../stores/restStore';

interface Props {
  instance: PanelInstance;
}

/** Session-unbound panel wrapper for the REST Response panel (R4). */
export default function RestResponsePanelInstance({ instance }: Props): React.ReactElement {
  // Narrow selectors — the header needs the active tab's status only, not the
  // whole history, so appending or settling a tab does not re-render it.
  const status = useRestStore((s) => {
    const active = s.responses.find((r) => r.id === s.activeResponseId);
    if (!active) return null;
    if (active.loading) return '…';
    if (!active.result) return null;
    return active.result.ok ? String(active.result.status) : 'FAILED';
  });

  return (
    <PanelInstanceWrapper
      instance={instance}
      allowNoSession
      renderHeader={() => (
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{PANEL_LABELS['rest-response']}</span>
          {status && <span className="terminal-pane__project">[ {status} ]</span>}
        </div>
      )}
    >
      {() => <RestResponsePane />}
    </PanelInstanceWrapper>
  );
}
