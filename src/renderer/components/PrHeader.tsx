import React, { useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PrBranchUpdateMethod, PrSummary } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { SplitButton, SplitButtonOption, useDismiss } from './dropdown';
import ConfirmDialog from './ConfirmDialog';
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

const UPDATE_METHOD_LABEL: Record<PrBranchUpdateMethod, string> = {
  MERGE: 'UPDATE WITH MERGE',
  REBASE: 'UPDATE WITH REBASE',
};

/**
 * Why a branch update is unavailable, for the control's tooltip.
 *
 * Same shape as `mergeBlockers` in `PrActions`: a disabled control that does
 * not say why is worse than no control at all.
 */
function updateBlockers(summary: PrSummary): string[] {
  const reasons: string[] = [];
  if (summary.mergeable === 'CONFLICTING') {
    reasons.push(`Conflicts with ${summary.baseRefName} that must be resolved locally`);
  }
  if (!summary.viewerCanUpdate) {
    reasons.push('You do not have permission to update this branch');
  }
  return reasons;
}

/**
 * Read-only status, plus the two controls that edit it.
 *
 * Labels, assignees and milestone are deliberately read-only; reviewers and
 * the branch update are not. Submit/merge/close live in the subtab strip
 * instead, so this stays a single line. UPDATE BRANCH is the exception that
 * belongs here rather than there: it acts on the `↓` divergence count
 * rendered immediately to its left, and it only appears when that count is
 * non-zero.
 */
export default function PrHeader({ summary }: Props): React.ReactElement {
  const busy = useGitHubStore((s) => s.busy);
  const detailLoading = useGitHubStore((s) => s.detailLoading);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const run = useGitHubStore((s) => s.run);
  const updateBranchAction = useGitHubStore((s) => s.updateBranchAction);
  const setUpdateBranchAction = useGitHubStore((s) => s.setUpdateBranchAction);
  const [reviewersOpen, setReviewersOpen] = useState(false);
  // One piece of state for both strategies, so the two confirmations can
  // never be open at once.
  const [confirmUpdate, setConfirmUpdate] = useState<PrBranchUpdateMethod | null>(null);
  const reviewersRef = useRef<HTMLSpanElement>(null);

  // The ref wraps the button *and* the popover: watching the popover alone
  // would let mousedown on the button close it and the button's own click
  // reopen it, so it would never appear to close.
  useDismiss(reviewersRef, reviewersOpen, () => setReviewersOpen(false));

  // `compare` is null while the detail loads and if the compare request
  // failed, so an unknown divergence hides the control rather than offering
  // an update that may not be needed. It is also the number rendered as `↓y`
  // in the chip beside it, so the two can never disagree.
  const behind = summary.compare !== null && summary.compare.behindBy > 0;
  const closed = summary.merged || summary.state === 'CLOSED';
  const updateBlocked = updateBlockers(summary);
  const updateTitle = updateBlocked.length > 0
    ? `Cannot update branch:\n${updateBlocked.map((r) => `• ${r}`).join('\n')}`
    : `Update this branch with ${summary.baseRefName}`;

  const updateOptions: SplitButtonOption[] = (['MERGE', 'REBASE'] as PrBranchUpdateMethod[])
    .map((method) => ({
      id: method,
      label: UPDATE_METHOD_LABEL[method],
      // Not gated on `allowedMergeMethods.rebase`: that setting governs how a
      // pull request may be *merged*, which is a different permission from
      // how its branch may be updated.
      disabled: updateBlocked.length > 0,
      onSelect: () => setConfirmUpdate(method),
    }));

  /**
   * Close the confirmation first, then do the work.
   *
   * The `MergeDialog` pattern, for its reasons: the mutation plus a full
   * detail reload is several paginated round trips, and awaiting them before
   * closing makes the app look hung. Failures are not swallowed — `run`
   * publishes to `actionError`, and the reload restores the true state either
   * way. The reload is also what removes this control: once `behindBy` is
   * back to 0, it no longer renders.
   */
  const doUpdate = (method: PrBranchUpdateMethod): void => {
    setConfirmUpdate(null);
    void (async () => {
      await run(() => window.dad.githubUpdateBranch(summary.id, summary.headRefOid, method));
      await reloadDetail();
    })();
  };

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

        {/* Only while the branch is actually behind, and never once the pull
            request is closed or merged — `behindBy` can still be non-zero
            then, but there is nothing left to update. Blocked cases stay
            visible but disabled, so the reason is readable in `title`. */}
        {behind && !closed && (
          <SplitButton
            options={updateOptions}
            defaultId={updateBranchAction}
            onDefaultChange={(id) => setUpdateBranchAction(id as PrBranchUpdateMethod)}
            buttonClassName="btn--accent"
            title={updateTitle}
            disabled={busy}
          />
        )}

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

      {confirmUpdate && (
        <ConfirmDialog
          message={`Update ${summary.headRefName} with ${summary.baseRefName}?`}
          detail={confirmUpdate === 'MERGE'
            ? `Merges ${summary.baseRefName} into the pull request branch, adding a merge commit.`
            : `Rebases the pull request branch onto ${summary.baseRefName}. This rewrites its `
              + 'history and force-pushes it: any local checkout must be reset.'}
          confirmLabel={UPDATE_METHOD_LABEL[confirmUpdate]}
          onConfirm={() => doUpdate(confirmUpdate)}
          onCancel={() => setConfirmUpdate(null)}
        />
      )}
    </div>
  );
}
