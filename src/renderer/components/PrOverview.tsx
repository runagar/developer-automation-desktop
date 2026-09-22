import React, { useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PrDetail, PrReviewThread, PrTimelineRow } from '../../main/types';
import { useGitHubStore } from '../stores/githubStore';
import { Trash2 } from 'lucide-react';
import { relativeTime } from '../utils/relativeTime';
import { cn } from '../utils/cn';
import CommentComposer from './CommentComposer';
import CommentThread from './CommentThread';
import ConfirmDialog from './ConfirmDialog';

interface Props {
  detail: PrDetail;
}

function CommitRow({ row }: { row: Extract<PrTimelineRow, { kind: 'commit' }> }): React.ReactElement {
  const openDiffFor = useGitHubStore((s) => s.openDiffFor);
  return (
    <div className="pr-overview__row">
      <span className="pr-overview__icon">◆</span>
      <button
        className="pr-overview__hash"
        title="Show this commit's diff"
        onClick={() => openDiffFor({ kind: 'commit', oid: row.commit.oid, abbreviatedOid: row.commit.abbreviatedOid })}
      >
        {row.commit.abbreviatedOid}
      </button>
      <span className="pr-overview__text">{row.commit.messageHeadline}</span>
      <span className="pr-overview__time">{relativeTime(row.at)}</span>
    </div>
  );
}

function ForcePushRow({ row }: { row: Extract<PrTimelineRow, { kind: 'force-push' }> }): React.ReactElement {
  const openDiffFor = useGitHubStore((s) => s.openDiffFor);
  const { force } = row;
  const usable = force.beforeOid !== null;

  return (
    <div className="pr-overview__row">
      <span className="pr-overview__icon">⟲</span>
      <span className="pr-overview__actor">{row.actor ?? 'someone'}</span>
      <span className="pr-overview__text">force-pushed</span>
      {usable ? (
        <button
          className="pr-overview__hash"
          title="Show what this force-push changed"
          onClick={() => openDiffFor({
            kind: 'range',
            beforeOid: force.beforeOid as string,
            afterOid: force.afterOid,
            label: `force-push · ${force.beforeAbbrev}…${force.afterAbbrev}`,
          })}
        >
          {force.beforeAbbrev}…{force.afterAbbrev}
        </button>
      ) : (
        // The before-commit has been garbage-collected, so the range cannot be
        // fetched. Hiding the event would hide that history was rewritten.
        <span className="pr-overview__hash pr-overview__hash--dead" title="Before-commit no longer available">
          …{force.afterAbbrev}
        </span>
      )}
      <span className="pr-overview__time">{relativeTime(row.at)}</span>
    </div>
  );
}

/**
 * A submitted review, with its inline comments.
 *
 * The comments matter more than the body here: a "changes requested" review
 * very often has an empty body and says everything inline, so rendering only
 * the body leaves the row stating a verdict with no reasoning.
 */
function ReviewRow(
  { row, threads, pendingReviewId, onDelete }: {
    row: Extract<PrTimelineRow, { kind: 'review' }>;
    threads: PrReviewThread[];
    pendingReviewId: string | null;
    onDelete: (id: string, kind: 'review' | 'issue') => void;
  }
): React.ReactElement {
  const openFileInDiff = useGitHubStore((s) => s.openFileInDiff);

  /**
   * The thread a review comment started, when this review started it.
   *
   * Matching on the thread's *first* comment keeps a thread under the review
   * that opened it — a later reply from another review must not reprint the
   * whole thread a second time further down the timeline.
   */
  const threadStartedHere = (commentId: string): PrReviewThread | null =>
    threads.find((t) => t.comments[0]?.id === commentId) ?? null;

  return (
    <div className={cn('pr-overview__comment', `pr-overview__comment--${row.state.toLowerCase()}`)}>
      <div className="pr-overview__comment-meta">
        <span className="pr-overview__actor">{row.author ?? 'unknown'}</span>
        <span className="pr-overview__review-state">{row.state.replace(/_/g, ' ').toLowerCase()}</span>
        <span className="pr-overview__time">{relativeTime(row.at)}</span>
      </div>

      {row.body && (
        <div className="pr-overview__comment-body markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.body}</ReactMarkdown>
        </div>
      )}

      {row.comments.map((comment) => {
        const thread = threadStartedHere(comment.id);
        return (
          <div key={comment.id} className="pr-overview__review-comment">
            <button
              className="pr-overview__file-link"
              title={`Open ${comment.path} in the diff`}
              onClick={() => openFileInDiff(comment.path)}
            >
              {comment.path.split('/').pop()}
              {comment.line !== null && `:${comment.line}`}
            </button>
            {/* Only when the thread is not rendered below — that carries its
                own per-comment delete. */}
            {!thread && comment.viewerCanDelete && (
              <button
                className="pr-overview__delete"
                title="Delete this comment"
                onClick={() => onDelete(comment.id, 'review')}
              >
                <Trash2 size={11} />
              </button>
            )}
            {/* The full thread where one is known, so it can be replied to and
                resolved from here; the bare body only when it cannot be
                matched (e.g. the thread page cap was hit). */}
            {thread ? (
              <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
            ) : (
              <div className="pr-overview__comment-body markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
              </div>
            )}
          </div>
        );
      })}

      {row.moreComments > 0 && (
        <div className="pr-overview__review-more">
          {row.moreComments} more comment{row.moreComments === 1 ? '' : 's'} — open the Diff tab
        </div>
      )}
    </div>
  );
}

interface RowProps {
  row: PrTimelineRow;
  threads: PrReviewThread[];
  /** Threads already printed under the review that started them. */
  claimedThreadIds: Set<string>;
  pendingReviewId: string | null;
  onQuote: (author: string | null, body: string) => void;
  onDelete: (id: string, kind: 'review' | 'issue') => void;
}

function Row({
  row, threads, claimedThreadIds, pendingReviewId, onQuote, onDelete,
}: RowProps): React.ReactElement | null {
  switch (row.kind) {
    case 'commit':
      return <CommitRow row={row} />;

    case 'force-push':
      return <ForcePushRow row={row} />;

    case 'comment':
      return (
        <div className="pr-overview__comment">
          <div className="pr-overview__comment-meta">
            <span className="pr-overview__actor">{row.author ?? 'unknown'}</span>
            <span className="pr-overview__time">{relativeTime(row.at)}</span>
            {/* Issue comments have no threading on GitHub — there is no reply
                mutation for them. Quoting into a new comment is what
                github.com offers and what "respond" can mean here. */}
            <button
              className="pr-overview__quote"
              title="Quote reply"
              onClick={() => onQuote(row.author, row.body)}
            >
              QUOTE REPLY
            </button>
            {row.viewerCanDelete && (
              <button
                className="pr-overview__delete"
                title="Delete this comment"
                onClick={() => onDelete(row.id, 'issue')}
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
          <div className="pr-overview__comment-body markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.body}</ReactMarkdown>
          </div>
        </div>
      );

    case 'review':
      return (
        <ReviewRow
          row={row}
          threads={threads}
          pendingReviewId={pendingReviewId}
          onDelete={onDelete}
        />
      );

    case 'outdated-thread': {
      // Already printed in full under the review that opened it; printing it
      // again here would duplicate the whole conversation.
      if (claimedThreadIds.has(row.id)) return null;
      // An outdated thread has no line left in the diff to render against, so
      // this is the only place it can be read — and replied to.
      const thread = threads.find((t) => t.id === row.id) ?? null;
      return (
        <div className="pr-overview__comment pr-overview__comment--outdated">
          <div className="pr-overview__comment-meta">
            <span className="pr-overview__actor">{row.author ?? 'unknown'}</span>
            <span className="pr-overview__review-state">
              outdated comment on {row.path}
            </span>
            <span className="pr-overview__time">{relativeTime(row.at)}</span>
          </div>
          {thread ? (
            <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
          ) : (
            <div className="pr-overview__comment-body markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.body}</ReactMarkdown>
            </div>
          )}
        </div>
      );
    }

    case 'event':
      return (
        <div className="pr-overview__row">
          <span className="pr-overview__icon">•</span>
          <span className="pr-overview__actor">{row.actor ?? 'someone'}</span>
          <span className="pr-overview__text">{row.text}</span>
          <span className="pr-overview__time">{relativeTime(row.at)}</span>
        </div>
      );

    default:
      // Exhaustive today; a future row kind renders nothing rather than
      // crashing the panel.
      return null;
  }
}

/**
 * The Conversation equivalent (requirement 3.2.1).
 *
 * The composer here posts an **issue comment**, which GitHub publishes
 * immediately: issue comments have no pending state and no mutation defers
 * them. Batching applies to diff comments and thread replies, and to the
 * review body typed at submit time — exactly as github.com behaves.
 */
export default function PrOverview({ detail }: Props): React.ReactElement {
  const run = useGitHubStore((s) => s.run);
  const appendTimelineRow = useGitHubStore((s) => s.appendTimelineRow);
  const removeComment = useGitHubStore((s) => s.removeComment);
  const reloadDetail = useGitHubStore((s) => s.reloadDetail);
  const patchSummary = useGitHubStore((s) => s.patchSummary);

  const { summary, timeline, threads, historyTruncated } = detail;
  const pending = summary.pendingReview;

  /**
   * Quoted draft for the composer.
   *
   * The composer reads its seed once, so the counter is used as a React key:
   * quoting a second comment must replace the draft, not be ignored because
   * the component is already mounted.
   */
  const [quote, setQuote] = useState<{ seq: number; body: string }>({ seq: 0, body: '' });

  /**
   * Threads rendered under a review, so the outdated-thread rows can skip
   * them. Matching is on the thread's first comment, exactly as `ReviewRow`
   * decides what to claim.
   */
  const claimedThreadIds = React.useMemo(() => {
    const firstCommentIds = new Set(
      threads.map((t) => t.comments[0]?.id).filter((id): id is string => !!id)
    );
    const claimed = new Set<string>();
    for (const row of timeline) {
      if (row.kind !== 'review') continue;
      for (const comment of row.comments) {
        if (!firstCommentIds.has(comment.id)) continue;
        const thread = threads.find((t) => t.comments[0]?.id === comment.id);
        if (thread) claimed.add(thread.id);
      }
    }
    return claimed;
  }, [threads, timeline]);

  const [confirmDelete, setConfirmDelete] = useState<{ id: string; kind: 'review' | 'issue' } | null>(null);

  const handleDelete = useCallback((id: string, kind: 'review' | 'issue') => {
    setConfirmDelete({ id, kind });
  }, []);

  const handleQuote = useCallback((author: string | null, body: string) => {
    const quoted = body.split('\n').map((line) => `> ${line}`).join('\n');
    setQuote((q) => ({
      seq: q.seq + 1,
      body: `${author ? `@${author} ` : ''}said:\n${quoted}\n\n`,
    }));
  }, []);

  const postComment = async (body: string): Promise<void> => {
    const comment = await run(() => window.dad.githubAddComment(summary.id, body));
    if (comment) {
      appendTimelineRow({
        kind: 'comment',
        id: comment.id,
        at: comment.createdAt,
        author: comment.author,
        body: comment.body,
        viewerDidAuthor: true,
        // Just authored it, so it is deletable; the reload confirms.
        viewerCanDelete: true,
      });
    }
  };

  const discard = async (): Promise<void> => {
    if (!pending) return;
    const ok = await run(() => window.dad.githubDiscardReview(pending.id));
    if (ok !== null) {
      patchSummary({ pendingReview: null });
      await reloadDetail();
    }
  };

  /**
   * Draft toggle.
   *
   * Lives here rather than in the header's action row: it is about the state
   * of the pull request being written, not a review verdict, and the row it
   * was in is now exclusively review and merge actions.
   */
  const toggleDraft = async (): Promise<void> => {
    const next = await run(() => window.dad.githubSetDraft(summary.id, !summary.isDraft));
    if (next !== null) {
      patchSummary({ isDraft: next });
      await reloadDetail();
    }
  };

  return (
    <div className="pr-overview">
      {summary.body && (
        <div className="pr-overview__comment">
          <div className="pr-overview__comment-meta">
            <span className="pr-overview__actor">{summary.author ?? 'unknown'}</span>
            <span className="pr-overview__review-state">opened this pull request</span>
            <span className="pr-overview__time">{relativeTime(summary.createdAt)}</span>
          </div>
          <div className="pr-overview__comment-body markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.body}</ReactMarkdown>
          </div>
        </div>
      )}

      {historyTruncated && (
        <div className="pr-overview__truncated">
          History truncated — this pull request has more activity than DAD loads.
        </div>
      )}

      {timeline.map((row) => (
        <Row
          key={row.id}
          row={row}
          threads={threads}
          claimedThreadIds={claimedThreadIds}
          pendingReviewId={pending?.id ?? null}
          onQuote={handleQuote}
          onDelete={handleDelete}
        />
      ))}

      {pending && (
        <div className="pr-overview__pending">
          <span>
            Review in progress — {pending.commentCount} comment{pending.commentCount === 1 ? '' : 's'} pending
          </span>
          <button className="btn btn--micro btn--danger" onClick={() => void discard()}>DISCARD</button>
        </div>
      )}

      <div className="pr-overview__draft-row">
        <button className="btn btn--micro" onClick={() => void toggleDraft()}>
          {summary.isDraft ? 'READY FOR REVIEW' : 'CONVERT TO DRAFT'}
        </button>
      </div>

      <CommentComposer
        key={quote.seq}
        draftKey={`overview:${summary.id}`}
        initialBody={quote.body}
        placeholder="Comment on this pull request…  (Ctrl+Enter to send)"
        submitLabel="COMMENT"
        // No secondary action: a review is opened by commenting on the diff
        // and submitted from the header, so there is nothing to offer here.
        onSubmit={postComment}
      />

      {confirmDelete && (
        <ConfirmDialog
          message="Delete this comment?"
          detail="Deleting a comment cannot be undone."
          confirmLabel="DELETE"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            void (async () => {
              const ok = await run(() => window.dad.githubDeleteComment(target.id, target.kind));
              if (ok !== null) removeComment(target.id);
            })();
          }}
        />
      )}
    </div>
  );
}
