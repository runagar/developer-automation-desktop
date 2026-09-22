import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PrReviewThread } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { Trash2 } from 'lucide-react';
import { relativeTime } from '../utils/relativeTime';
import { cn } from '../utils/cn';
import CommentComposer from './CommentComposer';
import ConfirmDialog from './ConfirmDialog';

interface Props {
  thread: PrReviewThread;
  /** Non-null while a review is in progress; a reply then joins that review. */
  pendingReviewId: string | null;
}

/**
 * One inline review thread.
 *
 * Subscribes to nothing global: the thread arrives as a prop and the only
 * store access is for the mutation helpers, so one thread updating does not
 * re-render the rest of the diff.
 */
export default function CommentThread({ thread, pendingReviewId }: Props): React.ReactElement {
  const run = useGitHubStore((s) => s.run);
  const patchThread = useGitHubStore((s) => s.patchThread);
  const appendThreadComment = useGitHubStore((s) => s.appendThreadComment);
  const bumpPendingCount = useGitHubStore((s) => s.bumpPendingCount);
  const removeComment = useGitHubStore((s) => s.removeComment);

  const [replying, setReplying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // A resolved thread is collapsed by default — that is the point of
  // resolving it — but stays expandable.
  const [expanded, setExpanded] = useState(!thread.isResolved);

  const toggleResolved = async (): Promise<void> => {
    const next = !thread.isResolved;
    const state = await run(() => window.dad.githubSetThreadResolved(thread.id, next));
    // The whole state is applied, not just `isResolved`: viewerCanResolve and
    // viewerCanUnresolve flip with it, and keeping the stale pair makes the
    // opposite action disappear.
    if (state) {
      patchThread(thread.id, state);
      // Follow the thread: collapse on resolve, reveal on unresolve.
      setExpanded(!state.isResolved);
    }
  };

  const reply = async (body: string): Promise<void> => {
    const comment = await run(() => window.dad.githubReplyThread(thread.id, pendingReviewId, body));
    if (comment) {
      appendThreadComment(thread.id, comment);
      if (pendingReviewId) bumpPendingCount(1);
      setReplying(false);
    }
  };

  const doDelete = async (commentId: string): Promise<void> => {
    const ok = await run(() => window.dad.githubDeleteComment(commentId, 'review'));
    if (ok !== null) removeComment(commentId);
  };

  const canToggleResolved = thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve;

  /**
   * Which lines the thread is attached to.
   *
   * Worth stating in words even though the thread renders beside them: a
   * multi-line thread otherwise gives no clue how far its range reaches, and
   * an outdated one is shown in the Overview with no diff around it at all.
   */
  const range = thread.line === null
    ? null
    : thread.startLine !== null && thread.startLine !== thread.line
      ? `lines ${thread.startLine}–${thread.line}`
      : `line ${thread.line}`;

  return (
    <div className={cn('pr-thread', thread.isResolved && 'pr-thread--resolved')}>
      <div className="pr-thread__bar">
        <button className="pr-thread__toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '▾' : '▸'} {thread.comments.length} comment{thread.comments.length === 1 ? '' : 's'}
          {range && <span className="pr-thread__range"> on {range}</span>}
          {thread.isResolved && ' · resolved'}
          {thread.isOutdated && ' · outdated'}
        </button>
        {canToggleResolved && (
          <button className="btn btn--micro" onClick={() => void toggleResolved()}>
            {thread.isResolved ? 'UNRESOLVE' : 'RESOLVE'}
          </button>
        )}
      </div>

      {expanded && (
        <>
          {thread.comments.map((comment) => (
            <div key={comment.id} className="pr-thread__comment">
              <div className="pr-thread__meta">
                <span className="pr-thread__author">{comment.author ?? 'unknown'}</span>
                <span className="pr-thread__time">{relativeTime(comment.createdAt)}</span>
                {comment.state === 'PENDING' && <span className="pr-thread__pending">PENDING</span>}
                {comment.viewerCanDelete && (
                  <button
                    className="pr-thread__delete"
                    title="Delete this comment"
                    onClick={() => setConfirmDelete(comment.id)}
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
              <div className="pr-thread__body markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
              </div>
            </div>
          ))}

          {thread.viewerCanReply && (
            replying ? (
              <CommentComposer
                draftKey={`reply:${thread.id}`}
                placeholder="Reply…"
                submitLabel={pendingReviewId ? 'ADD TO REVIEW' : 'REPLY'}
                autoFocus
                onSubmit={reply}
                onCancel={() => setReplying(false)}
              />
            ) : (
              <button className="btn btn--micro pr-thread__reply" onClick={() => setReplying(true)}>
                REPLY
              </button>
            )
          )}
        </>
      )}
      {confirmDelete && (
        <ConfirmDialog
          message="Delete this comment?"
          detail="Deleting a comment cannot be undone."
          confirmLabel="DELETE"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => { const id = confirmDelete; setConfirmDelete(null); void doDelete(id); }}
        />
      )}
    </div>
  );
}
