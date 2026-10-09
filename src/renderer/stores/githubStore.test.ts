import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  STALE_MS, diffRefKey, diffRefOptions, formatRef, isFileViewed, nextSelectedPath,
  commentCountsByFile, parseOtherEntries, parseRef, pickWorkspace, reconcileOther, sameRef,
  threadsForFile, useGitHubStore,
} from './githubStore';
import {
  PrCandidate, PrDetail, PrDiffFile, PrDiffRef, PrListItem, PrLists, PrReviewThread, PrSummary,
  WorkspaceGroup,
} from '../../main/types';

function file(path: string, viewed = false): PrDiffFile {
  return {
    path, previousPath: null, status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@', viewed,
  };
}

function thread(over: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: 't1', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: true,
    viewerCanReply: true, path: 'a.ts', line: 3, startLine: null, side: 'RIGHT', subjectType: 'LINE', comments: [],
    ...over,
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

  it('offers a dismissal commit the pull request no longer lists', () => {
    // A rebase leaves the dismissal pointing at a pre-rebase commit that the
    // repository still serves. Without an entry the Overview's hash would
    // open that diff while the dropdown still read "Full diff".
    const options = diffRefOptions(detail({
      commits: [{ oid: 'c1', abbreviatedOid: 'c1', messageHeadline: 'kept', committedDate: '', author: null }],
      timeline: [{
        kind: 'dismissal', id: 'd1', at: '', actor: 'RULU_NYK', reviewer: 'Y68D_NYK', message: null,
        commit: { oid: 'old1', abbreviatedOid: 'old1', messageHeadline: 'rebased away', committedDate: '', author: null },
      }],
    }));
    expect(options.map((o) => o.key)).toEqual(['pr', 'c-c1', 'c-old1']);
    expect(options[2].label).toContain('dismissed a review');
  });

  it('does not duplicate a dismissal commit that is already listed', () => {
    const commit = { oid: 'c1', abbreviatedOid: 'c1', messageHeadline: 'one', committedDate: '', author: null };
    const options = diffRefOptions(detail({
      commits: [commit],
      timeline: [{
        kind: 'dismissal', id: 'd1', at: '', actor: null, reviewer: null, message: null, commit,
      }],
    }));
    expect(options.map((o) => o.key)).toEqual(['pr', 'c-c1']);
  });

  it('ignores a manual dismissal, which names no commit', () => {
    const options = diffRefOptions(detail({
      timeline: [{
        kind: 'dismissal', id: 'd1', at: '', actor: null, reviewer: 'Y68D_NYK',
        message: 'resolved conflicts', commit: null,
      }],
    }));
    expect(options.map((o) => o.key)).toEqual(['pr']);
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

  it('keeps a live file-level thread, which has no line by design', () => {
    // Given
    const threads = [
      thread({ id: 'file', path: 'a.ts', line: null, subjectType: 'FILE' }),
      thread({ id: 'outdated-file', path: 'a.ts', line: null, subjectType: 'FILE', isOutdated: true }),
    ];

    // When
    const visible = threadsForFile(threads, 'a.ts');

    // Then
    expect(visible.map((t) => t.id)).toEqual(['file']);
  });
});

describe('list refresh', () => {
  const lists = {
    created: { items: [], more: 0, moreIsApproximate: false },
    reviewing: { items: [], more: 0, moreIsApproximate: false },
    other: { items: [], more: 0, moreIsApproximate: false },
  };

  let dad: Record<string, unknown>;

  beforeEach(() => {
    useGitHubStore.setState({
      listsLoadedAt: null, listsLoading: false, listsError: null,
      // `maybePollTick` also refreshes the open pull request; these tests are
      // about the lists, so leave nothing selected.
      selection: null, detail: null, detailLoadedAt: null, busy: false,
    });
    dad = {};
    // Same stubbing convention as restStore.test.ts — there is no jsdom
    // environment configured for this project.
    vi.stubGlobal('window', { dad });
  });

  it('skips a refresh while the data is fresh', () => {
    const spy = vi.fn();
    dad.githubListPullRequests = spy;
    useGitHubStore.setState({ listsLoadedAt: Date.now() });
    useGitHubStore.getState().maybePollTick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes once the data is stale', async () => {
    const spy = vi.fn().mockResolvedValue(lists);
    dad.githubListPullRequests = spy;
    useGitHubStore.setState({ listsLoadedAt: Date.now() - STALE_MS - 1 });
    useGitHubStore.getState().maybePollTick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not stack requests during a focus storm', async () => {
    // Attach, resize and focus can all fire together; without the in-flight
    // guard each would issue its own set of three searches.
    let resolve: (v: unknown) => void = () => undefined;
    const spy = vi.fn(() => new Promise((r) => { resolve = r; }));
    dad.githubListPullRequests = spy;

    const first = useGitHubStore.getState().refreshLists();
    useGitHubStore.getState().maybePollTick();
    useGitHubStore.getState().maybePollTick();
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

describe('background refresh', () => {
  const lists = {
    created: { items: [], more: 0, moreIsApproximate: false },
    reviewing: { items: [], more: 0, moreIsApproximate: false },
    other: { items: [], more: 0, moreIsApproximate: false },
  };

  function summary(over: Partial<PrSummary> = {}): PrSummary {
    return { id: 'PR1', headRefOid: 'oid-1', changedFiles: 1, ...over } as PrSummary;
  }

  let dad: Record<string, unknown>;

  beforeEach(() => {
    dad = {};
    vi.stubGlobal('window', { dad });
    useGitHubStore.setState({
      lists, listsLoading: false, listsError: null, listsLoadedAt: Date.now() - STALE_MS - 1,
      selection: { owner: 'o', repo: 'r', number: 1 },
      detail: detail({ summary: summary() }),
      detailLoading: false, detailError: null, detailLoadedAt: Date.now() - STALE_MS - 1,
      diff: null, diffLoading: false, diffError: null, diffNotice: null,
      diffRef: { kind: 'pr' }, selectedPath: null,
      drafts: {}, diffSelections: {}, busy: false,
    });
  });

  it('raises no spinner and records when the lists last loaded', async () => {
    dad.githubListPullRequests = vi.fn().mockResolvedValue(lists);
    const before = Date.now();
    await useGitHubStore.getState().refreshLists(false, true);

    expect(useGitHubStore.getState().listsLoading).toBe(false);
    expect(useGitHubStore.getState().listsLoadedAt).toBeGreaterThanOrEqual(before);
  });

  it('swallows a background list failure and keeps the last good data', async () => {
    // A transient blip once every five minutes must not replace what the user
    // is reading with an error banner.
    dad.githubListPullRequests = vi.fn().mockRejectedValue(new Error('rate limited'));
    const previous = useGitHubStore.getState().lists;

    await useGitHubStore.getState().refreshLists(false, true);

    expect(useGitHubStore.getState().listsError).toBeNull();
    expect(useGitHubStore.getState().lists).toBe(previous);
  });

  it('swallows a background detail failure without disturbing the viewer', async () => {
    dad.githubGetPullRequest = vi.fn().mockRejectedValue(new Error('offline'));
    const previous = useGitHubStore.getState().detail;

    await useGitHubStore.getState().reloadDetail(true);

    expect(useGitHubStore.getState().detailError).toBeNull();
    expect(useGitHubStore.getState().detailLoading).toBe(false);
    expect(useGitHubStore.getState().detail).toBe(previous);
  });

  it('skips a tick entirely while a mutation is in flight', () => {
    // A response taken before the mutation landed would undo its optimistic
    // patch, e.g. showing a just-approved pull request as unapproved.
    const listSpy = vi.fn().mockResolvedValue(lists);
    const detailSpy = vi.fn();
    dad.githubListPullRequests = listSpy;
    dad.githubGetPullRequest = detailSpy;
    useGitHubStore.setState({ busy: true });

    useGitHubStore.getState().pollTick();
    useGitHubStore.getState().maybePollTick();

    expect(listSpy).not.toHaveBeenCalled();
    expect(detailSpy).not.toHaveBeenCalled();
  });

  it('polls on the interval regardless of how fresh the data is', () => {
    // The gate is the same 5 minutes as the interval, and `loadedAt` is
    // stamped when the response lands — so a gated interval would skip every
    // tick and silently halve the real polling rate.
    const listSpy = vi.fn().mockResolvedValue(lists);
    dad.githubListPullRequests = listSpy;
    dad.githubGetPullRequest = vi.fn(() => new Promise(() => undefined));
    useGitHubStore.setState({ listsLoadedAt: Date.now(), detailLoadedAt: Date.now() });

    useGitHubStore.getState().pollTick();

    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('gates lists and detail separately on activation', () => {
    // Pressing REFRESH on the lists and switching tabs must not drag the
    // detail along with it, nor refetch the lists that were just fetched.
    const listSpy = vi.fn().mockResolvedValue(lists);
    const detailSpy = vi.fn(() => new Promise(() => undefined));
    dad.githubListPullRequests = listSpy;
    dad.githubGetPullRequest = detailSpy;
    useGitHubStore.setState({ listsLoadedAt: Date.now(), detailLoadedAt: Date.now() - STALE_MS - 1 });

    useGitHubStore.getState().maybePollTick();

    expect(listSpy).not.toHaveBeenCalled();
    expect(detailSpy).toHaveBeenCalledTimes(1);
  });

  it('loads in the foreground while there is nothing on screen to keep', () => {
    // The very first load still shows LOADING… — silence is only right once
    // there is already data the refresh is replacing.
    dad.githubListPullRequests = vi.fn(() => new Promise(() => undefined));
    useGitHubStore.setState({ listsLoadedAt: null, selection: null });

    useGitHubStore.getState().maybePollTick();

    expect(useGitHubStore.getState().listsLoading).toBe(true);
  });

  it('refetches the diff on a background pass only when the head moved', async () => {
    const diffSpy = vi.fn().mockResolvedValue({ files: [], truncated: false });
    dad.githubGetDiff = diffSpy;
    dad.githubGetPullRequest = vi.fn().mockResolvedValue(detail({ summary: summary() }));

    await useGitHubStore.getState().reloadDetail(true);
    expect(diffSpy).not.toHaveBeenCalled();

    dad.githubGetPullRequest = vi.fn().mockResolvedValue(
      detail({ summary: summary({ headRefOid: 'oid-2' }) })
    );
    await useGitHubStore.getState().reloadDetail(true);
    expect(diffSpy).toHaveBeenCalledTimes(1);
  });

  it('never refetches a commit-scoped diff, whose content cannot change', async () => {
    const diffSpy = vi.fn().mockResolvedValue({ files: [], truncated: false });
    dad.githubGetDiff = diffSpy;
    dad.githubGetPullRequest = vi.fn().mockResolvedValue(
      detail({ summary: summary({ headRefOid: 'oid-2' }) })
    );
    useGitHubStore.setState({ diffRef: { kind: 'commit', oid: 'abc' } as PrDiffRef });

    await useGitHubStore.getState().reloadDetail(true);

    expect(diffSpy).not.toHaveBeenCalled();
  });

  it('leaves draft comments alone across a background reload', async () => {
    // Requirement 4. Drafts are cleared by `select()` — changing pull request
    // — and must survive any number of refreshes of the same one.
    const drafts = { 'overview:PR1': 'half a thought', 'diff:a.ts:RIGHT:3:3': 'nit' };
    const diffSelections = { 'a.ts': { hunkIndex: 0, from: 3, to: 3, side: null } };
    useGitHubStore.setState({ drafts, diffSelections });
    dad.githubGetPullRequest = vi.fn().mockResolvedValue(detail({ summary: summary() }));

    await useGitHubStore.getState().reloadDetail(true);

    expect(useGitHubStore.getState().drafts).toEqual(drafts);
    expect(useGitHubStore.getState().diffSelections).toEqual(diffSelections);
  });

  it('discards a response taken before a mutation patched the same detail', async () => {
    // `busy` cannot catch this: the read started while it was still false.
    // Committing the stale snapshot would undo the optimistic patch and make
    // a just-posted review comment vanish until the next poll.
    let resolve: (v: unknown) => void = () => undefined;
    dad.githubGetPullRequest = vi.fn(() => new Promise((r) => { resolve = r; }));

    const inFlight = useGitHubStore.getState().reloadDetail(true);

    await useGitHubStore.getState().run(async () => 'done');
    useGitHubStore.getState().addThread(thread({ id: 'optimistic' }));

    resolve(detail({ summary: summary(), threads: [] }));
    await inFlight;

    expect(useGitHubStore.getState().detail?.threads.map((t) => t.id)).toEqual(['optimistic']);
  });

  it('never supersedes a foreground reload, which owns the loading flag', async () => {
    // The generation guard would discard the foreground response before it
    // could clear `detailLoading`, disabling the refresh button permanently.
    dad.githubGetPullRequest = vi.fn(() => new Promise(() => undefined));
    void useGitHubStore.getState().reloadDetail();
    expect(useGitHubStore.getState().detailLoading).toBe(true);

    const callsBefore = (dad.githubGetPullRequest as ReturnType<typeof vi.fn>).mock.calls.length;
    useGitHubStore.getState().pollTick();
    useGitHubStore.getState().maybePollTick();

    expect((dad.githubGetPullRequest as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBe(callsBefore);
  });
});

describe('a file that leaves the diff', () => {
  let dad: Record<string, unknown>;

  beforeEach(() => {
    dad = {};
    vi.stubGlobal('window', { dad });
    useGitHubStore.setState({
      selection: { owner: 'o', repo: 'r', number: 1 },
      detail: detail({ summary: { id: 'PR1', changedFiles: 2 } as PrSummary }),
      diffRef: { kind: 'pr' }, selectedPath: 'gone.ts', diffNotice: null,
      drafts: { 'diff:gone.ts:RIGHT:3:3': 'unsent', 'diff:kept.ts:RIGHT:1:1': 'safe' },
      diffSelections: { 'gone.ts': { hunkIndex: 0, from: 3, to: 3, side: null } },
    });
    dad.githubGetPullRequest = vi.fn().mockResolvedValue(
      detail({ summary: { id: 'PR1', changedFiles: 2 } as PrSummary })
    );
    // The refreshed diff has dropped `gone.ts`, as a force push would.
    dad.githubGetDiff = vi.fn().mockResolvedValue({ files: [file('kept.ts')], truncated: false });
  });

  it('discards only that file\'s draft and explains why', async () => {
    await useGitHubStore.getState().reloadDetail();

    // `reloadDetail` starts the diff load without awaiting it, so that the
    // detail can render before the much larger diff arrives.
    await vi.waitFor(() => expect(useGitHubStore.getState().selectedPath).toBe('kept.ts'));

    const state = useGitHubStore.getState();
    expect(state.drafts['diff:gone.ts:RIGHT:3:3']).toBeUndefined();
    expect(state.drafts['diff:kept.ts:RIGHT:1:1']).toBe('safe');
    expect(state.diffSelections['gone.ts']).toBeUndefined();
    expect(state.diffNotice).toContain('gone.ts');
  });

  it('says nothing when there was no unsent work to lose', async () => {
    // The user was merely looking at the file, or had an empty composer open.
    // Interrupting them to report that nothing was lost is just noise.
    useGitHubStore.setState({
      drafts: { 'diff:gone.ts:RIGHT:3:3': '' },
      diffSelections: { 'gone.ts': { hunkIndex: 0, from: 3, to: 3, side: null } },
    });

    await useGitHubStore.getState().reloadDetail();
    await vi.waitFor(() => expect(useGitHubStore.getState().selectedPath).toBe('kept.ts'));

    expect(useGitHubStore.getState().diffNotice).toBeNull();
    // The stale selection is still cleaned up, quietly.
    expect(useGitHubStore.getState().diffSelections['gone.ts']).toBeUndefined();
  });

  it('catches text the composer was still holding when the file vanished', async () => {
    // The composer keeps its body in local state and only hands it over when
    // it unmounts — which is what changing the selected file does. Without
    // this the text would be filed back under a path that no longer exists,
    // silently and with no notice.
    useGitHubStore.setState({ drafts: {}, diffSelections: {} });

    await useGitHubStore.getState().reloadDetail();
    await vi.waitFor(() => expect(useGitHubStore.getState().selectedPath).toBe('kept.ts'));

    // Stands in for CommentComposer's unmount cleanup.
    useGitHubStore.getState().setDraft('diff:gone.ts:RIGHT:3:3', 'typed but never sent');

    expect(useGitHubStore.getState().drafts['diff:gone.ts:RIGHT:3:3']).toBeUndefined();
    expect(useGitHubStore.getState().diffNotice).toContain('gone.ts');
  });

  it('still accepts drafts for files that are in the diff', () => {
    useGitHubStore.setState({
      diff: { files: [file('kept.ts')], truncated: false } as never,
      drafts: {}, diffNotice: null,
    });

    useGitHubStore.getState().setDraft('diff:kept.ts:RIGHT:1:1', 'fine');
    useGitHubStore.getState().setDraft('overview:PR1', 'also fine');

    expect(useGitHubStore.getState().drafts['diff:kept.ts:RIGHT:1:1']).toBe('fine');
    expect(useGitHubStore.getState().drafts['overview:PR1']).toBe('also fine');
    expect(useGitHubStore.getState().diffNotice).toBeNull();
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
    useGitHubStore.getState().setDiffSelection('src/a.ts', { hunkIndex: 0, from: 2, to: 4, side: null });
    useGitHubStore.getState().setDiffSelection('src/b.ts', { hunkIndex: 1, from: 7, to: 7, side: null });
    expect(useGitHubStore.getState().diffSelections['src/a.ts']).toEqual({ hunkIndex: 0, from: 2, to: 4, side: null });
    expect(useGitHubStore.getState().diffSelections['src/b.ts']).toEqual({ hunkIndex: 1, from: 7, to: 7, side: null });
  });

  it('removes the entry when cleared', () => {
    useGitHubStore.getState().setDiffSelection('src/a.ts', { hunkIndex: 0, from: 1, to: 1, side: null });
    useGitHubStore.getState().setDiffSelection('src/a.ts', null);
    expect('src/a.ts' in useGitHubStore.getState().diffSelections).toBe(false);
  });

  it('drops selections when the diff ref changes', () => {
    // Hunk and line indices only mean something against the diff they were
    // taken from.
    useGitHubStore.setState({ diffSelections: { 'src/a.ts': { hunkIndex: 0, from: 1, to: 1, side: null } } });
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

  it('counts file-level comments, which the file header shows', () => {
    // Given
    const threads = [
      t({ id: '1', path: 'a.ts', line: null, subjectType: 'FILE', comments: [{}] as PrReviewThread['comments'] }),
    ];

    // When
    const counts = commentCountsByFile(threads);

    // Then
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
    baseRefName: 'main',
    headRefName: 'feature/old',
    state: 'OPEN',
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
    baseRefName: 'develop',
    headRefName: 'feature/new',
    reviewers: [{ name: 'ada', requestKey: 'ada', isTeam: false, isBot: false, state: 'APPROVED', requested: false }],
  });

  beforeEach(() => {
    useGitHubStore.setState({
      lists: {
        created: { items: [row('PR_1')], more: 0, moreIsApproximate: false },
        reviewing: { items: [], more: 0, moreIsApproximate: false },
        other: { items: [], more: 0, moreIsApproximate: false },
      },
    });
  });

  it('mirrors the fields the list renders onto the matching row', () => {
    useGitHubStore.getState().syncListRow(summaryFor('PR_1'));
    const item = useGitHubStore.getState().lists.created.items[0];
    expect(item).toMatchObject({
      title: 'new title', isDraft: false, mergeable: 'MERGEABLE', checks: 'SUCCESS',
      baseRefName: 'develop', headRefName: 'feature/new',
    });
    expect(item.reviewers.map((r) => r.state)).toEqual(['APPROVED']);
  });

  it('leaves identity fields alone', () => {
    useGitHubStore.getState().syncListRow(summaryFor('PR_1'));
    expect(useGitHubStore.getState().lists.created.items[0]).toMatchObject({
      id: 'PR_1', owner: 'o', repo: 'r', nameWithOwner: 'o/r', number: 1,
    });
  });

  it('mirrors the state onto an OTHER row too', () => {
    // Given
    useGitHubStore.setState({
      lists: {
        created: { items: [], more: 0, moreIsApproximate: false },
        reviewing: { items: [], more: 0, moreIsApproximate: false },
        other: { items: [row('PR_2')], more: 0, moreIsApproximate: false },
      },
    });

    // When
    useGitHubStore.getState().syncListRow({ ...summaryFor('PR_2'), state: 'MERGED' });

    // Then
    expect(useGitHubStore.getState().lists.other.items[0]).toMatchObject({ state: 'MERGED', title: 'new title' });
  });

  it('does not invent a row for a pull request the lists do not hold', () => {
    // Which list it belongs in is a question only the search can answer.
    const before = useGitHubStore.getState().lists;
    useGitHubStore.getState().syncListRow(summaryFor('PR_UNKNOWN'));
    expect(useGitHubStore.getState().lists).toBe(before);
  });
});

describe('update-branch preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useGitHubStore.setState({ updateBranchAction: 'MERGE' });
  });

  it('persists the chosen strategy', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });

    useGitHubStore.getState().setUpdateBranchAction('REBASE');

    expect(store['dad-git-update-branch-action']).toBe('REBASE');
    expect(useGitHubStore.getState().updateBranchAction).toBe('REBASE');
  });

  it('still switches strategy when storage refuses the write', () => {
    // A full quota must cost the preference, not the action the user just chose.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded'); },
    });

    expect(() => useGitHubStore.getState().setUpdateBranchAction('REBASE')).not.toThrow();
    expect(useGitHubStore.getState().updateBranchAction).toBe('REBASE');
  });

  it('falls back to MERGE for a stored value that is not a branch update method', async () => {
    // SQUASH is a real merge method but not a real *update* method, so it is
    // exactly the value a shared key or a hand-edit could leave behind.
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'dad-git-update-branch-action' ? 'SQUASH' : null),
      setItem: () => undefined,
    });
    vi.resetModules();

    const fresh = await import('./githubStore');

    expect(fresh.useGitHubStore.getState().updateBranchAction).toBe('MERGE');
  });
});

function otherRow(id: string, updatedAt = '2026-09-01T00:00:00Z'): PrListItem {
  return {
    id, number: Number(id.replace(/\D/g, '')) || 1, title: `PR ${id}`, url: '', owner: 'Nykredit',
    repo: 'rs-consent', nameWithOwner: 'Nykredit/rs-consent', baseRefName: 'develop',
    headRefName: `feature/${id}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    mergeState: 'CLEAN', checks: 'SUCCESS', updatedAt, reviewers: [],
  };
}

function entry(id: string, number = 1): { id: string; owner: string; repo: string; number: number } {
  return { id, owner: 'Nykredit', repo: 'rs-consent', number };
}

function otherCandidate(id: string, patch: Partial<PrCandidate> = {}): PrCandidate {
  return {
    id, number: 7, title: `PR ${id}`, owner: 'Nykredit', repo: 'rs-consent',
    nameWithOwner: 'Nykredit/rs-consent', headRefName: 'feature/x', baseRefName: 'develop',
    isDraft: false, state: 'OPEN', author: 'RULU_NYK', createdAt: '2026-09-01T00:00:00Z',
    closedAt: null, updatedAt: '2026-09-02T00:00:00Z', ...patch,
  };
}

function emptyListsWithOther(items: PrListItem[] = []): PrLists {
  return {
    created: { items: [], more: 0, moreIsApproximate: false },
    reviewing: { items: [], more: 0, moreIsApproximate: false },
    other: { items, more: 0, moreIsApproximate: false },
  };
}

describe('parseOtherEntries', () => {
  it('keeps valid entries in order and drops duplicates', () => {
    // Given
    const raw = JSON.stringify([entry('A', 1), entry('B', 2), entry('A', 3)]);

    // When
    const entries = parseOtherEntries(raw);

    // Then
    expect(entries).toEqual([entry('A', 1), entry('B', 2)]);
  });

  it('drops malformed entries rather than discarding the list', () => {
    // Given
    const raw = JSON.stringify([
      entry('ok'),
      { id: 'no-number', owner: 'o', repo: 'r' },
      { id: 'bad-number', owner: 'o', repo: 'r', number: 0 },
      { id: 'slash', owner: 'o/x', repo: 'r', number: 1 },
      { id: '', owner: 'o', repo: 'r', number: 1 },
      'not an object',
    ]);

    // When
    const entries = parseOtherEntries(raw);

    // Then
    expect(entries.map((e) => e.id)).toEqual(['ok']);
  });

  it('degrades to an empty list for corrupt or runaway payloads', () => {
    expect(parseOtherEntries(null)).toEqual([]);
    expect(parseOtherEntries('{not json')).toEqual([]);
    expect(parseOtherEntries('{"a":1}')).toEqual([]);
    expect(parseOtherEntries('x'.repeat(1024 * 1024 + 1))).toEqual([]);
  });
});

describe('reconcileOther', () => {
  it('uses fetched rows, newest first', () => {
    // Given
    const entries = [entry('A'), entry('B')];
    const fetched = [otherRow('A', '2026-01-01T00:00:00Z'), otherRow('B', '2026-02-01T00:00:00Z')];

    // When
    const { items, unavailable } = reconcileOther(entries, ['A', 'B'], fetched, []);

    // Then
    expect(items.map((i) => i.id)).toEqual(['B', 'A']);
    expect(unavailable).toEqual([]);
  });

  it('marks a requested entry that did not come back as unavailable', () => {
    // When
    const { items, unavailable } = reconcileOther([entry('A'), entry('GONE')], ['A', 'GONE'], [otherRow('A')], [otherRow('GONE')]);

    // Then
    expect(items.map((i) => i.id)).toEqual(['A']);
    expect(unavailable).toEqual(['GONE']);
  });

  it('keeps the provisional row of an entry added while the request was in flight', () => {
    // When
    const { items, unavailable } = reconcileOther([entry('A'), entry('NEW')], ['A'], [otherRow('A')], [otherRow('NEW')]);

    // Then
    expect(items.map((i) => i.id).sort()).toEqual(['A', 'NEW']);
    expect(unavailable).toEqual([]);
  });

  it('drops a row for an entry removed while the request was in flight', () => {
    // When
    const { items } = reconcileOther([entry('A')], ['A', 'REMOVED'], [otherRow('A'), otherRow('REMOVED')], []);

    // Then
    expect(items.map((i) => i.id)).toEqual(['A']);
  });
});

describe('pickWorkspace', () => {
  const groups: WorkspaceGroup[] = [
    { group: 'G1', workspaces: [{ key: 'DAD', repo: 'developer-automation-desktop', workingDir: '/a' }] },
    { group: 'G2', workspaces: [{ key: 'CON', repo: 'rs-consent', workingDir: '/b' }] },
  ];

  it('returns the remembered workspace while it still exists', () => {
    expect(pickWorkspace(groups, 'CON')?.repo).toBe('rs-consent');
  });

  it('falls back to the topmost workspace', () => {
    expect(pickWorkspace(groups, 'RENAMED')?.key).toBe('DAD');
    expect(pickWorkspace(groups, null)?.key).toBe('DAD');
  });

  it('returns null when no workspaces are registered', () => {
    expect(pickWorkspace([], 'DAD')).toBeNull();
  });
});

describe('OTHER section', () => {
  let store: Record<string, string>;
  let dad: Record<string, unknown>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
    dad = {};
    vi.stubGlobal('window', { dad });
    useGitHubStore.setState({
      lists: emptyListsWithOther(), otherEntries: [], otherUnavailable: [],
      listsLoading: false, listsError: null, listsLoadedAt: null,
      selection: null, detail: null, busy: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a picked pull request as a persisted entry with a provisional row', () => {
    // When
    useGitHubStore.getState().addOther(otherCandidate('PR_X'));

    // Then
    const state = useGitHubStore.getState();
    expect(state.otherEntries).toEqual([{ id: 'PR_X', owner: 'Nykredit', repo: 'rs-consent', number: 7 }]);
    expect(state.lists.other.items.map((i) => i.id)).toEqual(['PR_X']);
    expect(JSON.parse(store['dad-git-other-prs'])).toEqual(state.otherEntries);
  });

  it('upserts rather than duplicating, clearing a stale unavailable mark', () => {
    // Given
    useGitHubStore.setState({ otherEntries: [entry('PR_X', 7)], otherUnavailable: ['PR_X'] });

    // When
    useGitHubStore.getState().addOther(otherCandidate('PR_X', { repo: 'rs-consent-renamed' }));

    // Then
    const state = useGitHubStore.getState();
    expect(state.otherEntries).toHaveLength(1);
    expect(state.otherEntries[0].repo).toBe('rs-consent-renamed');
    expect(state.otherUnavailable).toEqual([]);
    expect(state.lists.other.items).toHaveLength(1);
  });

  it('removes an entry without touching a viewer showing something else', () => {
    // Given
    useGitHubStore.setState({
      otherEntries: [entry('PR_X', 7)], lists: emptyListsWithOther([otherRow('PR_X')]),
      selection: { owner: 'Nykredit', repo: 'rs-consent', number: 99 },
    });

    // When
    useGitHubStore.getState().removeOther('PR_X');

    // Then
    const state = useGitHubStore.getState();
    expect(state.otherEntries).toEqual([]);
    expect(state.lists.other.items).toEqual([]);
    expect(state.selection).toEqual({ owner: 'Nykredit', repo: 'rs-consent', number: 99 });
    expect(JSON.parse(store['dad-git-other-prs'])).toEqual([]);
  });

  it('voids the viewer when the removed pull request is open in it', () => {
    // Given
    useGitHubStore.setState({
      otherEntries: [entry('PR_X', 7)],
      selection: { owner: 'Nykredit', repo: 'rs-consent', number: 7 },
    });

    // When
    useGitHubStore.getState().removeOther('PR_X');

    // Then
    expect(useGitHubStore.getState().selection).toBeNull();
  });

  it('sends the persisted ids with a refresh and marks the ones that did not come back', async () => {
    // Given
    useGitHubStore.setState({ otherEntries: [entry('A'), entry('GONE')] });
    const spy = vi.fn().mockResolvedValue(emptyListsWithOther([otherRow('A')]));
    dad.githubListPullRequests = spy;

    // When
    await useGitHubStore.getState().refreshLists(true);

    // Then
    expect(spy).toHaveBeenCalledWith(['A', 'GONE']);
    const state = useGitHubStore.getState();
    expect(state.lists.other.items.map((i) => i.id)).toEqual(['A']);
    expect(state.otherUnavailable).toEqual(['GONE']);
  });

  it('marks nothing unavailable when the refresh fails', async () => {
    // Given
    useGitHubStore.setState({ otherEntries: [entry('A')] });
    dad.githubListPullRequests = vi.fn().mockRejectedValue(new Error('offline'));

    // When
    await useGitHubStore.getState().refreshLists(true);

    // Then
    expect(useGitHubStore.getState().otherUnavailable).toEqual([]);
    expect(useGitHubStore.getState().otherEntries).toHaveLength(1);
  });

  it('keeps a pull request added while a refresh was in flight', async () => {
    // Given
    let resolve: (v: PrLists) => void = () => undefined;
    dad.githubListPullRequests = vi.fn(() => new Promise<PrLists>((r) => { resolve = r; }));
    const pending = useGitHubStore.getState().refreshLists(true);

    // When
    useGitHubStore.getState().addOther(otherCandidate('LATE'));
    resolve(emptyListsWithOther());
    await pending;

    // Then
    const state = useGitHubStore.getState();
    expect(state.lists.other.items.map((i) => i.id)).toEqual(['LATE']);
    expect(state.otherUnavailable).toEqual([]);
  });

  it('remembers the workspace picked in the dialog', () => {
    // When
    useGitHubStore.getState().setOpenPrWorkspace('CON');

    // Then
    expect(store['dad-git-open-pr-workspace']).toBe('CON');
    expect(useGitHubStore.getState().openPrWorkspace).toBe('CON');
  });
});
