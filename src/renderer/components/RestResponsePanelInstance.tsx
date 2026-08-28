import React from 'react';
import { PanelInstance, PANEL_LABELS } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import RestResponsePane from './RestResponsePane';

interface Props {
  instance: PanelInstance;
}

/** Session-unbound panel wrapper for the REST Response panel (R4). */
export default function RestResponsePanelInstance({ instance }: Props): React.ReactElement {
  return (
    <PanelInstanceWrapper
      instance={instance}
      allowNoSession
      renderHeader={() => (
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{PANEL_LABELS['rest-response']}</span>
        </div>
      )}
    >
      {() => <RestResponsePane />}
    </PanelInstanceWrapper>
  );
}
