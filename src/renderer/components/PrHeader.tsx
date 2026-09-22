import React, { useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PrSummary } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { useDismiss } from './dropdown';
import ReviewersMenu from './ReviewersMenu';

interface Props {
  summary: PrSummary;
}

function checkLabel(state: PrSummary['checks']): string {
  return state === 'SUCCESS' ? 'Checks ✓'
    : state === 'FAILURE' ? 'Checks ✗'
      : state === 'PENDING' ? 'Checks …'
        : 'No checks';
}

const CHECK_GLYPH: Record<string, string> = {
  SUCCESS: '✓',
  FAILURE: '✗',
  PENDING: '…',
  SKIPPED: '–',
  NONE: '·',
};

/**
 * The rollup, broken out for the Checks tooltip.
 *
 * Required checks are listed first and marked, because they are the ones that
 * actually gate the merge — the rollup turns red for any failure, required or
 * not, which is exactly the `UNSTABLE` case where merging is still allowed.
 */
function checksTooltip(summary: PrSummary): string {
  const runs = summary.checkRuns;
  if (runs.length === 0) return 'No checks have reported on this pull request';

  const ordered = [...runs].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const requiredCount = runs.filter((r) => r.required).length;
  const header = requiredCount > 0
    ? `${runs.length} checks, ${requiredCount} required:`
    : `${runs.length} checks, none required by branch protection:`;

  return [
    header,
    ...ordered.map((r) => `${CHECK_GLYPH[r.state] ?? '·'} ${r.name}${r.required ? '  (required)' : ''}`),
  ].join('\n');
}

/** Shared filled-marker classes; see `.state-chip` in pipboy.css. */
function chipClass(tone: 'ok' | 'warn' | 'checking' | 'error' | 'neutral'): string {
  return `state-chip state-chip--${tone}`;
}

function checkTone(state: PrSummary['checks']): 'ok' | 'warn' | 'checking' | 'neutral' {
  return state === 'SUCCESS' ? 'ok'
    : state === 'FAILURE' ? 'warn'
      : state === 'PENDING' ? 'checking'
        // No checks configured is not a state worth colouring.
        : 'neutral';
}

/**
 * Read-only status, plus the one control that edits it.
 *
 * Labels, assignees and milestone are deliberately read-only; only reviewers
 * are editable. Submit/merge/close live in the subtab strip instead, so this
 * stays a single line.
 */
export default function PrHeader({ summary }: Props): React.ReactElement {
  const busy = useGitHubStore((s) => s.busy);
  const detailLoading = useGitHubStore((s) => s.detailLoading);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const reviewersRef = useRef<HTMLSpanElement>(null);

  // The ref wraps the button *and* the popover: watching the popover alone
  // would let mousedown on the button close it and the button's own click
  // reopen it, so it would never appear to close.
  useDismiss(reviewersRef, reviewersOpen, () => setReviewersOpen(false));

  return (
    <div className="pr-viewer__header">
      <div className="pr-viewer__status-row">
        {/* Re-reads the whole pull request — summary, commits, timeline,
            threads and the current diff. Nothing else refetches on its own:
            the viewer only reloads in response to an action taken in it. */}
        <button
          className="btn btn--micro pr-viewer__refresh"
          disabled={detailLoading}
          title={detailLoading ? 'Refreshing…' : 'Refresh from GitHub'}
          onClick={() => void reloadDetail()}
        >
          <RefreshCw size={12} />
        </button>

        <a className="pr-viewer__title" href={summary.url} target="_blank" rel="noreferrer" title={summary.title}>
          <span className="pr-viewer__number">#{summary.number}</span>
          {summary.title}
        </a>

        {/* Lifecycle state and divergence in one chip, directly after the
            title: both describe the pull request itself, as opposed to the
            review and merge readiness that follow. */}
        <span
          className={chipClass('neutral')}
          title={summary.compare ? `${summary.compare.aheadBy} ahead of, `
            + `${summary.compare.behindBy} behind ${summary.baseRefName}` : undefined}
        >
          {summary.isDraft ? 'DRAFT' : summary.state}
          {summary.compare && ` ↑${summary.compare.aheadBy} ↓${summary.compare.behindBy}`}
        </span>

        {/* Anchored so its popover hangs off the button rather than the row. */}
        <span className="pr-viewer__reviewers-anchor" ref={reviewersRef}>
          <button
            className="btn btn--micro btn--accent"
            disabled={busy}
            onClick={() => setReviewersOpen((v) => !v)}
          >
            REVIEWERS ▾
          </button>
          {reviewersOpen && (
            <ReviewersMenu summary={summary} onClose={() => setReviewersOpen(false)} />
          )}
        </span>

        <span className={chipClass(checkTone(summary.checks))} title={checksTooltip(summary)}>
          {checkLabel(summary.checks)}
        </span>

        {/* Conflicts only. Whether the pull request may actually be merged is
            a different question — `mergeState` — and is answered by the MERGE
            button rather than duplicated here.

            `warn`, not `error`: --c-error is for an operation that failed,
            while this is a state of the pull request the user has to fix —
            the same class of thing as a failing check, and coloured the same.
            It also keeps red out of the status row, where it competed with
            the CLOSE button. */}
        <span
          className={chipClass(
            summary.mergeable === 'MERGEABLE' ? 'ok'
              : summary.mergeable === 'CONFLICTING' ? 'warn'
                : 'checking'
          )}
        >
          {summary.mergeable === 'CONFLICTING' ? 'Conflicts!'
            : summary.mergeable === 'MERGEABLE' ? 'No conflicts'
              // GitHub computes this lazily; "checking" is the truth while it does.
              : 'Checking conflicts…'}
        </span>

        {summary.autoMerge && (
          <span className={chipClass('neutral')}>AUTO-MERGE {summary.autoMerge.mergeMethod}</span>
        )}

        {summary.labels.map((label) => (
          <span key={label.name} className={chipClass('neutral')}>{label.name}</span>
        ))}

        {summary.assignees.length > 0 && (
          <span className={chipClass('neutral')}>@{summary.assignees.join(' @')}</span>
        )}

        {summary.milestone && (
          <span className={chipClass('neutral')}>◇ {summary.milestone}</span>
        )}
      </div>
    </div>
  );
}
