import React from 'react';
import { PanelInstance, PANEL_LABELS } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import ApiPickerPane from './ApiPickerPane';

interface Props {
  instance: PanelInstance;
}

/** Session-unbound panel wrapper for the API Picker (R2). */
export default function ApiPickerPanelInstance({ instance }: Props): React.ReactElement {
  return (
    <PanelInstanceWrapper
      instance={instance}
      allowNoSession
      renderHeader={() => (
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{PANEL_LABELS['api-picker']}</span>
        </div>
      )}
    >
      {() => <ApiPickerPane />}
    </PanelInstanceWrapper>
  );
}
