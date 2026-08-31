import React from 'react';
import { PanelInstance, PANEL_LABELS } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import RestCrafterPane from './RestCrafterPane';
import { useRestStore } from '../stores/restStore';

interface Props {
  instance: PanelInstance;
}

/** Session-unbound panel wrapper for the REST Crafter (R3). */
export default function RestCrafterPanelInstance({ instance }: Props): React.ReactElement {
  // Granular selectors — the header only needs the operation and the target.
  const selection = useRestStore((s) => s.selection);
  const environmentKey = useRestStore((s) => s.environmentKey);

  return (
    <PanelInstanceWrapper
      instance={instance}
      allowNoSession
      renderHeader={() => (
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{PANEL_LABELS['rest-crafter']}</span>
          {selection && (
            <>
              <span className="terminal-pane__project">[ {environmentKey} ]</span>
              <span className="terminal-pane__dir">
                {selection.method} {selection.path}
                {selection.acceptVersion ? ` v${selection.acceptVersion}` : ''}
              </span>
            </>
          )}
        </div>
      )}
    >
      {() => <RestCrafterPane />}
    </PanelInstanceWrapper>
  );
}
