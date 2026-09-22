import { describe, it, expect } from 'vitest';
import { TIMELINE_ITEM_TYPES, TIMELINE_TYPENAMES, mergePages, normalizeTimeline } from './githubTimeline';

function commitNode(oid: string, at = '2026-09-01T10:00:00Z') {
  return {
    __typename: 'PullRequestCommit',
    id: `c-${oid}`,
    commit: {
      oid,
      abbreviatedOid: oid.slice(0, 7),
      messageHeadline: `work on ${oid}`,
      committedDate: at,
      author: { name: 'Ada', user: { login: 'ada' } },
    },
  };
}

describe('TIMELINE_ITEM_TYPES', () => {
  it('is a whitelist of 27 types', () => {
    expect(TIMELINE_ITEM_TYPES).toHaveLength(27);
    expect(new Set(TIMELINE_ITEM_TYPES).size).toBe(27);
  });

  it('keeps the enum spelling for the query and the __typename spelling for the response', () => {
    // These are NOT interchangeable. `itemTypes` takes enum members; the
    // response carries object type names. Matching a response against the
    // enum spelling silently discards every node — which is exactly the bug
    // that shipped an empty Overview.
    expect(TIMELINE_ITEM_TYPES).toContain('REVIEW_REQUESTED_EVENT');
    expect(TIMELINE_ITEM_TYPES).not.toContain('ReviewRequestedEvent');
    expect(TIMELINE_TYPENAMES.has('ReviewRequestedEvent')).toBe(true);
    expect(TIMELINE_TYPENAMES.has('REVIEW_REQUESTED_EVENT')).toBe(false);
    expect(TIMELINE_TYPENAMES.size).toBe(TIMELINE_ITEM_TYPES.length);
  });

  it('renders a real GitHub timeline payload rather than dropping it', () => {
    // Recorded from Nykredit/rs-rp-prepayment-offer#1359, whose Overview came
    // back empty. Verbatim __typename values, so this test cannot pass while
    // the matching spelling is wrong.
    const recorded = [
      {
        __typename: 'ReviewRequestedEvent',
        id: 'RRE_1',
        createdAt: '2026-09-10T09:24:31Z',
        actor: { login: 'Y0FV_NYK' },
        requestedReviewer: { __typename: 'User', login: 'RULU_NYK' },
      },
      {
        __typename: 'HeadRefForcePushedEvent',
        id: 'HRFPE_1',
        createdAt: '2026-09-10T10:00:00Z',
        actor: { login: 'Y0FV_NYK' },
        beforeCommit: { oid: 'b'.repeat(40), abbreviatedOid: 'bbbbbbb' },
        afterCommit: { oid: 'a'.repeat(40), abbreviatedOid: 'aaaaaaa' },
      },
      {
        __typename: 'ReviewDismissedEvent',
        id: 'RDE_1',
        createdAt: '2026-09-10T11:00:00Z',
        actor: { login: 'Y0FV_NYK' },
      },
      {
        __typename: 'IssueComment',
        id: 'IC_1',
        createdAt: '2026-09-10T12:00:00Z',
        body: 'looks good',
        author: { login: 'CNDU_NYK' },
      },
    ];

    const { rows } = normalizeTimeline(recorded);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.kind)).toEqual(['event', 'force-push', 'event', 'comment']);
  });

  it('excludes the noisy types the feature plan rejected', () => {
    for (const excluded of [
      'SUBSCRIBED_EVENT', 'MENTIONED_EVENT', 'REFERENCED_EVENT', 'CROSS_REFERENCED_EVENT',
      'DEPLOYED_EVENT', 'HEAD_REF_DELETED_EVENT', 'COMMENT_DELETED_EVENT', 'LOCKED_EVENT',
    ]) {
      expect(TIMELINE_ITEM_TYPES).not.toContain(excluded);
    }
  });

  it('includes the inverses of the state-changing events it keeps', () => {
    // Showing only the additions makes the history lie.
    expect(TIMELINE_ITEM_TYPES).toContain('UNASSIGNED_EVENT');
    expect(TIMELINE_ITEM_TYPES).toContain('UNLABELED_EVENT');
    expect(TIMELINE_ITEM_TYPES).toContain('DEMILESTONED_EVENT');
  });
});

describe('normalizeTimeline', () => {
  it('drops an unknown __typename instead of crashing', () => {
    // GitHub adds enum members without warning; a new one must default to
    // hidden rather than render as "undefined".
    const { rows } = normalizeTimeline([
      { __typename: 'SOME_FUTURE_EVENT', id: 'x', createdAt: '2026-01-01T00:00:00Z' },
      commitNode('aaaaaaa1'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('commit');
  });

  it('tolerates null and non-object nodes', () => {
    expect(normalizeTimeline([null, 42, undefined] as unknown[]).rows).toHaveLength(0);
    expect(normalizeTimeline([]).rows).toHaveLength(0);
  });

  it('emits one row per commit, not one per push', () => {
    // A push of three commits arrives as three PullRequestCommit nodes.
    const { rows } = normalizeTimeline([
      commitNode('aaaaaaa1', '2026-09-01T10:00:00Z'),
      commitNode('aaaaaaa2', '2026-09-01T10:01:00Z'),
      commitNode('aaaaaaa3', '2026-09-01T10:02:00Z'),
    ]);
    expect(rows.filter((r) => r.kind === 'commit')).toHaveLength(3);
  });

  it('gives a force push its own range row and collects it for the diff dropdown', () => {
    const { rows, forcePushes } = normalizeTimeline([
      {
        __typename: 'HeadRefForcePushedEvent',
        id: 'fp1',
        createdAt: '2026-09-02T09:00:00Z',
        actor: { login: 'ada' },
        beforeCommit: { oid: 'b'.repeat(40), abbreviatedOid: 'bbbbbbb' },
        afterCommit: { oid: 'a'.repeat(40), abbreviatedOid: 'aaaaaaa' },
      },
    ]);
    expect(rows[0]).toMatchObject({ kind: 'force-push', actor: 'ada' });
    expect(forcePushes).toHaveLength(1);
    expect(forcePushes[0]).toMatchObject({ beforeAbbrev: 'bbbbbbb', afterAbbrev: 'aaaaaaa' });
  });

  it('keeps a force push whose before-commit was garbage-collected, with a null boundary', () => {
    // The range is unusable, but hiding the event would hide that history was
    // rewritten. The row renders disabled instead.
    const { rows, forcePushes } = normalizeTimeline([
      {
        __typename: 'HeadRefForcePushedEvent',
        id: 'fp2',
        createdAt: '2026-09-02T09:00:00Z',
        actor: { login: 'ada' },
        beforeCommit: null,
        afterCommit: { oid: 'a'.repeat(40), abbreviatedOid: 'aaaaaaa' },
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(forcePushes[0].beforeOid).toBeNull();
  });

  it('skips a force push with no after-commit', () => {
    const { rows } = normalizeTimeline([
      { __typename: 'HeadRefForcePushedEvent', id: 'fp3', afterCommit: null },
    ]);
    expect(rows).toHaveLength(0);
  });

  it('hides the viewer\'s own PENDING review', () => {
    // A pending review is an unsent draft; it belongs in the composer, not in
    // the public history.
    const { rows } = normalizeTimeline([
      { __typename: 'PullRequestReview', id: 'r1', createdAt: '2026-09-03T00:00:00Z', state: 'PENDING', body: 'wip' },
      { __typename: 'PullRequestReview', id: 'r2', createdAt: '2026-09-03T01:00:00Z', state: 'APPROVED', body: 'lgtm', author: { login: 'bob' } },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'review', state: 'APPROVED', author: 'bob' });
  });

  it('surfaces only outdated review threads', () => {
    // Live threads render inline in the diff; outdated ones have no line to
    // attach to and would otherwise be invisible.
    const thread = (id: string, outdated: boolean) => ({
      __typename: 'PullRequestReviewThread',
      id,
      isOutdated: outdated,
      isResolved: false,
      path: 'src/a.ts',
      comments: { nodes: [{ id: `${id}-c`, createdAt: '2026-09-04T00:00:00Z', body: 'hmm', author: { login: 'bob' } }] },
    });
    const { rows } = normalizeTimeline([thread('t1', true), thread('t2', false)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'outdated-thread', path: 'src/a.ts' });
  });

  it('skips an outdated thread with no comments', () => {
    const { rows } = normalizeTimeline([
      { __typename: 'PullRequestReviewThread', id: 't3', isOutdated: true, comments: { nodes: [] } },
    ]);
    expect(rows).toHaveLength(0);
  });

  it('renders merge-queue and auto-merge events, so a toggle leaves a trace', () => {
    const { rows } = normalizeTimeline([
      { __typename: 'AutoMergeEnabledEvent', id: 'e1', createdAt: '2026-09-05T00:00:00Z', actor: { login: 'ada' } },
      { __typename: 'AddedToMergeQueueEvent', id: 'e2', createdAt: '2026-09-05T01:00:00Z', actor: { login: 'ada' } },
    ]);
    expect(rows.map((r) => (r.kind === 'event' ? r.text : ''))).toEqual([
      'enabled auto-merge',
      'added this to the merge queue',
    ]);
  });

  it('names a requested team by its slug', () => {
    const { rows } = normalizeTimeline([
      {
        __typename: 'ReviewRequestedEvent',
        id: 'e3',
        createdAt: '2026-09-06T00:00:00Z',
        actor: { login: 'ada' },
        requestedReviewer: { __typename: 'Team', slug: 'platform' },
      },
    ]);
    expect(rows[0]).toMatchObject({ kind: 'event', text: 'requested a review from platform' });
  });

  it('orders rows chronologically regardless of arrival order', () => {
    const { rows } = normalizeTimeline([
      commitNode('bbbbbbb1', '2026-09-10T00:00:00Z'),
      { __typename: 'IssueComment', id: 'ic', createdAt: '2026-09-01T00:00:00Z', body: 'first', author: { login: 'ada' } },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['comment', 'commit']);
  });

  it('dates a commit row by its commit date, not the node', () => {
    const { rows } = normalizeTimeline([commitNode('ccccccc1', '2026-08-01T00:00:00Z')]);
    expect(rows[0].at).toBe('2026-08-01T00:00:00Z');
  });
});

describe('mergePages', () => {
  it('concatenates pages in order', () => {
    expect(mergePages([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]]).map((n) => n.id))
      .toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates a node repeated across pages', () => {
    // A write landing between two page fetches shifts the cursor window and
    // can repeat a node.
    expect(mergePages([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]]).map((n) => n.id))
      .toEqual(['a', 'b', 'c']);
  });

  it('keeps nodes that carry no id', () => {
    expect(mergePages([[{} as { id?: string }, {} as { id?: string }]])).toHaveLength(2);
  });
});

describe('review rows', () => {
  it('carries the inline comments of a review whose body is empty', () => {
    // Recorded shape from Nykredit/rs-rp-prepayment-offer#1361: a
    // CHANGES_REQUESTED review with an empty body and one inline comment.
    // Rendering only the body left the Overview stating a verdict with no
    // reasoning, and the substance visible solely in the diff viewer.
    const { rows } = normalizeTimeline([
      {
        __typename: 'PullRequestReview',
        id: 'PRR_1',
        createdAt: '2026-09-19T10:00:00Z',
        state: 'CHANGES_REQUESTED',
        body: '',
        author: { login: 'RULU_NYK' },
        comments: {
          totalCount: 1,
          nodes: [{ id: 'PRRC_1', path: 'src/Foo.java', line: 42, body: 'initialise these' }],
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<typeof rows[number], { kind: 'review' }>;
    expect(row.state).toBe('CHANGES_REQUESTED');
    expect(row.comments).toEqual([
      {
        id: 'PRRC_1',
        path: 'src/Foo.java',
        line: 42,
        body: 'initialise these',
        // Absent from the recorded payload, so it must default to "no".
        viewerCanDelete: false,
      },
    ]);
    expect(row.moreComments).toBe(0);
  });

  it('falls back to originalLine for a comment whose anchor is gone', () => {
    const { rows } = normalizeTimeline([
      {
        __typename: 'PullRequestReview',
        id: 'PRR_2',
        createdAt: '2026-09-19T10:00:00Z',
        state: 'COMMENTED',
        body: '',
        author: { login: 'ada' },
        comments: { totalCount: 1, nodes: [{ id: 'c', path: 'a.ts', line: null, originalLine: 7, body: 'x' }] },
      },
    ]);
    const row = rows[0] as Extract<typeof rows[number], { kind: 'review' }>;
    expect(row.comments[0].line).toBe(7);
  });

  it('reports comments beyond the fetched page', () => {
    const { rows } = normalizeTimeline([
      {
        __typename: 'PullRequestReview',
        id: 'PRR_3',
        createdAt: '2026-09-19T10:00:00Z',
        state: 'COMMENTED',
        body: 'see inline',
        author: { login: 'ada' },
        comments: { totalCount: 53, nodes: [{ id: 'c', path: 'a.ts', line: 1, body: 'x' }] },
      },
    ]);
    const row = rows[0] as Extract<typeof rows[number], { kind: 'review' }>;
    expect(row.moreComments).toBe(52);
  });

  it('still renders a review that has no comments block at all', () => {
    const { rows } = normalizeTimeline([
      {
        __typename: 'PullRequestReview',
        id: 'PRR_4',
        createdAt: '2026-09-19T10:00:00Z',
        state: 'APPROVED',
        body: 'lgtm',
        author: { login: 'ada' },
      },
    ]);
    const row = rows[0] as Extract<typeof rows[number], { kind: 'review' }>;
    expect(row.comments).toEqual([]);
    expect(row.moreComments).toBe(0);
  });
});
