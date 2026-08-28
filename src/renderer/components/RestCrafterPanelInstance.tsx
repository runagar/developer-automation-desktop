import React from 'react';
import { PanelInstance, PANEL_LABELS } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import RestCrafterPane from './RestCrafterPane';

interface Props {
  instance: PanelInstance;
}

/** Session-unbound panel wrapper for the REST Crafter (R3). */
export default function RestCrafterPanelInstance({ instance }: Props): React.ReactElement {
  return (
    <PanelInstanceWrapper
      instance={instance}
      allowNoSession
      renderHeader={() => (
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{PANEL_LABELS['rest-crafter']}</span>
        </div>
      )}
    >
      {() => <RestCrafterPane />}
    </PanelInstanceWrapper>
  );
}
