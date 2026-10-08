/**
 * Pull Requests (GIT1) renderer state.
 *
 * Modelled on `restStore.ts`: own localStorage keys with validators that
 * degrade to a default, and no persistence of anything that can go stale.
 *
 * Two rules matter more here than in the other stores:
 *
 *  1. **Every async read is generation-guarded.** `selection`, `pr`, `diffRef`
 *     and `files` are mutable, so a fast A → B → A click sequence can land
 *     responses out of order and leave `selection` pointing at B while `pr`
 *     holds A. That is not cosmetic — the header's MERGE, CLOSE and APPROVE
 *     would then act on a pull request the user is not looking at.
 *  2. **Mutation results are patched in, not refetched**, except where a patch
 *     cannot be honest (see `invalidateLists`).
 */

import { create } from 'zustand';
import {
  PrBranchUpdateMethod, PrCandidate, PrCommentAnchor, PrDetail, PrDiff, PrDiffFile, PrDiffRef,
  PrListId, PrListItem, PrLists, PrMergeMethod, PrMergeOptions, PrOtherEntry, PrRef, PrReviewEvent,
  PrReviewThread, PrSummary, PrThreadComment, PrTimelineRow, WorkspaceEntry, WorkspaceGroup,
} from '../../main/types';
import {
  candidateToListItem, emptyLists, sortByUpdatedDesc, toPrState,
} from '../../main/githubPrLists';
import { DiffSide } from '../../main/githubDiff';

const SELECTION_KEY = 'dad-git-selection';
const DIFF_MODE_KEY = 'dad-git-diff-mode';
const MERGE_ACTION_KEY = 'dad-git-merge-action';
const UPDATE_BRANCH_ACTION_KEY = 'dad-git-update-branch-action';
const OTHER_KEY = 'dad-git-other-prs';
const OPEN_PR_WORKSPACE_KEY = 'dad-git-open-pr-workspace';
/** A runaway-payload guard only: `OTHER` itself is uncapped. */
const OTHER_LIMIT = 1024 * 1024;
const REF_SEGMENT = /^[^/\s]+$/;

/**
 * The single cadence for keeping the tab current.
 *
 * Doubles as the automatic poll interval while the `PULL!` tab is active and
 * as the "has it been long enough" gate applied when the tab is activated or
 * the window regains focus. One constant rather than two, because a poll
 * interval shorter than the staleness gate would spend most ticks doing
 * nothing, and a longer one would make the gate unreachable.
 */
export const STALE_MS = 5 * 60_000;

export type PrSubtab = 'overview' | 'commits' | 'diff';

/** A pending diff comment's line range, within one hunk of one file. */
export interface DiffLineSelection {
  hunkIndex: number;
  from: number;
  to: number;
  /**
   * The split-view column the drag happened in; null in unified view, which
   * has one column covering both sides. `from`/`to` are *unified* line
   * indexes either way, so without this a right-column drag across a modified
   * block would silently include the deletions sitting between its endpoints.
   */
  side: DiffSide | null;
}

/** What the header's merge split button runs by default. */
export type MergeAction = PrMergeMethod | 'AUTO';

const MERGE_ACTIONS: MergeAction[] = ['MERGE', 'SQUASH', 'REBASE', 'AUTO'];

const UPDATE_BRANCH_ACTIONS: PrBranchUpdateMethod[] = ['MERGE', 'REBASE'];
export type DiffViewMode = 'unified' | 'split';

/** Stable key for a diff ref, used to scope locally-tracked viewed files. */
export function diffRefKey(ref: PrDiffRef): string {
  if (ref.kind === 'pr') return 'pr';
  if (ref.kind === 'commit') return `commit:${ref.oid}`;
  return `range:${ref.beforeOid}..${ref.afterOid}`;
}

export function sameRef(a: PrRef | null, b: PrRef | null): boolean {
  if (!a || !b) return a === b;
  return a.owner === b.owner && a.repo === b.repo && a.number === b.number;
}

export function formatRef(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** `owner/repo#number`, rejecting anything that is not exactly that. */
export function parseRef(raw: string | null): PrRef | null {
  if (!raw) return null;
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { owner: match[1], repo: match[2], number };
}

function loadSelection(): PrRef | null {
  try {
    return parseRef(localStorage.getItem(SELECTION_KEY));
  } catch {
    return null;
  }
}

function loadMergeAction(): MergeAction {
  try {
    const raw = localStorage.getItem(MERGE_ACTION_KEY);
    // Rebase is the initial default; an unrecognised value resolves to it
    // rather than to a merge strategy the user never chose.
    return MERGE_ACTIONS.includes(raw as MergeAction) ? (raw as MergeAction) : 'REBASE';
  } catch {
    return 'REBASE';
  }
}

function loadUpdateBranchAction(): PrBranchUpdateMethod {
  try {
    const raw = localStorage.getItem(UPDATE_BRANCH_ACTION_KEY);
    // Merge is the initial default, matching GitHub's own button; anything
    // unrecognised resolves to it rather than to a rewrite of the branch.
    return UPDATE_BRANCH_ACTIONS.includes(raw as PrBranchUpdateMethod)
      ? (raw as PrBranchUpdateMethod)
      : 'MERGE';
  } catch {
    return 'MERGE';
  }
}

/** The path a diff-comment draft key belongs to, or `null` for other drafts. */
function diffDraftPath(key: string): string | null {
  if (!key.startsWith('diff:')) return null;
  // `diff:<path>:<side>:<startLine>:<line>` — the path is everything before
  // the final three segments, so a path containing a colon still resolves.
  const parts = key.slice('diff:'.length).split(':');
  if (parts.length < 4) return null;
  return parts.slice(0, -3).join(':');
}

function vanishedFileNotice(path: string): string {
  return `${path} is no longer part of this diff — it was changed or removed by a new push. `
    + 'Your unsent comment on it could not be kept.';
}

export function parseOtherEntries(raw: string | null): PrOtherEntry[] {
  if (!raw || raw.length > OTHER_LIMIT) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const entries: PrOtherEntry[] = [];
    for (const value of parsed) {
      const entry = toOtherEntry(value);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

function toOtherEntry(value: unknown): PrOtherEntry | null {
  const v = value as Partial<PrOtherEntry> | null;
  if (!v || typeof v.id !== 'string' || v.id === '') return null;
  if (typeof v.owner !== 'string' || !REF_SEGMENT.test(v.owner)) return null;
  if (typeof v.repo !== 'string' || !REF_SEGMENT.test(v.repo)) return null;
  if (typeof v.number !== 'number' || !Number.isInteger(v.number) || v.number <= 0) return null;
  return { id: v.id, owner: v.owner, repo: v.repo, number: v.number };
}

function loadOtherEntries(): PrOtherEntry[] {
  try {
    return parseOtherEntries(localStorage.getItem(OTHER_KEY));
  } catch {
    return [];
  }
}

function saveOtherEntries(entries: PrOtherEntry[]): void {
  try {
    localStorage.setItem(OTHER_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable or full — the list still works for this session.
  }
}

function loadOpenPrWorkspace(): string | null {
  try {
    return localStorage.getItem(OPEN_PR_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/**
 * Compose `OTHER` from a list response.
 *
 * An entry the request asked for but did not get back is unavailable; one
 * added while the request was in flight keeps the row it already has, so a
 * refresh that started earlier cannot undo an add or a remove.
 */
export function reconcileOther(
  entries: PrOtherEntry[],
  requestedIds: string[],
  fetched: PrListItem[],
  previous: PrListItem[]
): { items: PrListItem[]; unavailable: string[] } {
  const fetchedById = new Map(fetched.map((item) => [item.id, item]));
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const requested = new Set(requestedIds);
  const items: PrListItem[] = [];
  const unavailable: string[] = [];

  for (const entry of entries) {
    const row = fetchedById.get(entry.id) ?? (requested.has(entry.id) ? undefined : previousById.get(entry.id));
    if (row) items.push(row);
    else if (requested.has(entry.id)) unavailable.push(entry.id);
  }

  return { items: sortByUpdatedDesc(items), unavailable };
}

/** The remembered workspace while it still exists, otherwise the topmost. */
export function pickWorkspace(groups: WorkspaceGroup[], key: string | null): WorkspaceEntry | null {
  const all = groups.flatMap((g) => g.workspaces);
  return all.find((w) => w.key === key) ?? all[0] ?? null;
}

function loadDiffMode(): DiffViewMode {
  try {
    // Unified is the default: the panel is often narrow, and split inside 18
    // columns at high zoom is unreadable.
    return localStorage.getItem(DIFF_MODE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

interface GitHubStore {
  // --- lists -------------------------------------------------------------
  lists: PrLists;
  listsLoading: boolean;
  listsLoadedAt: number | null;
  listsError: string | null;
  /** Persisted and authoritative: every entry renders, with or without a fetched row. */
  otherEntries: PrOtherEntry[];
  /** Entries a successful refresh asked for and did not get back. */
  otherUnavailable: string[];
  /** Workspace key last picked in the Open Pull Request dialog. */
  openPrWorkspace: string | null;

  // --- selection & detail ------------------------------------------------
  selection: PrRef | null;
  detail: PrDetail | null;
  detailLoading: boolean;
  detailLoadedAt: number | null;
  detailError: string | null;

  // --- viewer ------------------------------------------------------------
  subtab: PrSubtab;
  diffRef: PrDiffRef;
  diff: PrDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  selectedPath: string | null;
  viewMode: DiffViewMode;
  mergeAction: MergeAction;
  /** What the header's UPDATE BRANCH split button runs by default. */
  updateBranchAction: PrBranchUpdateMethod;
  /**
   * Viewed files for commit- and range-scoped diffs, keyed by diff ref.
   *
   * A path viewed in commit A must not appear viewed in commit B. Full-PR mode
   * is absent from this map entirely — it reads and writes GitHub's own
   * `viewerViewedState`.
   */
  localViewed: Map<string, Set<string>>;

  actionError: string | null;
  busy: boolean;

  /**
   * Explains that the selected file left the diff and that an unsent comment
   * on it was discarded.
   *
   * Separate from `actionError` despite rendering identically: that field is
   * owned by `run()`, so sharing it would let a merge failure and this notice
   * overwrite one another.
   */
  diffNotice: string | null;

  /**
   * Unsent composer text, keyed per composer.
   *
   * Deliberately **not** subscribed to by any component: composers keep their
   * own local state while typing (so a keystroke cannot re-render the diff)
   * and hand the text over here only when they unmount. Switching subtab
   * unmounts the whole body, which is exactly when the draft would otherwise
   * be lost.
   */
  drafts: Record<string, string>;

  /**
   * Which lines a diff comment is being written against, keyed by file path.
   *
   * Persisted for the same reason as `drafts`, and necessarily alongside it:
   * the composer only renders while a line selection exists, so without this
   * a restored draft would have nothing to render into. Scoped to the current
   * `diffRef` — a selection means nothing against a different commit's diff.
   */
  diffSelections: Record<string, DiffLineSelection>;

  // --- actions -----------------------------------------------------------
  refreshLists: (force?: boolean, background?: boolean) => Promise<void>;
  addOther: (candidate: PrCandidate) => void;
  removeOther: (id: string) => void;
  setOpenPrWorkspace: (key: string) => void;
  select: (ref: PrRef | null) => void;
  reloadDetail: (background?: boolean) => Promise<void>;
  /** Unconditional background pass, driven by the poll interval. */
  pollTick: () => void;
  /** Staleness-gated background pass, driven by tab activation and focus. */
  maybePollTick: () => void;
  setSubtab: (tab: PrSubtab) => void;
  setDiffRef: (ref: PrDiffRef) => void;
  openDiffFor: (ref: PrDiffRef) => void;
  openFileInDiff: (path: string) => void;
  setSelectedPath: (path: string) => void;
  setViewMode: (mode: DiffViewMode) => void;
  setMergeAction: (action: MergeAction) => void;
  setUpdateBranchAction: (action: PrBranchUpdateMethod) => void;
  toggleViewed: (path: string, viewed: boolean) => Promise<void>;
  setActionError: (message: string | null) => void;
  setDiffNotice: (message: string | null) => void;
  setDraft: (key: string, body: string) => void;
  setDiffSelection: (path: string, selection: DiffLineSelection | null) => void;

  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
  patchSummary: (patch: Partial<PrSummary>) => void;
  patchThread: (threadId: string, patch: Partial<PrReviewThread>) => void;
  addThread: (thread: PrReviewThread) => void;
  appendThreadComment: (threadId: string, comment: PrThreadComment) => void;
  bumpPendingCount: (by: number) => void;
  appendTimelineRow: (row: PrTimelineRow) => void;
  removeComment: (commentId: string) => void;
  invalidateLists: () => void;
  syncListRow: (summary: PrSummary) => void;
}

/**
 * Generation counters.
 *
 * Held outside the store because they are control state, not render state: a
 * bump must never cause a re-render.
 */
let listGeneration = 0;
let detailGeneration = 0;
let diffGeneration = 0;
let listInFlight = false;

/**
 * Bumped by every mutation.
 *
 * A background read that was already in flight when a mutation landed carries
 * a pre-mutation snapshot, and committing it would silently undo the
 * optimistic patch the mutation applied — a just-posted review comment would
 * disappear until the next poll five minutes later. The `busy` guard cannot
 * catch this: the read started while `busy` was still false.
 */
let mutationEpoch = 0;

export const useGitHubStore = create<GitHubStore>((set, get) => ({
  lists: emptyLists(),
  listsLoading: false,
  listsLoadedAt: null,
  listsError: null,
  otherEntries: loadOtherEntries(),
  otherUnavailable: [],
  openPrWorkspace: loadOpenPrWorkspace(),

  selection: loadSelection(),
  detail: null,
  detailLoading: false,
  detailLoadedAt: null,
  detailError: null,

  subtab: 'overview',
  diffRef: { kind: 'pr' },
  diff: null,
  diffLoading: false,
  diffError: null,
  selectedPath: null,
  viewMode: loadDiffMode(),
  mergeAction: loadMergeAction(),
  updateBranchAction: loadUpdateBranchAction(),
  localViewed: new Map(),

  actionError: null,
  busy: false,
  diffNotice: null,
  drafts: {},
  diffSelections: {},

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------

  /**
   * @param force       bypass the in-flight guard (the manual REFRESH button).
   * @param background  refresh silently: no spinner, and a failure keeps the
   *                    last good lists rather than replacing the panel with an
   *                    error banner the user never asked for.
   */
  async refreshLists(force = false, background = false) {
    // A focus storm must not stack requests; same shape as
    // `tokenRequestInFlight` in restStore.
    if (listInFlight && !force) return;
    listInFlight = true;
    const generation = ++listGeneration;
    const epoch = mutationEpoch;
    if (!background) set({ listsLoading: true, listsError: null });
    const requested = get().otherEntries.map((e) => e.id);
    try {
      const response = await window.dad.githubListPullRequests(requested);
      if (generation !== listGeneration) return;
      if (background && epoch !== mutationEpoch) return;
      const { otherEntries, lists: current } = get();
      const { items, unavailable } = reconcileOther(
        otherEntries, requested, response.other.items, current.other.items
      );
      const lists: PrLists = { ...response, other: { items, more: 0, moreIsApproximate: false } };
      set(background
        ? { lists, otherUnavailable: unavailable, listsLoadedAt: Date.now() }
        : { lists, otherUnavailable: unavailable, listsLoadedAt: Date.now(), listsLoading: false });
    } catch (err) {
      if (generation !== listGeneration) return;
      // A background failure is swallowed deliberately: the next tick retries,
      // and the manual REFRESH button remains the way to see the real error.
      if (!background) set({ listsError: (err as Error).message, listsLoading: false });
    } finally {
      listInFlight = false;
    }
  },

  addOther(candidate) {
    const { otherEntries, otherUnavailable, lists } = get();
    const entry: PrOtherEntry = {
      id: candidate.id, owner: candidate.owner, repo: candidate.repo, number: candidate.number,
    };
    const exists = otherEntries.some((e) => e.id === entry.id);
    const entries = exists
      ? otherEntries.map((e) => (e.id === entry.id ? entry : e))
      : [...otherEntries, entry];
    saveOtherEntries(entries);

    const hasRow = lists.other.items.some((item) => item.id === entry.id);
    set({
      otherEntries: entries,
      otherUnavailable: otherUnavailable.filter((id) => id !== entry.id),
      lists: hasRow ? lists : {
        ...lists,
        other: { ...lists.other, items: sortByUpdatedDesc([...lists.other.items, candidateToListItem(candidate)]) },
      },
    });
  },

  removeOther(id) {
    const { otherEntries, otherUnavailable, lists, selection, detail } = get();
    const entry = otherEntries.find((e) => e.id === id);
    if (!entry) return;
    const entries = otherEntries.filter((e) => e.id !== id);
    saveOtherEntries(entries);
    set({
      otherEntries: entries,
      otherUnavailable: otherUnavailable.filter((x) => x !== id),
      lists: { ...lists, other: { ...lists.other, items: lists.other.items.filter((item) => item.id !== id) } },
    });
    if (sameRef(selection, entry) || detail?.summary.id === id) get().select(null);
  },

  setOpenPrWorkspace(key) {
    try {
      localStorage.setItem(OPEN_PR_WORKSPACE_KEY, key);
    } catch {
      // A full quota only costs remembering the choice across restarts.
    }
    set({ openPrWorkspace: key });
  },

  /**
   * The poll interval's pass: refresh everything on screen, silently.
   *
   * Deliberately **not** staleness-gated. The gate would be the same
   * `STALE_MS` as the interval, and `listsLoadedAt` is stamped when the
   * response *lands* — a second or two after the tick that asked for it — so
   * every tick would find the data a fraction too fresh and skip, silently
   * halving the real polling rate to 600s.
   */
  pollTick() {
    // A mutation is in flight. Its optimistic patches (`patchSummary`,
    // `addThread`, `bumpPendingCount`) would be overwritten by a snapshot
    // taken before it landed, so sit this one out and retry on the next tick.
    if (get().busy) return;

    const { listsLoadedAt, selection, detail, detailLoading } = get();
    void get().refreshLists(false, listsLoadedAt !== null);
    // Never supersede a foreground reload. It owns `detailLoading`, and the
    // generation guard would discard its response before it could clear the
    // flag — leaving the header's refresh button disabled for good.
    if (selection && !detailLoading) void get().reloadDetail(detail !== null);
  },

  /**
   * The tab-activation and window-focus pass.
   *
   * Lists and detail are gated **separately** on their own `loadedAt`, so
   * pressing REFRESH and immediately switching tabs does not refetch what was
   * just fetched. A `null` timestamp means nothing has ever loaded, which is
   * also the one case that refreshes in the foreground — there is no data on
   * screen yet to keep, so the user should see `LOADING…`.
   */
  maybePollTick() {
    if (get().busy) return;

    const { listsLoadedAt, detailLoadedAt, selection, detail, detailLoading } = get();
    const now = Date.now();

    if (listsLoadedAt === null || now - listsLoadedAt >= STALE_MS) {
      void get().refreshLists(false, listsLoadedAt !== null);
    }
    // `detailLoading` also covers the first activation: the viewer's own
    // bootstrap effect may already have started this exact request.
    if (selection && !detailLoading
      && (detailLoadedAt === null || now - detailLoadedAt >= STALE_MS)) {
      void get().reloadDetail(detail !== null);
    }
  },

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  select(ref) {
    const current = get().selection;
    if (sameRef(current, ref)) return;

    try {
      if (ref) localStorage.setItem(SELECTION_KEY, formatRef(ref));
      else localStorage.removeItem(SELECTION_KEY);
    } catch {
      // A full quota is not worth refusing to open a pull request over; the
      // selection simply will not survive the next restart.
    }

    set({
      selection: ref,
      detail: null,
      detailLoadedAt: null,
      detailError: null,
      diff: null,
      diffError: null,
      diffRef: { kind: 'pr' },
      selectedPath: null,
      subtab: 'overview',
      actionError: null,
      diffNotice: null,
      // Locally-tracked viewed files belong to the pull request that was open.
      localViewed: new Map(),
      // As do unsent drafts and the selections they hang off.
      drafts: {},
      diffSelections: {},
    });

    if (ref) void get().reloadDetail();
  },

  /**
   * @param background  reload silently, and re-fetch the diff only if it can
   *                    actually have changed (see below).
   */
  async reloadDetail(background = false) {
    const ref = get().selection;
    if (!ref) return;
    const previous = get().detail;
    const generation = ++detailGeneration;
    const epoch = mutationEpoch;
    if (!background) set({ detailLoading: true, detailError: null });
    try {
      const detail = await window.dad.githubGetPullRequest(ref);
      // Discard a response for a pull request that is no longer selected.
      if (generation !== detailGeneration || !sameRef(get().selection, ref)) return;
      // …or one taken before a mutation that has since patched the detail.
      if (background && epoch !== mutationEpoch) return;
      set(background
        ? { detail, detailLoadedAt: Date.now() }
        : { detail, detailLoadedAt: Date.now(), detailLoading: false });
      // The list shows a subset of the same facts, so every action that
      // reloads the detail — approving, editing reviewers, toggling draft —
      // keeps its row in step without each one remembering to.
      get().syncListRow(detail.summary);

      if (!background) {
        void loadDiff(set, get, get().diffRef);
        return;
      }

      // A background pass refetches the diff only when it can have changed.
      // A commit- or range-scoped diff is immutable, and a full-PR diff only
      // moves when the head does — so without this the poll would re-download
      // every file's patch every 5 minutes to produce identical bytes.
      const diffRef = get().diffRef;
      const headMoved = previous?.summary.headRefOid !== detail.summary.headRefOid;
      // `diffLoading` means a foreground load owns the flag; see `pollTick`.
      if (diffRef.kind === 'pr' && headMoved && !get().diffLoading) {
        void loadDiff(set, get, diffRef, true);
      }
    } catch (err) {
      if (generation !== detailGeneration || !sameRef(get().selection, ref)) return;
      // Swallowed in background mode for the same reason as `refreshLists`.
      if (!background) set({ detailError: (err as Error).message, detailLoading: false });
    }
  },

  // -------------------------------------------------------------------------
  // Viewer
  // -------------------------------------------------------------------------

  setSubtab(tab) {
    set({ subtab: tab });
  },

  setDiffRef(ref) {
    if (diffRefKey(ref) === diffRefKey(get().diffRef)) return;
    // Hunk and line indices only mean something against the diff they were
    // taken from, so a pending selection cannot survive the switch.
    set({
      diffRef: ref, diff: null, selectedPath: null, diffError: null,
      diffSelections: {}, diffNotice: null,
    });
    void loadDiff(set, get, ref);
  },

  /** Clicking a commit hash: load that diff *and* switch to the Diff subtab. */
  openDiffFor(ref) {
    get().setDiffRef(ref);
    set({ subtab: 'diff' });
  },

  setSelectedPath(path) {
    set({ selectedPath: path });
  },

  /**
   * Jump from a review comment in the Overview to its file in the diff.
   *
   * Forces full-PR mode, because that is the only scope in which review
   * threads render inline. `setDiffRef` clears `selectedPath`, so the path is
   * applied after it; a pending load re-applies it through `nextSelectedPath`.
   */
  openFileInDiff(path) {
    get().setDiffRef({ kind: 'pr' });
    set({ selectedPath: path, subtab: 'diff' });
  },

  setViewMode(mode) {
    try {
      localStorage.setItem(DIFF_MODE_KEY, mode);
    } catch {
      // Cosmetic preference; not worth failing the toggle over.
    }
    set({ viewMode: mode });
  },

  setMergeAction(action) {
    try {
      localStorage.setItem(MERGE_ACTION_KEY, action);
    } catch {
      // A full quota only costs the preference, not the action itself.
    }
    set({ mergeAction: action });
  },

  setUpdateBranchAction(action) {
    try {
      localStorage.setItem(UPDATE_BRANCH_ACTION_KEY, action);
    } catch {
      // A full quota only costs the preference, not the action itself.
    }
    set({ updateBranchAction: action });
  },

  async toggleViewed(path, viewed) {
    const { diffRef, diff, detail, localViewed } = get();

    if (diffRef.kind !== 'pr') {
      // Commit- and range-scoped viewed state is local and need not survive a
      // restart (ambiguity 27).
      const key = diffRefKey(diffRef);
      const next = new Map(localViewed);
      const paths = new Set(next.get(key) ?? []);
      if (viewed) paths.add(path);
      else paths.delete(path);
      next.set(key, paths);
      set({ localViewed: next });
      return;
    }

    if (!detail || !diff) return;
    const previous = diff.files;
    // Optimistic: a checkmark that lags a round trip feels broken.
    set({ diff: { ...diff, files: diff.files.map((f) => (f.path === path ? { ...f, viewed } : f)) } });
    try {
      await window.dad.githubSetFileViewed(detail.summary.id, path, viewed);
    } catch (err) {
      const current = get().diff;
      if (current) set({ diff: { ...current, files: previous } });
      set({ actionError: (err as Error).message });
    }
  },

  setActionError(message) {
    set({ actionError: message });
  },

  setDiffNotice(message) {
    set({ diffNotice: message });
  },

  setDiffSelection(path, selection) {
    const next = { ...get().diffSelections };
    if (selection) next[path] = selection;
    else delete next[path];
    set({ diffSelections: next });
  },

  /** Empty text removes the entry, so the map cannot grow without bound. */
  setDraft(key, body) {
    const { diff, drafts } = get();
    const path = diffDraftPath(key);

    // A composer hands its text over on unmount — which is exactly what a
    // refresh that dropped this file triggers. Storing it would resurrect a
    // draft with nowhere left to render, and contradict the notice that has
    // just told the user it could not be kept. `diff === null` means a diff
    // ref switch is in progress, where the old path legitimately has nothing
    // to match against.
    if (path !== null && diff !== null && !diff.files.some((f) => f.path === path)) {
      if (body) set({ diffNotice: vanishedFileNotice(path) });
      return;
    }

    const next = { ...drafts };
    if (body) next[key] = body;
    else delete next[key];
    set({ drafts: next });
  },

  // -------------------------------------------------------------------------
  // Mutation plumbing
  // -------------------------------------------------------------------------

  /** Run a mutation with a busy flag and a single error surface. */
  async run(fn) {
    // Invalidate every background read already in flight — see `mutationEpoch`.
    mutationEpoch += 1;
    set({ busy: true, actionError: null });
    try {
      return await fn();
    } catch (err) {
      set({ actionError: (err as Error).message });
      return null;
    } finally {
      set({ busy: false });
    }
  },

  patchSummary(patch) {
    const detail = get().detail;
    if (!detail) return;
    set({ detail: { ...detail, summary: { ...detail.summary, ...patch } } });
  },

  patchThread(threadId, patch) {
    const detail = get().detail;
    if (!detail) return;
    set({
      detail: {
        ...detail,
        threads: detail.threads.map((t) => (t.id === threadId ? { ...t, ...patch } : t)),
      },
    });
  },

  addThread(thread) {
    const detail = get().detail;
    if (!detail || !thread.id) return;
    if (detail.threads.some((t) => t.id === thread.id)) return;
    set({ detail: { ...detail, threads: [...detail.threads, thread] } });
  },

  appendThreadComment(threadId, comment) {
    const detail = get().detail;
    if (!detail) return;
    set({
      detail: {
        ...detail,
        threads: detail.threads.map((t) =>
          t.id === threadId && !t.comments.some((c) => c.id === comment.id)
            ? { ...t, comments: [...t.comments, comment] }
            : t
        ),
      },
    });
  },

  /**
   * Keep the pending review's comment count current.
   *
   * It drives the `APPROVE (3)` labels and the "N comments pending" line, so
   * leaving it at the value from the last full load makes both lie until an
   * unrelated action happens to reload.
   */
  bumpPendingCount(by) {
    const detail = get().detail;
    const pending = detail?.summary.pendingReview;
    if (!detail || !pending) return;
    set({
      detail: {
        ...detail,
        summary: {
          ...detail.summary,
          pendingReview: { ...pending, commentCount: Math.max(0, pending.commentCount + by) },
        },
      },
    });
  },

  /**
   * Drop a deleted comment wherever it lives.
   *
   * Searches both the timeline and every thread because the same id can be
   * rendered in either place — a review comment shows inline on the diff and
   * again under its review in the Overview. A thread left with no comments is
   * removed too; GitHub does the same.
   */
  removeComment(commentId) {
    const detail = get().detail;
    if (!detail) return;
    set({
      detail: {
        ...detail,
        timeline: detail.timeline
          .filter((row) => !(row.kind === 'comment' && row.id === commentId))
          .map((row) => (row.kind === 'review'
            ? { ...row, comments: row.comments.filter((c) => c.id !== commentId) }
            : row)),
        threads: detail.threads
          .map((t) => ({ ...t, comments: t.comments.filter((c) => c.id !== commentId) }))
          .filter((t) => t.comments.length > 0),
      },
    });
  },

  appendTimelineRow(row) {
    const detail = get().detail;
    if (!detail) return;
    set({ detail: { ...detail, timeline: [...detail.timeline, row] } });
  },

  /**
   * Mirror the viewer's state onto the matching list row.
   *
   * Only the fields the list actually renders, and only where the row already
   * exists — a pull request absent from the lists (opened from a restored
   * selection, say) must not be invented into one, because which list it
   * belongs in is a question only the search can answer.
   */
  syncListRow(summary) {
    const lists = get().lists;
    const patch = {
      title: summary.title,
      isDraft: summary.isDraft,
      mergeable: summary.mergeable,
      mergeState: summary.mergeState,
      checks: summary.checks,
      reviewers: summary.reviewers,
      updatedAt: summary.updatedAt,
      baseRefName: summary.baseRefName,
      headRefName: summary.headRefName,
      state: toPrState(summary.state),
    };

    let changed = false;
    const next = {} as PrLists;
    for (const key of ['created', 'reviewing', 'other'] as PrListId[]) {
      const list = lists[key];
      if (!list.items.some((item) => item.id === summary.id)) {
        next[key] = list;
        continue;
      }
      changed = true;
      next[key] = {
        ...list,
        items: list.items.map((item) => (item.id === summary.id ? { ...item, ...patch } : item)),
      };
    }

    if (changed) set({ lists: next });
  },

  /**
   * Force the next list check to refetch.
   *
   * Merging or closing removes a pull request from the open-only lists, so a
   * targeted patch cannot be honest about what the lists now contain.
   */
  invalidateLists() {
    set({ listsLoadedAt: null });
  },
}));

// ---------------------------------------------------------------------------
// Diff loading
// ---------------------------------------------------------------------------

type SetState = (partial: Partial<GitHubStore>) => void;
type GetState = () => GitHubStore;

/**
 * Drop the unsent work attached to a file that is no longer in the diff.
 *
 * Returns the state patch, or `null` when the file had nothing hanging off it.
 * The notice is only raised when there was real draft *text* — an open but
 * empty composer is not lost work, and saying so would be noise.
 */
function discardWorkForPath(
  path: string, drafts: Record<string, string>, diffSelections: Record<string, DiffLineSelection>
): Partial<GitHubStore> | null {
  const prefix = `diff:${path}:`;
  const keys = Object.keys(drafts).filter((key) => key.startsWith(prefix));
  const hadSelection = diffSelections[path] !== undefined;
  if (keys.length === 0 && !hadSelection) return null;

  const nextDrafts = { ...drafts };
  for (const key of keys) delete nextDrafts[key];
  const nextSelections = { ...diffSelections };
  delete nextSelections[path];

  const lostText = keys.some((key) => drafts[key] !== '');

  return {
    drafts: nextDrafts,
    diffSelections: nextSelections,
    ...(lostText ? { diffNotice: vanishedFileNotice(path) } : {}),
  };
}

/**
 * @param background  load silently: no spinner, and a failure keeps the diff
 *                    that is already on screen.
 */
async function loadDiff(
  set: SetState, get: GetState, ref: PrDiffRef, background = false
): Promise<void> {
  const selection = get().selection;
  const detail = get().detail;
  if (!selection || !detail) return;

  const generation = ++diffGeneration;
  const requestedKey = diffRefKey(ref);
  const epoch = mutationEpoch;
  if (!background) set({ diffLoading: true, diffError: null });

  try {
    const diff = await window.dad.githubGetDiff(selection, ref, detail.summary.changedFiles);
    // Two guards: a newer diff request, and a different pull request entirely.
    if (generation !== diffGeneration) return;
    if (!sameRef(get().selection, selection) || diffRefKey(get().diffRef) !== requestedKey) return;
    if (background && epoch !== mutationEpoch) return;

    const { selectedPath, drafts, diffSelections } = get();
    // A path that vanished from a *refresh* of the same diff ref. Switching
    // ref cannot land here: `setDiffRef` nulls `selectedPath` before calling.
    const vanished = selectedPath !== null && !diff.files.some((f) => f.path === selectedPath)
      ? discardWorkForPath(selectedPath, drafts, diffSelections)
      : null;

    set({
      diff,
      selectedPath: nextSelectedPath(selectedPath, diff.files),
      ...(background ? {} : { diffLoading: false }),
      ...(vanished ?? {}),
    });
  } catch (err) {
    if (generation !== diffGeneration) return;
    if (!sameRef(get().selection, selection) || diffRefKey(get().diffRef) !== requestedKey) return;
    if (!background) set({ diffError: (err as Error).message, diffLoading: false });
  }
}

/**
 * Keep the selected file where it still exists, otherwise fall back to the
 * first (requirement 3.2.3.3.1). Resetting unconditionally would scroll the
 * user back to the top on every refresh.
 */
export function nextSelectedPath(current: string | null, files: PrDiffFile[]): string | null {
  if (current && files.some((f) => f.path === current)) return current;
  return files[0]?.path ?? null;
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Whether a file counts as viewed in the current diff scope. */
export function isFileViewed(
  file: PrDiffFile, diffRef: PrDiffRef, localViewed: Map<string, Set<string>>
): boolean {
  if (diffRef.kind === 'pr') return file.viewed;
  return localViewed.get(diffRefKey(diffRef))?.has(file.path) ?? false;
}

/**
 * The diff refs offered in the dropdown (ambiguity 26).
 *
 * Full PR first and selected by default, then force-push ranges newest-first,
 * then every commit newest-first. A force push whose before-commit has been
 * garbage-collected is still listed — hiding it would hide that history was
 * rewritten — but is not selectable.
 */
export interface DiffRefOption {
  key: string;
  label: string;
  ref: PrDiffRef | null;
}

export function diffRefOptions(detail: PrDetail | null): DiffRefOption[] {
  if (!detail) return [{ key: 'pr', label: 'Full diff', ref: { kind: 'pr' } }];

  const options: DiffRefOption[] = [
    {
      key: 'pr',
      label: `Full diff (${detail.commits.length} commit${detail.commits.length === 1 ? '' : 's'})`,
      ref: { kind: 'pr' },
    },
  ];

  for (const force of [...detail.forcePushes].reverse()) {
    if (!force.beforeOid) {
      options.push({
        key: `fp-${force.id}`,
        label: `force-push · before-commit no longer available`,
        ref: null,
      });
      continue;
    }
    const label = `force-push · ${force.beforeAbbrev}…${force.afterAbbrev}`;
    options.push({
      key: `fp-${force.id}`,
      label,
      ref: { kind: 'range', beforeOid: force.beforeOid, afterOid: force.afterOid, label },
    });
  }

  for (const commit of [...detail.commits].reverse()) {
    options.push({
      key: `c-${commit.oid}`,
      label: `${commit.abbreviatedOid}  ${commit.messageHeadline}`,
      ref: { kind: 'commit', oid: commit.oid, abbreviatedOid: commit.abbreviatedOid },
    });
  }

  // A commit that dismissed a review is usually already listed above. It is
  // not when the branch has since been rebased: the dismissal still points at
  // the pre-rebase commit, which the repository still serves but the pull
  // request no longer lists. Opening it from the Overview would then leave the
  // dropdown reading "Full diff" while showing that commit's diff, so give it
  // an entry of its own — as force-push ranges already get.
  const listed = new Set(detail.commits.map((c) => c.oid));
  for (const row of detail.timeline) {
    if (row.kind !== 'dismissal' || !row.commit || listed.has(row.commit.oid)) continue;
    listed.add(row.commit.oid);
    options.push({
      key: `c-${row.commit.oid}`,
      label: `${row.commit.abbreviatedOid}  ${row.commit.messageHeadline} (dismissed a review)`,
      ref: { kind: 'commit', oid: row.commit.oid, abbreviatedOid: row.commit.abbreviatedOid },
    });
  }

  return options;
}

/** Whether a thread renders inline against the diff at all. */
function isInlineThread(thread: PrReviewThread): boolean {
  return !thread.isOutdated && thread.line !== null;
}

/** Threads that belong inline in the diff: live, and on the shown file. */
export function threadsForFile(threads: PrReviewThread[], path: string | null): PrReviewThread[] {
  if (!path) return [];
  return threads.filter((t) => isInlineThread(t) && t.path === path);
}

/**
 * Comments per file, for the counts beside the file names.
 *
 * Counts exactly what opening the file will show — same predicate as
 * `threadsForFile` — so the number cannot promise discussion the diff then
 * fails to display. Outdated threads are therefore excluded; they have no
 * line to render against and surface in the Overview instead.
 */
export function commentCountsByFile(threads: PrReviewThread[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const thread of threads) {
    if (!isInlineThread(thread)) continue;
    counts[thread.path] = (counts[thread.path] ?? 0) + thread.comments.length;
  }
  return counts;
}

export function anchorFrom(path: string, line: number, side: 'LEFT' | 'RIGHT'): PrCommentAnchor {
  return { path, line, side, startLine: null, startSide: null };
}

export type { PrMergeOptions, PrReviewEvent };
