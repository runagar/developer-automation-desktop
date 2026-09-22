import React from 'react';
import { PanelInstance } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import PrViewerPane from './PrViewerPane';

interface Props {
  instance: PanelInstance;
}

/**
 * Session-unbound panel wrapper for the PR Viewer (GIT1 R3).
 *
 * No `renderHeader`: the repository and number moved into the panel chrome
 * (`PrViewerPanelTitle`), and the pull request title is already the first
 * thing the pane itself shows.
 */
export default function PrViewerPanelInstance({ instance }: Props): React.ReactElement {
  return (
    <PanelInstanceWrapper instance={instance} allowNoSession renderHeader={() => null}>
      {() => <PrViewerPane />}
    </PanelInstanceWrapper>
  );
}
