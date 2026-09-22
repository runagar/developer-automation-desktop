import React from 'react';
import { PANEL_LABELS } from '../dashboard/layout';
import { useGitHubStore } from '../stores/githubStore';

/**
 * The PR Viewer's panel-chrome title.
 *
 * Its own component so the subscription stays here: `renderTitle` lives in
 * `App.tsx`, and reading the store there would re-render every panel whenever
 * the open pull request changed.
 */
export default function PrViewerPanelTitle(): React.ReactElement {
  // Primitive selectors only — an object literal would produce a new snapshot
  // on every store change and loop under zustand v5.
  const owner = useGitHubStore((s) => s.selection?.owner ?? '');
  const repo = useGitHubStore((s) => s.selection?.repo ?? '');
  const number = useGitHubStore((s) => s.selection?.number ?? null);

  return (
    <>
      <span className="workspace-panel__title-main">{PANEL_LABELS['pr-viewer']}</span>
      {number !== null && (
        <span className="workspace-panel__title-sub pr-viewer__chrome-ref">
          [ {owner}/{repo} #{number} ]
        </span>
      )}
    </>
  );
}
