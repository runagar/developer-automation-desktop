import React, { useEffect } from 'react';
import { PrSubtab, useGitHubStore } from '../stores/githubStore';
import { cn } from '../utils/cn';
import PrHeader from './PrHeader';
import PrActions from './PrActions';
import PrOverview from './PrOverview';
import PrCommits from './PrCommits';
import PrDiff from './PrDiff';
import './PrViewerPane.css';

const SUBTABS: { id: PrSubtab; label: string }[] = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'commits', label: 'COMMITS' },
  { id: 'diff', label: 'DIFF' },
];

/** The PR Viewer body: header, subtab strip, then one of three bodies. */
export default function PrViewerPane(): React.ReactElement {
  // Granular selectors so a keystroke in a composer cannot re-render the
  // whole viewer.
  const selection = useGitHubStore((s) => s.selection);
  const detail = useGitHubStore((s) => s.detail);
  const loading = useGitHubStore((s) => s.detailLoading);
  const error = useGitHubStore((s) => s.detailError);
  const actionError = useGitHubStore((s) => s.actionError);
  const subtab = useGitHubStore((s) => s.subtab);
  const setSubtab = useGitHubStore((s) => s.setSubtab);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const setActionError = useGitHubStore((s) => s.setActionError);

  // A selection restored from localStorage arrives with no detail and nothing
  // to trigger a fetch — `select()` is the only other caller and it is not
  // invoked on boot. Without this the viewer sits on NOT LOADED forever, and
  // clicking the same row in the list is a no-op because the refs match.
  useEffect(() => {
    if (selection && !detail && !loading && !error) void reloadDetail();
  }, [selection, detail, loading, error, reloadDetail]);

  if (!selection) {
    return (
      <div className="app-empty">
        <div className="app-empty__text">NO PULL REQUEST</div>
        <div className="app-empty__sub">PICK ONE FROM YOUR PULL REQUESTS</div>
      </div>
    );
  }

  return (
    <div className="pr-viewer">
      {error && (
        <div className="panel-error">
          {error}
          <button className="btn btn--micro panel-error__retry" onClick={() => void reloadDetail()}>
            RETRY
          </button>
        </div>
      )}

      {actionError && (
        <div className="panel-error">
          {actionError}
          <button className="btn btn--micro panel-error__retry" onClick={() => setActionError(null)}>
            DISMISS
          </button>
        </div>
      )}

      {!detail && (
        <div className="pr-viewer__loading">
          {loading ? 'LOADING…' : error ? '' : 'NOT LOADED'}
        </div>
      )}

      {detail && (
        <>
          <PrHeader summary={detail.summary} />

          <div className="panel-subtabs">
            {SUBTABS.map((tab) => (
              <button
                key={tab.id}
                className={cn('panel-subtabs__tab', subtab === tab.id && 'panel-subtabs__tab--active')}
                onClick={() => setSubtab(tab.id)}
              >
                {tab.label}
                {tab.id === 'commits' && ` (${detail.commits.length})`}
              </button>
            ))}

            {/* Inline with the tabs: the actions are short and the strip has
                spare width, so a dedicated bar was mostly empty space. */}
            <PrActions summary={detail.summary} />
          </div>

          <div className="pr-viewer__body">
            {subtab === 'overview' && <PrOverview detail={detail} />}
            {subtab === 'commits' && <PrCommits commits={detail.commits} />}
            {subtab === 'diff' && <PrDiff detail={detail} />}
          </div>
        </>
      )}
    </div>
  );
}
