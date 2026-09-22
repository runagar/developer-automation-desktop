import React, { useState } from 'react';
import { PrMergeMethod, PrSummary } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { useEscape } from '../hooks/useEscape';
import { cn } from '../utils/cn';

/**
 * Which confirmation the dialog is showing.
 *
 * The merge strategy is chosen *before* the dialog opens, from the header's
 * split button, so it is deliberately not selectable here — the dialog only
 * confirms what was already picked. The one exception is auto-merge, which
 * may be armed with a different strategy than the one the button runs.
 */
export type MergeDialogMode = PrMergeMethod | 'AUTO';

interface Props {
  summary: PrSummary;
  mode: MergeDialogMode;
  /** The strategy auto-merge starts on; the user may change it here. */
  autoMergeDefault: PrMergeMethod;
  onClose: () => void;
}

export const MERGE_METHOD_LABEL: Record<PrMergeMethod, string> = {
  MERGE: 'MERGE COMMIT',
  SQUASH: 'SQUASH AND MERGE',
  REBASE: 'REBASE AND MERGE',
};

export default function MergeDialog({ summary, mode, autoMergeDefault, onClose }: Props): React.ReactElement {
  const run = useGitHubStore((s) => s.run);
  const busy = useGitHubStore((s) => s.busy);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const patchSummary = useGitHubStore((s) => s.patchSummary);
  const invalidateLists = useGitHubStore((s) => s.invalidateLists);

  // Only the merge-commit flow edits these; squash and rebase confirm as-is.
  const [headline, setHeadline] = useState(summary.mergeHeadline);
  const [body, setBody] = useState(summary.mergeBody);
  const [autoMethod, setAutoMethod] = useState<PrMergeMethod>(autoMergeDefault);

  const allowed: Record<PrMergeMethod, boolean> = {
    MERGE: summary.allowedMergeMethods.merge,
    SQUASH: summary.allowedMergeMethods.squash,
    REBASE: summary.allowedMergeMethods.rebase,
  };

  const conflicting = summary.mergeable === 'CONFLICTING';
  const autoMergeOn = summary.autoMerge !== null;

  /**
   * Close first, then do the work.
   *
   * Each of these is a mutation plus a full detail reload — several paginated
   * round trips — and awaiting all of it before closing made the app look
   * hung. The dialog has nothing left to show once the action is confirmed.
   *
   * Failures are not swallowed: `run` publishes the message to `actionError`,
   * which the viewer renders, and the reload afterwards restores the true
   * state whether the request succeeded or not.
   */
  const runInBackground = (action: () => Promise<unknown>, optimistic?: () => void): void => {
    onClose();
    optimistic?.();
    void (async () => {
      await run(action);
      await reloadDetail();
    })();
  };

  const doMerge = (method: PrMergeMethod): void => {
    runInBackground(
      () => window.dad.githubMerge(summary.id, {
        method,
        // Rebase keeps each commit's own message, and squash is confirmed
        // without editing, so GitHub's own default is used for both.
        commitHeadline: method === 'MERGE' ? headline : undefined,
        commitBody: method === 'MERGE' ? body : undefined,
      }),
      // Merging removes it from the open-only lists.
      invalidateLists
    );
  };

  const doEnableAutoMerge = (): void => {
    runInBackground(() => window.dad.githubSetAutoMerge(summary.id, true, {
      method: autoMethod,
      commitHeadline: autoMethod === 'MERGE' ? headline : undefined,
      commitBody: autoMethod === 'MERGE' ? body : undefined,
    }));
  };

  const doDisableAutoMerge = (): void => {
    runInBackground(
      () => window.dad.githubSetAutoMerge(summary.id, false),
      () => patchSummary({ autoMerge: null })
    );
  };

  const title = mode === 'AUTO'
    ? (autoMergeOn ? 'DISABLE AUTO-MERGE' : 'ENABLE AUTO-MERGE')
    : MERGE_METHOD_LABEL[mode];

  // Escape backs out without merging or changing auto-merge — identical to CANCEL.
  useEscape(true, onClose);

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="pr-merge-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pr-merge-dialog__title">{title} · #{summary.number}</div>

        {mode === 'MERGE' && (
          <>
            <input
              className="pr-merge-dialog__input"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Commit headline"
              autoFocus
            />
            <textarea
              className="pr-merge-dialog__textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Commit body (optional)"
              rows={4}
            />
          </>
        )}

        {mode === 'SQUASH' && (
          <div className="pr-merge-dialog__note">
            Squash every commit into one and merge it into {summary.baseRefName}.
          </div>
        )}

        {mode === 'REBASE' && (
          <div className="pr-merge-dialog__note">
            Rebase onto {summary.baseRefName} and fast-forward. Each commit keeps its own message.
          </div>
        )}

        {mode === 'AUTO' && (autoMergeOn ? (
          <div className="pr-merge-dialog__note">
            Stop merging this pull request automatically when its checks pass.
          </div>
        ) : (
          <>
            <div className="pr-merge-dialog__note">
              Merge automatically once every required check passes.
            </div>
            <label className="pr-merge-dialog__field">
              <span className="pr-merge-dialog__label">STRATEGY</span>
              <select
                className="pr-merge-dialog__select"
                value={autoMethod}
                onChange={(e) => setAutoMethod(e.target.value as PrMergeMethod)}
              >
                {(['MERGE', 'SQUASH', 'REBASE'] as PrMergeMethod[]).map((m) => (
                  // A method the repository disallows fails server-side, so it
                  // is shown disabled rather than hidden — the reason is then
                  // visible instead of mysterious.
                  <option key={m} value={m} disabled={!allowed[m]}>
                    {MERGE_METHOD_LABEL[m]}{allowed[m] ? '' : ' (disabled for this repo)'}
                  </option>
                ))}
              </select>
            </label>
            {autoMethod === 'MERGE' && (
              <input
                className="pr-merge-dialog__input"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="Commit headline"
              />
            )}
          </>
        ))}

        {conflicting && mode !== 'AUTO' && (
          <div className="panel-error">
            This branch has conflicts with {summary.baseRefName} that must be resolved.
          </div>
        )}

        <div className="pr-merge-dialog__buttons">
          <button className="btn btn--micro pr-merge-dialog__cancel" onClick={onClose}>CANCEL</button>
          {mode === 'AUTO' ? (
            <button
              className={cn('btn', 'btn--micro', autoMergeOn ? 'btn--danger' : 'btn--primary')}
              disabled={busy || (!autoMergeOn && !allowed[autoMethod])}
              onClick={() => (autoMergeOn ? doDisableAutoMerge() : doEnableAutoMerge())}
            >
              {autoMergeOn ? 'DISABLE' : 'ENABLE'}
            </button>
          ) : (
            <button
              className="btn btn--micro btn--danger"
              disabled={busy || conflicting || !allowed[mode]}
              onClick={() => doMerge(mode)}
            >
              CONFIRM
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
