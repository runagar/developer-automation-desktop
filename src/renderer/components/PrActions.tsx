import React, { useState } from 'react';
import { PrMergeMethod, PrSummary } from '../../main/types';
import { MergeAction, useGitHubStore } from '../stores/githubStore';
import { SplitButton, SplitButtonOption } from './dropdown';
import ClosePrDialog from './ClosePrDialog';
import MergeDialog, { MERGE_METHOD_LABEL, MergeDialogMode } from './MergeDialog';
import SubmitReviewDialog from './SubmitReviewDialog';

interface Props {
  summary: PrSummary;
}

/**
 * The three states GitHub's own enum documents as mergeable.
 *
 * Taken verbatim from the `MergeStateStatus` descriptions: CLEAN is
 * "Mergeable and passing commit status", HAS_HOOKS "Mergeable with passing
 * commit status and pre-receive hooks", UNSTABLE "Mergeable with non-passing
 * commit status". Everything else — DIRTY, BLOCKED, BEHIND, UNKNOWN — is not.
 */
const MERGEABLE_STATES: ReadonlySet<PrSummary['mergeState']> = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);

/**
 * Why the merge is blocked, for the button's tooltip.
 *
 * BLOCKED is deliberately unpacked: GitHub collapses draft status, a missing
 * required review, requested changes and failing required checks into that one
 * value, and "blocked" on its own tells the user nothing actionable.
 */
function mergeBlockers(summary: PrSummary): string[] {
  const reasons: string[] = [];

  switch (summary.mergeState) {
    case 'DIRTY':
      reasons.push(`Conflicts with ${summary.baseRefName} that must be resolved`);
      break;
    case 'BEHIND':
      reasons.push(`Branch is out of date with ${summary.baseRefName}`);
      break;
    case 'UNKNOWN':
      reasons.push('GitHub is still working out whether this can be merged');
      break;
    case 'BLOCKED':
      if (summary.isDraft) reasons.push('It is still a draft');
      if (summary.reviewDecision === 'REVIEW_REQUIRED') reasons.push('A required review is missing');
      if (summary.reviewDecision === 'CHANGES_REQUESTED') reasons.push('Changes have been requested');
      if (summary.checks === 'FAILURE') reasons.push('Required checks are failing');
      if (summary.checks === 'PENDING') reasons.push('Required checks are still running');
      // Branch protection can block for reasons the API does not enumerate.
      if (reasons.length === 0) reasons.push('Branch protection is blocking the merge');
      break;
    default:
      break;
  }

  return reasons;
}

/**
 * Submit-review, merge and close.
 *
 * Rendered inside the subtab strip rather than in a row of its own: the
 * actions are short and the strip has spare width, so giving them a dedicated
 * bar cost a band of empty space above every tab.
 */
export default function PrActions({ summary }: Props): React.ReactElement {
  const busy = useGitHubStore((s) => s.busy);
  const mergeAction = useGitHubStore((s) => s.mergeAction);
  const setMergeAction = useGitHubStore((s) => s.setMergeAction);

  const [confirmClose, setConfirmClose] = useState(false);
  const [mergeMode, setMergeMode] = useState<MergeDialogMode | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  const pending = summary.pendingReview;
  const pendingSuffix = pending && pending.commentCount > 0 ? ` (${pending.commentCount})` : '';

  const allowed: Record<PrMergeMethod, boolean> = {
    MERGE: summary.allowedMergeMethods.merge,
    SQUASH: summary.allowedMergeMethods.squash,
    REBASE: summary.allowedMergeMethods.rebase,
  };

  /**
   * The strategy the auto-merge dialog opens on.
   *
   * When the armed action *is* auto-merge there is no strategy in it, so the
   * preference order falls back to rebase — the same initial default the split
   * button ships with — and then to whatever the repository actually permits.
   */
  const autoMergeDefault: PrMergeMethod = (() => {
    if (mergeAction !== 'AUTO' && allowed[mergeAction]) return mergeAction;
    return (['REBASE', 'SQUASH', 'MERGE'] as PrMergeMethod[]).find((m) => allowed[m]) ?? 'REBASE';
  })();

  const merged = summary.merged || summary.state === 'CLOSED';
  const canMerge = MERGEABLE_STATES.has(summary.mergeState);
  const blockers = mergeBlockers(summary);
  const mergeTitle = merged
    ? 'This pull request is already closed'
    : canMerge
      ? 'Merge this pull request'
      : `Cannot merge:\n${blockers.map((r) => `• ${r}`).join('\n')}`;

  const mergeOptions: SplitButtonOption[] = [
    ...(['MERGE', 'SQUASH', 'REBASE'] as PrMergeMethod[]).map((method) => ({
      id: method,
      label: MERGE_METHOD_LABEL[method],
      // Repositories can switch individual strategies off; a disallowed one
      // fails server-side, so it is disabled rather than silently offered.
      // A blocked merge state disables every strategy for the same reason.
      disabled: merged || !canMerge || !allowed[method],
      hint: allowed[method] ? undefined : '(disabled)',
      onSelect: () => setMergeMode(method),
    })),
    {
      id: 'AUTO',
      label: summary.autoMerge ? 'DISABLE AUTO MERGE' : 'ENABLE AUTO MERGE',
      // Deliberately still available on a blocked pull request: waiting for
      // the blockers to clear is exactly what auto-merge is for.
      disabled: merged,
      onSelect: () => setMergeMode('AUTO'),
    },
  ];

  return (
    <div className="pr-viewer__tab-actions">
      {/* Always available: a review need not exist first. With pending diff
          comments this submits them; without, the dialog creates and submits
          a review in one step. */}
      <button
        className="btn btn--micro btn--ok"
        disabled={busy}
        title={pending ? 'Submit the pending review' : 'Review this pull request'}
        onClick={() => setSubmitOpen(true)}
      >
        SUBMIT REVIEW{pendingSuffix}
      </button>

      {/* The strategy is picked here, not inside the confirmation: the dialog
          confirms an already-chosen action. `title` carries the reason the
          merge is unavailable across the whole control — the button included,
          which is where the pointer lands first. */}
      <SplitButton
        options={mergeOptions}
        defaultId={mergeAction}
        onDefaultChange={(id) => setMergeAction(id as MergeAction)}
        buttonClassName="btn--accent"
        title={mergeTitle}
        disabled={busy}
      />

      <button
        className="btn btn--micro btn--danger"
        disabled={busy || merged}
        onClick={() => setConfirmClose(true)}
      >
        CLOSE
      </button>

      {submitOpen && <SubmitReviewDialog summary={summary} onClose={() => setSubmitOpen(false)} />}

      {mergeMode && (
        <MergeDialog
          summary={summary}
          mode={mergeMode}
          autoMergeDefault={autoMergeDefault}
          onClose={() => setMergeMode(null)}
        />
      )}

      {confirmClose && (
        <ClosePrDialog summary={summary} onClose={() => setConfirmClose(false)} />
      )}
    </div>
  );
}
