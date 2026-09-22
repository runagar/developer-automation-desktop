import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  STALE_MS, diffRefKey, diffRefOptions, formatRef, isFileViewed, nextSelectedPath,
  commentCountsByFile, parseRef, sameRef, threadsForFile, useGitHubStore,
} from './githubStore';
import { PrDetail, PrDiffFile, PrDiffRef, PrListItem, PrReviewThread, PrSummary } from '../../main/types';

function file(path: string, viewed = false): PrDiffFile {
  return {
    path, previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@', viewed,
  };
}

function thread(over: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: 't1', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true,
    viewerCanReply: true, path: 'a.ts', line: 3, startLine: null, side: 'RIGHT', comments: [], ...over,
  };
}

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    summary: {} as PrDetail['summary'],
    commits: [],
    forcePushes: [],
    timeline: [],
    threads: [],
    historyTruncated: false,
    ...over,
  };
}

describe('parseRef / formatRef', () => {
  it('round-trips owner/repo#number', () => {
    const ref = { owner: 'Nykredit', repo: 'rs-thing', number: 42 };
    expect(parseRef(formatRef(ref))).toEqual(ref);
  });

  it('rejects anything that is not exactly that shape', () => {
    // A malformed persisted value must degrade to "nothing open" rather than
    // producing a request for a pull request that cannot exist.
    for (const bad of [null, '', 'nope', 'owner/repo', 'owner/repo#', 'owner/repo#abc', 'owner#3', 'a/b#0', 'a/b#-1']) {
      expect(parseRef(bad)).toBeNull();
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRef('  a/b#7  ')).toEqual({ owner: 'a', repo: 'b', number: 7 });
  });
});

describe('sameRef', () => {
  it('compares by value, and treats nulls as equal only to each other', () => {
    expect(sameRef({ owner: 'a', repo: 'b', number: 1 }, { owner: 'a', repo: 'b', number: 1 })).toBe(true);
    expect(sameRef({ owner: 'a', repo: 'b', number: 1 }, { owner: 'a', repo: 'b', number: 2 })).toBe(false);
    expect(sameRef(null, null)).toBe(true);
    expect(sameRef(null, { owner: 'a', repo: 'b', number: 1 })).toBe(false);
  });
});

describe('diffRefKey', () => {
  it('distinguishes the full PR, a commit and a range', () => {
    // Commit-scoped viewed state is keyed on this; a collision would mark a
    // file viewed in a commit the user never opened.
    expect(diffRefKey({ kind: 'pr' })).toBe('pr');
    expect(diffRefKey({ kind: 'commit', oid: 'abc', abbreviatedOid: 'abc' })).toBe('commit:abc');
    expect(diffRefKey({ kind: 'range', beforeOid: 'a', afterOid: 'b', label: '' })).toBe('range:a..b');
  });
});

describe('isFileViewed', () => {
  const local = new Map([['commit:abc', new Set(['a.ts'])]]);

  it('reads GitHub state in full-PR mode and ignores local state', () => {
    expect(isFileViewed(file('a.ts', true), { kind: 'pr' }, local)).toBe(true);
    expect(isFileViewed(file('a.ts', false), { kind: 'pr' }, local)).toBe(false);
  });

  it('reads local state in commit mode and ignores GitHub state', () => {
    const ref: PrDiffRef = { kind: 'commit', oid: 'abc', abbreviatedOid: 'abc' };
    expect(isFileViewed(file('a.ts', false), ref, local)).toBe(true);
    // Viewed in commit abc must not leak into commit def.
    const other: PrDiffRef = { kind: 'commit', oid: 'def', abbreviatedOid: 'def' };
    expect(isFileViewed(file('a.ts', true), other, local)).toBe(false);
  });
});

describe('nextSelectedPath', () => {
  it('keeps the selected file when it still exists', () => {
    // Resetting unconditionally would scroll the user back to the top on
    // every refresh.
    expect(nextSelectedPath('b.ts', [file('a.ts'), file('b.ts')])).toBe('b.ts');
  });

  it('falls back to the first file when the selection is gone', () => {
    expect(nextSelectedPath('gone.ts', [file('a.ts')])).toBe('a.ts');
    expect(nextSelectedPath(null, [file('a.ts')])).toBe('a.ts');
  });

  it('returns null for an empty diff', () => {
    expect(nextSelectedPath('a.ts', [])).toBeNull();
  });
});

describe('diffRefOptions', () => {
  it('puts the full PR diff first', () => {
    const options = diffRefOptions(detail({
      commits: [{ oid: 'c1', abbreviatedOid: 'c1', messageHeadline: 'one', committedDate: '', author: null }],
    }));
    expect(options[0].key).toBe('pr');
    expect(options[0].label).toContain('1 commit');
  });

  it('orders force-pushes before commits, both newest-first', () => {
    const options = diffRefOptions(detail({
      commits: [
        { oid: 'c1', abbreviatedOid: 'c1', messageHeadline: 'first', committedDate: '', author: null },
        { oid: 'c2', abbreviatedOid: 'c2', messageHeadline: 'second', committedDate: '', author: null },
      ],
      forcePushes: [
        { id: 'f1', createdAt: '', actor: null, beforeOid: 'b1', beforeAbbrev: 'b1', afterOid: 'a1', afterAbbrev: 'a1' },
        { id: 'f2', createdAt: '', actor: null, beforeOid: 'b2', beforeAbbrev: 'b2', afterOid: 'a2', afterAbbrev: 'a2' },
      ],
    }));
    expect(options.map((o) => o.key)).toEqual(['pr', 'fp-f2', 'fp-f1', 'c-c2', 'c-c1']);
  });

  it('lists a force-push with no before-commit but makes it unselectable', () => {
    // Hiding it would hide that history was rewritten; offering it would
    // offer a click that 404s.
    const options = diffRefOptions(detail({
      forcePushes: [
        { id: 'f1', createdAt: '', actor: null, beforeOid: null, beforeAbbrev: null, afterOid: 'a1', afterAbbrev: 'a1' },
      ],
    }));
    expect(options[1].ref).toBeNull();
    expect(options[1].label).toContain('no longer available');
  });

  it('still offers the full PR diff with no detail loaded', () => {
    expect(diffRefOptions(null)).toHaveLength(1);
  });
});

describe('threadsForFile', () => {
  it('keeps live, anchored threads on the shown file only', () => {
    const threads = [
      thread({ id: 'keep', path: 'a.ts' }),
      thread({ id: 'other-file', path: 'b.ts' }),
      thread({ id: 'outdated', path: 'a.ts', isOutdated: true }),
      // An unanchored thread has no line to render against.
      thread({ id: 'unanchored', path: 'a.ts', line: null }),
    ];
    expect(threadsForFile(threads, 'a.ts').map((t) => t.id)).toEqual(['keep']);
  });

  it('returns nothing when no file is selected', () => {
    expect(threadsForFile([thread()], null)).toEqual([]);
  });
});

describe('list refresh', () => {
  const lists = {
    created: { items: [], more: 0, moreIsApproximate: false },
    reviewing: { items: [], more: 0, moreIsApproximate: false },
    listening: { items: [], more: 0, moreIsApproximate: false },
  };

  let dad: Record<string, unknown>;

  beforeEach(() => {
    useGitHubStore.setState({ listsLoadedAt: null, listsLoading: false, listsError: null });
    dad = {};
    // Same stubbing convention as restStore.test.ts — there is no jsdom
    // environment configured for this project.
    vi.stubGlobal('window', { dad });
  });

  it('skips a refresh while the data is fresh', () => {
    const spy = vi.fn();
    dad.githubListPullRequests = spy;
    useGitHubStore.setState({ listsLoadedAt: Date.now() });
    useGitHubStore.getState().maybeRefreshLists();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes once the data is stale', async () => {
    const spy = vi.fn().mockResolvedValue(lists);
    dad.githubListPullRequests = spy;
    useGitHubStore.setState({ listsLoadedAt: Date.now() - STALE_MS - 1 });
    useGitHubStore.getState().maybeRefreshLists();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not stack requests during a focus storm', async () => {
    // Attach, resize and focus can all fire together; without the in-flight
    // guard each would issue its own set of three searches.
    let resolve: (v: unknown) => void = () => undefined;
    const spy = vi.fn(() => new Promise((r) => { resolve = r; }));
    dad.githubListPullRequests = spy;

    const first = useGitHubStore.getState().refreshLists();
    useGitHubStore.getState().maybeRefreshLists();
    useGitHubStore.getState().maybeRefreshLists();
    expect(spy).toHaveBeenCalledTimes(1);

    resolve(lists);
    await first;
  });

  it('surfaces a failure without clearing the last good lists', async () => {
    dad.githubListPullRequests = vi.fn().mockRejectedValue(new Error('rate limited'));
    const previous = useGitHubStore.getState().lists;
    await useGitHubStore.getState().refreshLists(true);
    expect(useGitHubStore.getState().listsError).toBe('rate limited');
    expect(useGitHubStore.getState().lists).toBe(previous);
  });

  it('invalidateLists forces the next staleness check to refetch', () => {
    useGitHubStore.setState({ listsLoadedAt: Date.now() });
    useGitHubStore.getState().invalidateLists();
    expect(useGitHubStore.getState().listsLoadedAt).toBeNull();
  });
});

describe('out-of-order responses', () => {
  let dad: Record<string, unknown>;

  beforeEach(() => {
    dad = {};
    vi.stubGlobal('window', { dad });
    useGitHubStore.setState({ selection: null, detail: null, detailLoading: false, detailError: null });
  });

  it('discards a detail response for a pull request that is no longer selected', async () => {
    // A → B where A answers last must not leave `selection` on B and `detail`
    // on A: the header's MERGE and CLOSE would then act on the wrong PR.
    const a = { owner: 'o', repo: 'r', number: 1 };
    const b = { owner: 'o', repo: 'r', number: 2 };

    const resolvers: Record<number, (v: unknown) => void> = {};
    dad.githubGetPullRequest = vi.fn((ref: typeof a) =>
      new Promise((resolve) => { resolvers[ref.number] = resolve; }));

    useGitHubStore.setState({ selection: a });
    const firstLoad = useGitHubStore.getState().reloadDetail();

    useGitHubStore.setState({ selection: b });
    const secondLoad = useGitHubStore.getState().reloadDetail();

    resolvers[2](detail({ historyTruncated: false, summary: { number: 2 } as PrDetail['summary'] }));
    await secondLoad;
    resolvers[1](detail({ historyTruncated: true, summary: { number: 1 } as PrDetail['summary'] }));
    await firstLoad;

    expect(useGitHubStore.getState().detail?.summary.number).toBe(2);
  });
});

describe('store patches', () => {
  beforeEach(() => {
    useGitHubStore.setState({ detail: detail({ threads: [thread({ id: 't1' })] }) });
  });

  it('patches a thread without touching the others', () => {
    useGitHubStore.setState({
      detail: detail({ threads: [thread({ id: 't1' }), thread({ id: 't2' })] }),
    });
    useGitHubStore.getState().patchThread('t1', { isResolved: true });
    const threads = useGitHubStore.getState().detail!.threads;
    expect(threads.find((t) => t.id === 't1')!.isResolved).toBe(true);
    expect(threads.find((t) => t.id === 't2')!.isResolved).toBe(false);
  });

  it('does not add a thread twice', () => {
    // The mutation returns the thread it created; a retry must not duplicate
    // it in the diff.
    useGitHubStore.getState().addThread(thread({ id: 't1' }));
    expect(useGitHubStore.getState().detail!.threads).toHaveLength(1);
  });

  it('does not append the same reply twice', () => {
    const comment = {
      id: 'c1', databaseId: null, body: 'hi', createdAt: '', author: 'ada',
      viewerDidAuthor: true, outdated: false, state: '', viewerCanDelete: true,
    };
    useGitHubStore.getState().appendThreadComment('t1', comment);
    useGitHubStore.getState().appendThreadComment('t1', comment);
    expect(useGitHubStore.getState().detail!.threads[0].comments).toHaveLength(1);
  });
});

describe('composer drafts', () => {
  beforeEach(() => {
    useGitHubStore.setState({ drafts: {}, selection: null, detail: null });
  });

  it('keeps unsent text so a subtab switch does not lose it', () => {
    useGitHubStore.getState().setDraft('overview:PR_1', 'half-written thought');
    expect(useGitHubStore.getState().drafts['overview:PR_1']).toBe('half-written thought');
  });

  it('removes the entry when the text is emptied, rather than storing ""', () => {
    // Otherwise the map grows once per composer ever opened.
    useGitHubStore.getState().setDraft('overview:PR_1', 'x');
    useGitHubStore.getState().setDraft('overview:PR_1', '');
    expect('overview:PR_1' in useGitHubStore.getState().drafts).toBe(false);
  });

  it('keeps drafts for different composers apart', () => {
    useGitHubStore.getState().setDraft('overview:PR_1', 'a');
    useGitHubStore.getState().setDraft('reply:thread-1', 'b');
    expect(useGitHubStore.getState().drafts).toEqual({
      'overview:PR_1': 'a',
      'reply:thread-1': 'b',
    });
  });

  it('drops every draft when a different pull request is opened', () => {
    // A draft belongs to the pull request it was written against; carrying it
    // to the next one would put the wrong words in the wrong review.
    useGitHubStore.setState({ drafts: { 'overview:PR_1': 'a' } });
    useGitHubStore.getState().select({ owner: 'o', repo: 'r', number: 9 });
    expect(useGitHubStore.getState().drafts).toEqual({});
  });
});

describe('diff comment selections', () => {
  beforeEach(() => {
    useGitHubStore.setState({ diffSelections: {}, drafts: {}, diffRef: { kind: 'pr' } });
  });

  it('keeps the selection a draft hangs off, per file', () => {
    // Without this the restored draft has nothing to render into: the
    // composer only exists while a line selection does.
    useGitHubStore.getState().setDiffSelection('src/a.ts', { hunkIndex: 0, from: 2, to: 4 });
    useGitHubStore.getState().setDiffSelection('src/b.ts', { hunkIndex: 1, from: 7, to: 7 });
    expect(useGitHubStore.getState().diffSelections['src/a.ts']).toEqual({ hunkIndex: 0, from: 2, to: 4 });
    expect(useGitHubStore.getState().diffSelections['src/b.ts']).toEqual({ hunkIndex: 1, from: 7, to: 7 });
  });

  it('removes the entry when cleared', () => {
    useGitHubStore.getState().setDiffSelection('src/a.ts', { hunkIndex: 0, from: 1, to: 1 });
    useGitHubStore.getState().setDiffSelection('src/a.ts', null);
    expect('src/a.ts' in useGitHubStore.getState().diffSelections).toBe(false);
  });

  it('drops selections when the diff ref changes', () => {
    // Hunk and line indices only mean something against the diff they were
    // taken from.
    useGitHubStore.setState({ diffSelections: { 'src/a.ts': { hunkIndex: 0, from: 1, to: 1 } } });
    useGitHubStore.getState().setDiffRef({ kind: 'commit', oid: 'abc', abbreviatedOid: 'abc' });
    expect(useGitHubStore.getState().diffSelections).toEqual({});
  });
});

describe('commentCountsByFile', () => {
  const t = (over: Partial<PrReviewThread>): PrReviewThread => thread(over);

  it('sums comments per file', () => {
    const counts = commentCountsByFile([
      t({ id: '1', path: 'a.ts', comments: [{}, {}] as PrReviewThread['comments'] }),
      t({ id: '2', path: 'a.ts', comments: [{}] as PrReviewThread['comments'] }),
      t({ id: '3', path: 'b.ts', comments: [{}] as PrReviewThread['comments'] }),
    ]);
    expect(counts).toEqual({ 'a.ts': 3, 'b.ts': 1 });
  });

  it('counts only what the diff will actually show', () => {
    // An outdated or unanchored thread has no line to render against, so
    // counting it would promise discussion the file then fails to display.
    const counts = commentCountsByFile([
      t({ id: '1', path: 'a.ts', comments: [{}] as PrReviewThread['comments'] }),
      t({ id: '2', path: 'a.ts', isOutdated: true, comments: [{}] as PrReviewThread['comments'] }),
      t({ id: '3', path: 'a.ts', line: null, comments: [{}] as PrReviewThread['comments'] }),
    ]);
    expect(counts).toEqual({ 'a.ts': 1 });
  });

  it('omits files with nothing to show, rather than storing zero', () => {
    const counts = commentCountsByFile([
      t({ id: '1', path: 'a.ts', isOutdated: true, comments: [{}] as PrReviewThread['comments'] }),
    ]);
    expect(counts).toEqual({});
  });

  it('agrees with threadsForFile about what is visible', () => {
    const threads = [
      t({ id: '1', path: 'a.ts', comments: [{}, {}] as PrReviewThread['comments'] }),
      t({ id: '2', path: 'a.ts', isOutdated: true, comments: [{}] as PrReviewThread['comments'] }),
    ];
    const visible = threadsForFile(threads, 'a.ts');
    const counted = commentCountsByFile(threads)['a.ts'];
    expect(counted).toBe(visible.reduce((n, th) => n + th.comments.length, 0));
  });
});

describe('removeComment', () => {
  it('drops a deleted comment from its thread', () => {
    useGitHubStore.setState({
      detail: detail({
        threads: [thread({
          id: 't1',
          comments: [
            { id: 'c1', databaseId: null, body: 'a', createdAt: '', author: 'ada', viewerDidAuthor: true, outdated: false, state: '', viewerCanDelete: true },
            { id: 'c2', databaseId: null, body: 'b', createdAt: '', author: 'bob', viewerDidAuthor: false, outdated: false, state: '', viewerCanDelete: false },
          ],
        })],
      }),
    });
    useGitHubStore.getState().removeComment('c1');
    expect(useGitHubStore.getState().detail!.threads[0].comments.map((c) => c.id)).toEqual(['c2']);
  });

  it('removes a thread left with no comments', () => {
    // GitHub does the same: an empty thread has nothing to show or resolve.
    useGitHubStore.setState({
      detail: detail({
        threads: [thread({
          id: 't1',
          comments: [
            { id: 'c1', databaseId: null, body: 'a', createdAt: '', author: 'ada', viewerDidAuthor: true, outdated: false, state: '', viewerCanDelete: true },
          ],
        })],
      }),
    });
    useGitHubStore.getState().removeComment('c1');
    expect(useGitHubStore.getState().detail!.threads).toHaveLength(0);
  });

  it('drops the comment from the timeline as well as from reviews', () => {
    // A review comment is rendered twice — inline on the diff and under its
    // review in the Overview — so both copies must go.
    useGitHubStore.setState({
      detail: detail({
        timeline: [
          { kind: 'comment', id: 'ic1', at: '', author: 'ada', body: 'x', viewerDidAuthor: true, viewerCanDelete: true },
          {
            kind: 'review', id: 'r1', at: '', author: 'bob', state: 'COMMENTED', body: '',
            comments: [{ id: 'rc1', path: 'a.ts', line: 1, body: 'y', viewerCanDelete: true }],
            moreComments: 0,
          },
        ],
      }),
    });
    useGitHubStore.getState().removeComment('ic1');
    useGitHubStore.getState().removeComment('rc1');
    const rows = useGitHubStore.getState().detail!.timeline;
    expect(rows.some((r) => r.kind === 'comment')).toBe(false);
    expect((rows[0] as Extract<typeof rows[number], { kind: 'review' }>).comments).toHaveLength(0);
  });
});

describe('syncListRow', () => {
  const row = (id: string): PrListItem => ({
    id,
    number: 1,
    title: 'old title',
    url: '',
    owner: 'o',
    repo: 'r',
    nameWithOwner: 'o/r',
    isDraft: true,
    mergeable: 'UNKNOWN',
    mergeState: 'UNKNOWN',
    checks: 'PENDING',
    updatedAt: '',
    reviewers: [],
  });

  const summaryFor = (id: string): PrSummary => ({
    ...({} as PrSummary),
    id,
    title: 'new title',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    checks: 'SUCCESS',
    updatedAt: '2026-09-22T00:00:00Z',
    reviewers: [{ name: 'ada', requestKey: 'ada', isTeam: false, isBot: false, state: 'APPROVED', requested: false }],
  });

  beforeEach(() => {
    useGitHubStore.setState({
      lists: {
        created: { items: [row('PR_1')], more: 0, moreIsApproximate: false },
        reviewing: { items: [], more: 0, moreIsApproximate: false },
        listening: { items: [], more: 0, moreIsApproximate: false },
      },
    });
  });

  it('mirrors the fields the list renders onto the matching row', () => {
    useGitHubStore.getState().syncListRow(summaryFor('PR_1'));
    const item = useGitHubStore.getState().lists.created.items[0];
    expect(item).toMatchObject({
      title: 'new title', isDraft: false, mergeable: 'MERGEABLE', checks: 'SUCCESS',
    });
    expect(item.reviewers.map((r) => r.state)).toEqual(['APPROVED']);
  });

  it('leaves identity fields alone', () => {
    useGitHubStore.getState().syncListRow(summaryFor('PR_1'));
    expect(useGitHubStore.getState().lists.created.items[0]).toMatchObject({
      id: 'PR_1', owner: 'o', repo: 'r', nameWithOwner: 'o/r', number: 1,
    });
  });

  it('does not invent a row for a pull request the lists do not hold', () => {
    // Which list it belongs in is a question only the search can answer.
    const before = useGitHubStore.getState().lists;
    useGitHubStore.getState().syncListRow(summaryFor('PR_UNKNOWN'));
    expect(useGitHubStore.getState().lists).toBe(before);
  });
});
