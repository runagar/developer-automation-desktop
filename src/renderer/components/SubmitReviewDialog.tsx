import React, { useState } from 'react';
import { PrSummary } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { useEscape } from '../hooks/useEscape';

interface Props {
  summary: PrSummary;
  onClose: () => void;
}

/**
 * Submit a review.
 *
 * Works with or without a review already in progress: diff comments are
 * always held pending, and when none exist GitHub creates and submits the
 * review in a single mutation. Either way the verdict is chosen once, here,
 * rather than being armed on a button that might be pressed by muscle memory.
 */
export default function SubmitReviewDialog({ summary, onClose }: Props): React.ReactElement {
  const run = useGitHubStore((s) => s.run);
  const busy = useGitHubStore((s) => s.busy);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const patchSummary = useGitHubStore((s) => s.patchSummary);

  const pending = summary.pendingReview;
  const [body, setBody] = useState(pending?.body ?? '');

  /**
   * Close first, then do the work.
   *
   * Submitting is a mutation plus a full detail reload — several paginated
   * round trips — and awaiting all of it before closing made the app look
   * hung. The dialog has nothing left to show once the verdict is chosen, so
   * it closes immediately and the request continues in the background.
   *
   * Nothing is lost on failure: `run` publishes the message to
   * `actionError`, which the viewer renders, and the reload afterwards
   * restores the true pending-review state either way.
   */
  const runInBackground = (action: () => Promise<unknown>): void => {
    onClose();
    // Optimistic, so SUBMIT REVIEW greys out at once rather than a second
    // later; the reload corrects it if the request turns out to have failed.
    patchSummary({ pendingReview: null });
    void (async () => {
      await run(action);
      await reloadDetail();
    })();
  };

  const submit = (event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): void => {
    runInBackground(() => window.dad.githubSubmitReview(summary.id, pending?.id ?? null, event, body));
  };

  const discard = (): void => {
    if (!pending) return;
    runInBackground(() => window.dad.githubDiscardReview(pending.id));
  };

  const count = pending?.commentCount ?? 0;

  /**
   * GitHub rejects a verdict that carries neither a body nor any pending
   * comment — REQUEST_CHANGES with "You need to leave a comment indicating the
   * requested changes", COMMENT with an empty message that would surface as a
   * blank error. Both are verified against the live API, so the buttons say
   * why instead.
   */
  const hasSubstance = count > 0 || body.trim().length > 0;
  const needsSubstance = 'Write a comment, or add one to the diff, before submitting this';

  // Escape backs out without submitting or discarding — identical to CANCEL.
  useEscape(true, onClose);

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="pr-merge-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pr-merge-dialog__title">SUBMIT REVIEW · #{summary.number}</div>

        <div className="pr-merge-dialog__note">
          {count > 0
            ? `${count} pending comment${count === 1 ? '' : 's'} will be published with this review.`
            : 'No pending diff comments — this submits a review on its own.'}
        </div>

        <textarea
          className="pr-merge-dialog__textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Overview comment (optional)"
          rows={5}
          autoFocus
          // The panel-level Tab handler must not steal focus out of a textarea.
          onKeyDown={(e) => e.stopPropagation()}
        />

        {summary.viewerDidAuthor && (
          // GitHub rejects this rather than ignoring it, so it is worth saying
          // before the request is made.
          <div className="pr-merge-dialog__note">
            You opened this pull request, so only a plain comment can be submitted.
          </div>
        )}

        <div className="pr-merge-dialog__buttons">
          <button className="btn btn--micro pr-merge-dialog__cancel" onClick={onClose}>CANCEL</button>
          {/* Only offered when there is something to discard. Abort, not
              danger: this abandons the user's own unsent draft rather than
              destroying anything published. */}
          {pending && (
            <button className="btn btn--micro btn--abort" disabled={busy} onClick={discard}>
              DISCARD
            </button>
          )}
          <button
            className="btn btn--micro"
            disabled={busy || !hasSubstance}
            title={hasSubstance ? 'Submit as a comment' : needsSubstance}
            onClick={() => submit('COMMENT')}
          >
            COMMENT
          </button>
          {/* The two verdicts are colour-coded rather than ranked: requesting
              changes is a warning, approving is an all-clear. Each carries its
              own semantic modifier, so neither relies on `btn--primary`, which
              sets only border and weight and would leave the text at --c-mid. */}
          <button
            className="btn btn--micro btn--warn"
            disabled={busy || summary.viewerDidAuthor || !hasSubstance}
            title={
              summary.viewerDidAuthor ? 'You cannot review your own pull request'
                : hasSubstance ? 'Submit requesting changes' : needsSubstance
            }
            onClick={() => submit('REQUEST_CHANGES')}
          >
            REQUEST CHANGES
          </button>
          {/* Approve needs no body: an approval with nothing to say is a
              complete review on its own. */}
          <button
            className="btn btn--micro btn--ok"
            disabled={busy || summary.viewerDidAuthor}
            title={summary.viewerDidAuthor ? 'You cannot approve your own pull request' : 'Approve'}
            onClick={() => submit('APPROVE')}
          >
            APPROVE
          </button>
        </div>
      </div>
    </div>
  );
}
