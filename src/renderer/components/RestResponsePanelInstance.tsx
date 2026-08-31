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
  // Granular selector — the header only needs the status line.
  const response = useRestStore((s) => s.response);

  return (
    <PanelInstanceWrapper
      instance={instance}
      allowNoSession
      renderHeader={() => (
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{PANEL_LABELS['rest-response']}</span>
          {response && (
            <span className="terminal-pane__project">
              [ {response.ok ? response.status : 'FAILED'} ]
            </span>
          )}
        </div>
      )}
    >
      {() => <RestResponsePane />}
    </PanelInstanceWrapper>
  );
}
