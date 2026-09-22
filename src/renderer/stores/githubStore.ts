/**
 * Pull My Finger (GIT1) renderer state.
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
  PrCommentAnchor, PrDetail, PrDiff, PrDiffFile, PrDiffRef, PrListId, PrLists, PrMergeMethod,
  PrMergeOptions, PrRef, PrReviewEvent, PrReviewThread, PrSummary, PrThreadComment,
  PrTimelineRow,
} from '../../main/types';
import { emptyLists } from '../../main/githubPrLists';

const SELECTION_KEY = 'dad-git-selection';
const DIFF_MODE_KEY = 'dad-git-diff-mode';
const MERGE_ACTION_KEY = 'dad-git-merge-action';

/** Lists older than this are refetched on focus or on returning to the tab. */
export const STALE_MS = 5 * 60_000;

export type PrSubtab = 'overview' | 'commits' | 'diff';

/** A pending diff comment's line range, within one hunk of one file. */
export interface DiffLineSelection {
  hunkIndex: number;
  from: number;
  to: number;
}

/** What the header's merge split button runs by default. */
export type MergeAction = PrMergeMethod | 'AUTO';

const MERGE_ACTIONS: MergeAction[] = ['MERGE', 'SQUASH', 'REBASE', 'AUTO'];
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

  // --- selection & detail ------------------------------------------------
  selection: PrRef | null;
  detail: PrDetail | null;
  detailLoading: boolean;
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
  refreshLists: (force?: boolean) => Promise<void>;
  maybeRefreshLists: () => void;
  select: (ref: PrRef | null) => void;
  reloadDetail: () => Promise<void>;
  setSubtab: (tab: PrSubtab) => void;
  setDiffRef: (ref: PrDiffRef) => void;
  openDiffFor: (ref: PrDiffRef) => void;
  openFileInDiff: (path: string) => void;
  setSelectedPath: (path: string) => void;
  setViewMode: (mode: DiffViewMode) => void;
  setMergeAction: (action: MergeAction) => void;
  toggleViewed: (path: string, viewed: boolean) => Promise<void>;
  setActionError: (message: string | null) => void;
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

export const useGitHubStore = create<GitHubStore>((set, get) => ({
  lists: emptyLists(),
  listsLoading: false,
  listsLoadedAt: null,
  listsError: null,

  selection: loadSelection(),
  detail: null,
  detailLoading: false,
  detailError: null,

  subtab: 'overview',
  diffRef: { kind: 'pr' },
  diff: null,
  diffLoading: false,
  diffError: null,
  selectedPath: null,
  viewMode: loadDiffMode(),
  mergeAction: loadMergeAction(),
  localViewed: new Map(),

  actionError: null,
  busy: false,
  drafts: {},
  diffSelections: {},

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------

  async refreshLists(force = false) {
    // A focus storm must not stack requests; same shape as
    // `tokenRequestInFlight` in restStore.
    if (listInFlight && !force) return;
    listInFlight = true;
    const generation = ++listGeneration;
    set({ listsLoading: true, listsError: null });
    try {
      const lists = await window.dad.githubListPullRequests();
      if (generation !== listGeneration) return;
      set({ lists, listsLoadedAt: Date.now(), listsLoading: false });
    } catch (err) {
      if (generation !== listGeneration) return;
      set({ listsError: (err as Error).message, listsLoading: false });
    } finally {
      listInFlight = false;
    }
  },

  maybeRefreshLists() {
    const { listsLoadedAt, listsLoading } = get();
    if (listsLoading) return;
    if (listsLoadedAt !== null && Date.now() - listsLoadedAt < STALE_MS) return;
    void get().refreshLists();
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
      detailError: null,
      diff: null,
      diffError: null,
      diffRef: { kind: 'pr' },
      selectedPath: null,
      subtab: 'overview',
      actionError: null,
      // Locally-tracked viewed files belong to the pull request that was open.
      localViewed: new Map(),
      // As do unsent drafts and the selections they hang off.
      drafts: {},
      diffSelections: {},
    });

    if (ref) void get().reloadDetail();
  },

  async reloadDetail() {
    const ref = get().selection;
    if (!ref) return;
    const generation = ++detailGeneration;
    set({ detailLoading: true, detailError: null });
    try {
      const detail = await window.dad.githubGetPullRequest(ref);
      // Discard a response for a pull request that is no longer selected.
      if (generation !== detailGeneration || !sameRef(get().selection, ref)) return;
      set({ detail, detailLoading: false });
      // The list shows a subset of the same facts, so every action that
      // reloads the detail — approving, editing reviewers, toggling draft —
      // keeps its row in step without each one remembering to.
      get().syncListRow(detail.summary);
      void loadDiff(set, get, get().diffRef);
    } catch (err) {
      if (generation !== detailGeneration || !sameRef(get().selection, ref)) return;
      set({ detailError: (err as Error).message, detailLoading: false });
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
    set({ diffRef: ref, diff: null, selectedPath: null, diffError: null, diffSelections: {} });
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

  setDiffSelection(path, selection) {
    const next = { ...get().diffSelections };
    if (selection) next[path] = selection;
    else delete next[path];
    set({ diffSelections: next });
  },

  /** Empty text removes the entry, so the map cannot grow without bound. */
  setDraft(key, body) {
    const drafts = { ...get().drafts };
    if (body) drafts[key] = body;
    else delete drafts[key];
    set({ drafts });
  },

  // -------------------------------------------------------------------------
  // Mutation plumbing
  // -------------------------------------------------------------------------

  /** Run a mutation with a busy flag and a single error surface. */
  async run(fn) {
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
    };

    let changed = false;
    const next = {} as PrLists;
    for (const key of ['created', 'reviewing', 'listening'] as PrListId[]) {
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

async function loadDiff(set: SetState, get: GetState, ref: PrDiffRef): Promise<void> {
  const selection = get().selection;
  const detail = get().detail;
  if (!selection || !detail) return;

  const generation = ++diffGeneration;
  const requestedKey = diffRefKey(ref);
  set({ diffLoading: true, diffError: null });

  try {
    const diff = await window.dad.githubGetDiff(selection, ref, detail.summary.changedFiles);
    // Two guards: a newer diff request, and a different pull request entirely.
    if (generation !== diffGeneration) return;
    if (!sameRef(get().selection, selection) || diffRefKey(get().diffRef) !== requestedKey) return;
    set({ diff, diffLoading: false, selectedPath: nextSelectedPath(get().selectedPath, diff.files) });
  } catch (err) {
    if (generation !== diffGeneration) return;
    if (!sameRef(get().selection, selection) || diffRefKey(get().diffRef) !== requestedKey) return;
    set({ diffError: (err as Error).message, diffLoading: false });
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
