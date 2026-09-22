import React, { useState } from 'react';
import { PrSummary } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { useEscape } from '../hooks/useEscape';

interface Props {
  summary: PrSummary;
  onClose: () => void;
}

/**
 * Close a pull request, optionally with a comment.
 *
 * A sibling of `MergeDialog` and `SubmitReviewDialog` rather than a variant of
 * the shared `ConfirmDialog`: the comment is a domain concern, and threading
 * an optional field through a component four other callers use as a plain
 * yes/no would make it worse for all of them.
 */
export default function ClosePrDialog({ summary, onClose }: Props): React.ReactElement {
  const run = useGitHubStore((s) => s.run);
  const busy = useGitHubStore((s) => s.busy);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const patchSummary = useGitHubStore((s) => s.patchSummary);
  const invalidateLists = useGitHubStore((s) => s.invalidateLists);
  const appendTimelineRow = useGitHubStore((s) => s.appendTimelineRow);

  const [comment, setComment] = useState('');

  /**
   * Close first, then do the work — the same pattern as the merge and submit
   * dialogs. Each of these is a mutation plus a full detail reload, and
   * awaiting all of it before closing made the app look hung.
   */
  const confirm = (): void => {
    const body = comment.trim();
    onClose();
    patchSummary({ state: 'CLOSED' });
    // Closing removes it from the open-only lists, so a targeted patch cannot
    // be honest about what they now contain.
    invalidateLists();

    void (async () => {
      if (body) {
        // Posted before the close, so the timeline reads as a reason followed
        // by its consequence — the order github.com uses.
        const posted = await run(() => window.dad.githubAddComment(summary.id, body));
        if (posted) {
          appendTimelineRow({
            kind: 'comment',
            id: posted.id,
            at: posted.createdAt,
            author: posted.author,
            body: posted.body,
            viewerDidAuthor: true,
            // Just authored it, so it is deletable; the reload confirms.
            viewerCanDelete: true,
          });
        }
      }
      await run(() => window.dad.githubClose(summary.id));
      await reloadDetail();
    })();
  };

  // Escape backs out without closing, discarding any typed comment — identical to CANCEL.
  useEscape(true, onClose);

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="pr-merge-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pr-merge-dialog__title">CLOSE · #{summary.number}</div>

        <div className="pr-merge-dialog__note">{summary.title}</div>

        <textarea
          className="pr-merge-dialog__textarea"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Comment (optional) — why is this being closed?"
          rows={4}
          autoFocus
          // The panel-level Tab handler must not steal focus out of a textarea.
          onKeyDown={(e) => e.stopPropagation()}
        />

        <div className="pr-merge-dialog__buttons">
          <button className="btn btn--micro pr-merge-dialog__cancel" onClick={onClose}>CANCEL</button>
          <button className="btn btn--micro btn--danger" disabled={busy} onClick={confirm}>
            {comment.trim() ? 'COMMENT & CLOSE' : 'CLOSE PR'}
          </button>
        </div>
      </div>
    </div>
  );
}
