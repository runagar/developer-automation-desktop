import React, { useCallback, useState } from 'react';
import { PrDetail, PrMinimizedState, PrReviewThread, PrSummary, PrTimelineRow } from '../../main/types';
import { addedCommentRow, canEditComment, useGitHubStore } from '../stores/githubStore';
import { Reply, Trash2 } from 'lucide-react';
import { relativeTime } from '../utils/relativeTime';
import { cn } from '../utils/cn';
import { OverviewThreadPlacement, placeOverviewThreads } from '../utils/overviewThreads';
import CommentComposer from './CommentComposer';
import CommentThread from './CommentThread';
import ConfirmDialog from './ConfirmDialog';
import EditButton from './EditButton';
import EditableMarkdown from './EditableMarkdown';
import ResolveButton from './ResolveButton';

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
      <span className="pr-overview__text pr-overview__text--label">force-pushed</span>
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
 * A dismissed review.
 *
 * Structured like a force-push row rather than a plain event, because the two
 * cases read differently and the stale one names a commit worth opening:
 *
 *  - **Stale** — a push invalidated the review under a branch-protection rule.
 *    Nobody decided anything; the useful fact is which push did it.
 *  - **Manual** — someone dismissed it deliberately, and said why.
 */
function DismissalRow({ row }: { row: Extract<PrTimelineRow, { kind: 'dismissal' }> }): React.ReactElement {
  const openDiffFor = useGitHubStore((s) => s.openDiffFor);
  const { commit } = row;
  // GitHub says "dismissed Y's review"; fall back when the reviewer cannot be
  // resolved, e.g. a deleted account.
  const whose = row.reviewer ? `${row.reviewer}'s` : 'a';

  return (
    <div className="pr-overview__row">
      <span className="pr-overview__icon">•</span>
      <span className="pr-overview__actor">{row.actor ?? 'someone'}</span>
      {commit ? (
        <>
          <span className="pr-overview__text pr-overview__text--label">dismissed {whose} stale review via</span>
          <button
            className="pr-overview__hash"
            title="Show the commit that invalidated this review"
            onClick={() => openDiffFor({
              kind: 'commit', oid: commit.oid, abbreviatedOid: commit.abbreviatedOid,
            })}
          >
            {commit.abbreviatedOid}
          </button>
        </>
      ) : (
        <span className="pr-overview__text">
          dismissed {whose} review{row.message ? `: ${row.message}` : ''}
        </span>
      )}
      <span className="pr-overview__time">{relativeTime(row.at)}</span>
    </div>
  );
}

function minimizedText(reason: string | null): string {
  return reason ? `This comment was marked as ${reason.replace(/[-_]/g, ' ')}.` : 'This comment was hidden.';
}

function useResolvable(id: string, state: PrMinimizedState): {
  open: boolean;
  toggleOpen: () => void;
  toggleResolved: () => void;
} {
  const setCommentResolved = useGitHubStore((s) => s.setCommentResolved);
  const editing = useGitHubStore((s) => id in s.edits);
  const [expanded, setExpanded] = useState(!state.isMinimized);
  const open = !state.isMinimized || expanded || editing;

  const toggleResolved = async (): Promise<void> => {
    const next = await setCommentResolved(id, !state.isMinimized);
    if (next) setExpanded(!next.isMinimized);
  };

  return {
    open,
    toggleOpen: () => setExpanded(!open),
    toggleResolved: () => void toggleResolved(),
  };
}

function MinimizeButton(
  { state, onClick }: { state: PrMinimizedState; onClick: () => void }
): React.ReactElement | null {
  const allowed = state.isMinimized ? state.viewerCanUnminimize : state.viewerCanMinimize;
  if (!allowed) return null;
  const title = !state.isMinimized ? 'Resolve: hide this comment as resolved'
    : state.minimizedReason === 'resolved' ? 'Unresolve: show this comment again'
      : 'Unhide: show this comment again';
  return (
    <ResolveButton className="pr-overview__resolve" resolved={state.isMinimized} title={title} onClick={onClick} />
  );
}

function MinimizableBody(
  { state, open, onToggle, children }: {
    state: PrMinimizedState;
    open: boolean;
    onToggle: () => void;
    children: React.ReactNode;
  }
): React.ReactElement {
  if (!state.isMinimized) return <>{children}</>;
  return (
    <div className="pr-overview__minimizable">
      <button className="pr-overview__minimized" onClick={onToggle}>
        <span className="pr-overview__minimized-reason">
          {open ? '▾' : '▸'} {minimizedText(state.minimizedReason)}
        </span>
        <span>{open ? 'Hide comment' : 'Show comment'}</span>
      </button>
      {open && children}
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
  { row, placement, pendingReviewId, onQuote, onDelete }: {
    row: Extract<PrTimelineRow, { kind: 'review' }>;
    placement: OverviewThreadPlacement;
    pendingReviewId: string | null;
    onQuote: (author: string | null, body: string) => void;
    onDelete: (id: string, kind: 'review' | 'issue') => void;
  }
): React.ReactElement | null {
  const openFileInDiff = useGitHubStore((s) => s.openFileInDiff);
  const startEdit = useGitHubStore((s) => s.startEdit);
  const editComment = useGitHubStore((s) => s.editComment);
  const resolvable = useResolvable(row.id, row);

  const visibleComments = row.comments.filter((c) => !placement.hiddenCommentIds.has(c.id));
  const isReplyOnlyComment = row.state === 'COMMENTED' && !row.body
    && visibleComments.length === 0 && row.moreComments === 0;
  if (isReplyOnlyComment) return null;

  return (
    <div className={cn('pr-overview__comment', `pr-overview__comment--${row.state.toLowerCase()}`)}>
      <div className="pr-overview__comment-meta">
        <span className="pr-overview__actor">{row.author ?? 'unknown'}</span>
        <span className="pr-overview__review-state">{row.state.replace(/_/g, ' ').toLowerCase()}</span>
        <span className="pr-overview__time">
          {relativeTime(row.at)}
          {row.lastEditedAt && ' · edited'}
        </span>
        {row.body && (
          <span className="pr-overview__actions">
            {!row.isMinimized && (
              <button
                className="pr-overview__quote"
                title="Quote reply"
                onClick={() => onQuote(row.author, row.body)}
              >
                <Reply size={16} />
              </button>
            )}
            <MinimizeButton state={row} onClick={resolvable.toggleResolved} />
            {canEditComment(row) && (
              <EditButton
                className="pr-overview__edit"
                title="Edit this review's comment"
                onClick={() => startEdit(row.id, row.body)}
              />
            )}
          </span>
        )}
      </div>

      <MinimizableBody state={row} open={resolvable.open} onToggle={resolvable.toggleOpen}>
        <EditableMarkdown
          id={row.id}
          body={row.body}
          bodyClassName="pr-overview__comment-body"
          onSave={(body) => editComment(row.id, 'review-body', body)}
        />

        {visibleComments.map((comment) => {
          const thread = placement.threadByAnchorCommentId.get(comment.id) ?? null;
          return (
            <div key={comment.id} className="pr-overview__review-comment">
              <div className="pr-overview__comment-meta">
                <button
                  className="pr-overview__file-link"
                  title={`Open ${comment.path} in the diff`}
                  onClick={() => openFileInDiff(comment.path)}
                >
                  {comment.path.split('/').pop()}
                  {comment.line !== null && `:${comment.line}`}
                </button>
                {/* Only when the thread is not rendered below — that carries its
                    own per-comment edit, delete and edited marker. */}
                {!thread && comment.lastEditedAt && <span className="pr-overview__time">edited</span>}
                {!thread && (canEditComment(comment) || comment.viewerCanDelete) && (
                  <span className="pr-overview__actions">
                    {canEditComment(comment) && (
                      <EditButton className="pr-overview__edit" onClick={() => startEdit(comment.id, comment.body)} />
                    )}
                    {comment.viewerCanDelete && (
                      <button
                        className="pr-overview__delete"
                        title="Delete this comment"
                        onClick={() => onDelete(comment.id, 'review')}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {/* The full thread where one is known, so it can be replied to and
                  resolved from here; the bare body only when it cannot be
                  matched (e.g. the thread page cap was hit). */}
              {thread ? (
                <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
              ) : (
                <EditableMarkdown
                  id={comment.id}
                  body={comment.body}
                  bodyClassName="pr-overview__comment-body"
                  onSave={(body) => editComment(comment.id, 'review', body)}
                />
              )}
            </div>
          );
        })}

        {row.moreComments > 0 && (
          <div className="pr-overview__review-more">
            {row.moreComments} more comment{row.moreComments === 1 ? '' : 's'} — open the Diff tab
          </div>
        )}
      </MinimizableBody>
    </div>
  );
}

function CommentRow(
  { row, onQuote, onDelete }: {
    row: Extract<PrTimelineRow, { kind: 'comment' }>;
    onQuote: (author: string | null, body: string) => void;
    onDelete: (id: string, kind: 'review' | 'issue') => void;
  }
): React.ReactElement {
  const startEdit = useGitHubStore((s) => s.startEdit);
  const editComment = useGitHubStore((s) => s.editComment);
  const resolvable = useResolvable(row.id, row);

  return (
    <div className="pr-overview__comment">
      <div className="pr-overview__comment-meta">
        <span className="pr-overview__actor">{row.author ?? 'unknown'}</span>
        <span className="pr-overview__time">
          {relativeTime(row.at)}
          {row.lastEditedAt && ' · edited'}
        </span>
        <span className="pr-overview__actions">
          {/* Issue comments have no threading on GitHub — there is no reply
              mutation for them. Quoting into a new comment is what
              github.com offers and what "respond" can mean here. */}
          {!row.isMinimized && (
            <button
              className="pr-overview__quote"
              title="Quote reply"
              onClick={() => onQuote(row.author, row.body)}
            >
              <Reply size={16} />
            </button>
          )}
          <MinimizeButton state={row} onClick={resolvable.toggleResolved} />
          {canEditComment(row) && (
            <EditButton className="pr-overview__edit" onClick={() => startEdit(row.id, row.body)} />
          )}
          {row.viewerCanDelete && (
            <button
              className="pr-overview__delete"
              title="Delete this comment"
              onClick={() => onDelete(row.id, 'issue')}
            >
              <Trash2 size={16} />
            </button>
          )}
        </span>
      </div>
      <MinimizableBody state={row} open={resolvable.open} onToggle={resolvable.toggleOpen}>
        <EditableMarkdown
          id={row.id}
          body={row.body}
          bodyClassName="pr-overview__comment-body"
          onSave={(body) => editComment(row.id, 'issue', body)}
        />
      </MinimizableBody>
    </div>
  );
}

interface RowProps {
  row: PrTimelineRow;
  threads: PrReviewThread[];
  placement: OverviewThreadPlacement;
  pendingReviewId: string | null;
  onQuote: (author: string | null, body: string) => void;
  onDelete: (id: string, kind: 'review' | 'issue') => void;
}

function Row({
  row, threads, placement, pendingReviewId, onQuote, onDelete,
}: RowProps): React.ReactElement | null {
  const startEdit = useGitHubStore((s) => s.startEdit);
  const editComment = useGitHubStore((s) => s.editComment);

  switch (row.kind) {
    case 'commit':
      return <CommitRow row={row} />;

    case 'force-push':
      return <ForcePushRow row={row} />;

    case 'dismissal':
      return <DismissalRow row={row} />;

    case 'comment':
      return <CommentRow row={row} onQuote={onQuote} onDelete={onDelete} />;

    case 'review':
      return (
        <ReviewRow
          row={row}
          placement={placement}
          pendingReviewId={pendingReviewId}
          onQuote={onQuote}
          onDelete={onDelete}
        />
      );

    case 'outdated-thread': {
      // Already printed in full under the review that opened it; printing it
      // again here would duplicate the whole conversation.
      if (placement.claimedThreadIds.has(row.id)) return null;
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
            <span className="pr-overview__time">
              {relativeTime(row.at)}
              {!thread && row.lastEditedAt && ' · edited'}
            </span>
            {!thread && canEditComment(row) && (
              <span className="pr-overview__actions">
                <EditButton className="pr-overview__edit" onClick={() => startEdit(row.commentId, row.body)} />
              </span>
            )}
          </div>
          {thread ? (
            <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
          ) : (
            <EditableMarkdown
              id={row.commentId}
              body={row.body}
              bodyClassName="pr-overview__comment-body"
              onSave={(body) => editComment(row.commentId, 'review', body)}
            />
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

function DescriptionBlock({ summary }: { summary: PrSummary }): React.ReactElement | null {
  const startEdit = useGitHubStore((s) => s.startEdit);
  const updatePullRequest = useGitHubStore((s) => s.updatePullRequest);

  if (!summary.body && !summary.viewerCanUpdate) return null;

  return (
    <div className="pr-overview__comment">
      <div className="pr-overview__comment-meta">
        <span className="pr-overview__actor">{summary.author ?? 'unknown'}</span>
        <span className="pr-overview__review-state">opened this pull request</span>
        <span className="pr-overview__time">
          {relativeTime(summary.createdAt)}
          {summary.lastEditedAt && ' · edited'}
        </span>
        {summary.viewerCanUpdate && (
          <span className="pr-overview__actions">
            <EditButton
              className="pr-overview__edit"
              title="Edit the description"
              onClick={() => startEdit(summary.id, summary.body)}
            />
          </span>
        )}
      </div>
      <EditableMarkdown
        id={summary.id}
        body={summary.body}
        bodyClassName="pr-overview__comment-body"
        allowEmpty
        emptyText="No description provided."
        onSave={(body) => updatePullRequest({ body })}
      />
    </div>
  );
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

  const placement = React.useMemo(() => placeOverviewThreads(timeline, threads), [threads, timeline]);

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
    if (comment) appendTimelineRow(addedCommentRow(comment));
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
      <DescriptionBlock summary={summary} />

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
          placement={placement}
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
