import React from 'react';
import { PanelInstance } from '../dashboard/layout';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import PullRequestListPane from './PullRequestListPane';

interface Props {
  instance: PanelInstance;
}

/**
 * Session-unbound panel wrapper for "Your Pull Requests" (GIT1 R2).
 *
 * No `renderHeader`: the panel chrome already names the panel, and the counts
 * live on the pane's own toolbar beside the refresh button — a second header
 * repeating the title was pure vertical cost.
 */
export default function PullRequestListPanelInstance({ instance }: Props): React.ReactElement {
  return (
    <PanelInstanceWrapper instance={instance} allowNoSession renderHeader={() => null}>
      {() => <PullRequestListPane />}
    </PanelInstanceWrapper>
  );
}
