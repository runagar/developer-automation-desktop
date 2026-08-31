import React from 'react';
import { PanelInstance, PANEL_LABELS } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import ApiPickerPane from './ApiPickerPane';
import { useRestStore } from '../stores/restStore';

interface Props {
  instance: PanelInstance;
}

/** Session-unbound panel wrapper for the API Picker (R2). */
export default function ApiPickerPanelInstance({ instance }: Props): React.ReactElement {
  // Granular selector — the header only cares about the current selection.
  const selection = useRestStore((s) => s.selection);

  return (
    <PanelInstanceWrapper
      instance={instance}
      allowNoSession
      renderHeader={() => (
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{PANEL_LABELS['api-picker']}</span>
          {selection && (
            <>
              <span className="terminal-pane__project">
                [ {selection.serviceName} {selection.contractVersion}
                {selection.contractType !== 'RELEASE' ? ` ${selection.contractType}` : ''} ]
              </span>
              <span className="terminal-pane__dir">
                {selection.method} {selection.path}
                {selection.acceptVersion ? ` v${selection.acceptVersion}` : ''}
              </span>
            </>
          )}
        </div>
      )}
    >
      {() => <ApiPickerPane />}
    </PanelInstanceWrapper>
  );
}
