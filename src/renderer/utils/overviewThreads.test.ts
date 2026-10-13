import { describe, it, expect } from 'vitest';
import { PrReviewThread, PrTimelineRow } from '../../main/types';
import { placeOverviewThreads } from './overviewThreads';

function thread(id: string, commentIds: string[]): PrReviewThread {
  return {
    id,
    isResolved: true,
    isOutdated: true,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    viewerCanReply: true,
    path: 'src/A.java',
    line: 93,
    startLine: null,
    side: 'RIGHT',
    subjectType: 'LINE',
    originalLine: 93,
    originalStartLine: null,
    originalCommitOid: null,
    comments: commentIds.map((cid) => ({
      id: cid,
      databaseId: null,
      body: cid,
      createdAt: '',
      author: null,
      viewerDidAuthor: false,
      outdated: true,
      state: 'SUBMITTED',
      viewerCanDelete: false,
    })),
  };
}

function review(id: string, at: string, commentIds: string[]): PrTimelineRow {
  return {
    kind: 'review',
    id,
    at,
    author: null,
    state: 'COMMENTED',
    body: '',
    comments: commentIds.map((cid) => ({ id: cid, path: 'src/A.java', line: 93, body: cid, viewerCanDelete: true })),
    moreComments: 0,
  };
}

describe('placeOverviewThreads', () => {
  it('anchors a thread at its first comment and hides replies from later reviews', () => {
    // Given
    const threads = [thread('t1', ['c1', 'c2', 'c3'])];
    const timeline = [
      review('r1', '2026-01-01', ['c1']),
      review('r2', '2026-01-02', ['c2', 'own']),
      review('r3', '2026-01-03', ['c3']),
    ];

    // When
    const placement = placeOverviewThreads(timeline, threads);

    // Then
    expect([...placement.threadByAnchorCommentId.keys()]).toEqual(['c1']);
    expect([...placement.hiddenCommentIds].sort()).toEqual(['c2', 'c3']);
    expect([...placement.claimedThreadIds]).toEqual(['t1']);
  });

  it('anchors at the earliest reply when the opening review is missing from the timeline', () => {
    // Given
    const threads = [thread('t1', ['c1', 'c2', 'c3'])];
    const timeline = [review('r2', '2026-01-02', ['c2']), review('r3', '2026-01-03', ['c3'])];

    // When
    const placement = placeOverviewThreads(timeline, threads);

    // Then
    expect(placement.threadByAnchorCommentId.get('c2')?.id).toBe('t1');
    expect([...placement.hiddenCommentIds]).toEqual(['c3']);
    expect(placement.claimedThreadIds.has('t1')).toBe(true);
  });

  it('leaves comments with no known thread unanchored and visible', () => {
    // Given
    const timeline = [review('r1', '2026-01-01', ['orphan'])];

    // When
    const placement = placeOverviewThreads(timeline, []);

    // Then
    expect(placement.threadByAnchorCommentId.size).toBe(0);
    expect(placement.hiddenCommentIds.size).toBe(0);
    expect(placement.claimedThreadIds.size).toBe(0);
  });
});
