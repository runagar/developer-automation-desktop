import { PrReviewThread, PrTimelineRow } from '../../main/types';

export interface OverviewThreadPlacement {
  threadByAnchorCommentId: Map<string, PrReviewThread>;
  claimedThreadIds: Set<string>;
  hiddenCommentIds: Set<string>;
}

type ReviewRow = Extract<PrTimelineRow, { kind: 'review' }>;

export function placeOverviewThreads(
  timeline: PrTimelineRow[],
  threads: PrReviewThread[]
): OverviewThreadPlacement {
  const threadByCommentId = new Map<string, PrReviewThread>();
  for (const thread of threads) {
    for (const comment of thread.comments) threadByCommentId.set(comment.id, thread);
  }

  const reviewCommentIds = timeline
    .filter((row): row is ReviewRow => row.kind === 'review')
    .flatMap((row) => row.comments.map((comment) => comment.id));

  const anchorByThreadId = new Map<string, string>();
  for (const commentId of reviewCommentIds) {
    const thread = threadByCommentId.get(commentId);
    if (thread && thread.comments[0]?.id === commentId) anchorByThreadId.set(thread.id, commentId);
  }
  for (const commentId of reviewCommentIds) {
    const thread = threadByCommentId.get(commentId);
    if (thread && !anchorByThreadId.has(thread.id)) anchorByThreadId.set(thread.id, commentId);
  }

  const threadByAnchorCommentId = new Map<string, PrReviewThread>();
  const hiddenCommentIds = new Set<string>();
  for (const commentId of reviewCommentIds) {
    const thread = threadByCommentId.get(commentId);
    if (!thread) continue;
    if (anchorByThreadId.get(thread.id) === commentId) {
      threadByAnchorCommentId.set(commentId, thread);
    } else {
      hiddenCommentIds.add(commentId);
    }
  }

  return {
    threadByAnchorCommentId,
    claimedThreadIds: new Set(anchorByThreadId.keys()),
    hiddenCommentIds,
  };
}
