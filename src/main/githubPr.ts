/**
 * Single pull request — reads and mutations.
 *
 * Loading is split by connection rather than done as one document: GraphQL
 * connections cap at 100 nodes and need cursors, so a single "give me
 * everything" query silently truncates commits, timeline and threads — the
 * exact failure requirement 3.2.2 ("all diff commits") forbids.
 */

import { ghGraphql, ghRest, ghRestPagedArray, ghRestPagedObject } from './github';
import {
  ADD_ISSUE_COMMENT_MUTATION, ADD_REVIEW_THREAD_MUTATION, CLOSE_PR_MUTATION,
  CONVERT_TO_DRAFT_MUTATION, DELETE_ISSUE_COMMENT_MUTATION, DELETE_REVIEW_COMMENT_MUTATION,
  DISABLE_AUTO_MERGE_MUTATION,
  DISCARD_REVIEW_MUTATION, ENABLE_AUTO_MERGE_MUTATION,
  MARK_FILE_VIEWED_MUTATION, MERGE_MUTATION, PR_COMMITS_QUERY, PR_COMPARE_QUERY,
  PR_FILE_VIEWED_QUERY, PR_REVIEW_THREADS_QUERY, PR_SUMMARY_QUERY, PR_TIMELINE_QUERY,
  READY_FOR_REVIEW_MUTATION, REPLY_THREAD_MUTATION, RESOLVE_THREAD_MUTATION,
  SET_REVIEWERS_MUTATION, SUBMIT_REVIEW_MUTATION,
  SUBMIT_STANDALONE_REVIEW_MUTATION, UNMARK_FILE_VIEWED_MUTATION, UNRESOLVE_THREAD_MUTATION,
} from './githubQueries';
import { TIMELINE_ITEM_TYPES, commitFromNode, mergePages, normalizeTimeline } from './githubTimeline';
import { buildReviewers, toCheck, toCheckState, toMergeState, toMergeableState } from './githubPrs';
import {
  PrAutoMerge, PrCommentAnchor, PrCommit, PrDetail, PrDiff, PrDiffFile, PrDiffRef,
  PrFileStatus, PrMergeMethod, PrMergeOptions, PrRef, PrReviewEvent,
  PrReviewThread, PrSummary, PrThreadComment, PrThreadState,
} from './types';

/**
 * Pages per connection.
 *
 * Bounded so a pathological pull request cannot hang the panel. Hitting the
 * cap surfaces as a visible "history truncated" footer rather than a silently
 * short list.
 */
const MAX_PAGES = 20;

// ---------------------------------------------------------------------------
// Cursor loop
// ---------------------------------------------------------------------------

interface Connection<T> {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: T[];
}

interface PagedResult<T> {
  nodes: T[];
  truncated: boolean;
}

async function collect<T extends { id?: string }>(
  query: string,
  variables: Record<string, unknown>,
  pick: (data: unknown) => Connection<T> | undefined
): Promise<PagedResult<T>> {
  const pages: T[][] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await ghGraphql<unknown>(query, { ...variables, cursor });
    const connection = pick(data);
    pages.push(connection?.nodes ?? []);
    if (connection?.pageInfo?.hasNextPage !== true) {
      return { nodes: mergePages(pages), truncated: false };
    }
    cursor = connection.pageInfo.endCursor ?? null;
    if (!cursor) return { nodes: mergePages(pages), truncated: false };
  }

  return { nodes: mergePages(pages), truncated: true };
}

function prNode(data: unknown): Record<string, unknown> | undefined {
  return (data as { repository?: { pullRequest?: Record<string, unknown> } })?.repository?.pullRequest;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

interface SummaryResponse {
  repository?: {
    mergeCommitAllowed?: boolean;
    squashMergeAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
    pullRequest?: Record<string, any> | null;
  };
}

function toAutoMerge(raw: any): PrAutoMerge | null {
  if (!raw?.enabledAt) return null;
  return {
    enabledAt: raw.enabledAt,
    mergeMethod: (raw.mergeMethod ?? 'MERGE') as PrMergeMethod,
    enabledBy: raw.enabledBy?.login ?? null,
  };
}

async function fetchSummary(ref: PrRef): Promise<PrSummary> {
  const data = await ghGraphql<SummaryResponse>(PR_SUMMARY_QUERY, {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
  });

  const repo = data.repository;
  const pr = repo?.pullRequest;
  if (!pr) throw new Error(`Pull request ${ref.owner}/${ref.repo}#${ref.number} not found`);

  const pending = pr.reviews?.nodes?.[0];

  return {
    id: pr.id,
    number: pr.number,
    owner: ref.owner,
    repo: ref.repo,
    title: pr.title ?? '',
    body: pr.body ?? '',
    url: pr.url ?? '',
    state: pr.state ?? '',
    isDraft: pr.isDraft === true,
    merged: pr.merged === true,
    mergeable: toMergeableState(pr.mergeable),
    mergeState: toMergeState(pr.mergeStateStatus),
    checks: toCheckState(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    reviewDecision: pr.reviewDecision ?? null,
    checkRuns: (pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [])
      .map((c: unknown, i: number) => toCheck(c, i)),
    changedFiles: pr.changedFiles ?? 0,
    commitCount: pr.commits?.totalCount ?? 0,
    author: pr.author?.login ?? null,
    createdAt: pr.createdAt ?? '',
    updatedAt: pr.updatedAt ?? '',
    baseRefName: pr.baseRefName ?? '',
    headRefName: pr.headRefName ?? '',
    baseRefOid: pr.baseRefOid ?? '',
    headRefOid: pr.headRefOid ?? '',
    headRepoOwner: pr.headRepository?.owner?.login ?? null,
    isCrossRepository: pr.isCrossRepository === true,
    viewerCanUpdate: pr.viewerCanUpdate === true,
    viewerDidAuthor: pr.viewerDidAuthor === true,
    mergeHeadline: pr.viewerMergeHeadlineText ?? '',
    mergeBody: pr.viewerMergeBodyText ?? '',
    autoMerge: toAutoMerge(pr.autoMergeRequest),
    allowedMergeMethods: {
      merge: repo?.mergeCommitAllowed === true,
      squash: repo?.squashMergeAllowed === true,
      rebase: repo?.rebaseMergeAllowed === true,
    },
    labels: (pr.labels?.nodes ?? []).map((l: any) => ({ name: l?.name ?? '', color: l?.color ?? '' })),
    assignees: (pr.assignees?.nodes ?? []).map((a: any) => a?.login).filter(Boolean),
    milestone: pr.milestone?.title ?? null,
    reviewers: buildReviewers(pr.reviewRequests?.nodes, pr.latestReviews?.nodes),
    suggestedReviewers: (pr.suggestedReviewers ?? [])
      .map((s: any) => s?.reviewer?.login)
      .filter(Boolean),
    pendingReview: pending
      ? { id: pending.id, body: pending.body ?? '', commentCount: pending.comments?.totalCount ?? 0 }
      : null,
    compare: null,
  };
}

/**
 * Ahead/behind (requirement 3.3.8).
 *
 * A failure here is never allowed to fail the whole pull request: the counts
 * are informative, and a fork whose head branch the base repository cannot
 * resolve is a normal situation, not an error.
 */
async function fetchCompare(summary: PrSummary): Promise<PrSummary['compare']> {
  try {
    if (summary.isCrossRepository) {
      // GraphQL's `Ref.compare(headRef:)` cannot resolve a ref in another
      // repository; REST compare accepts the `owner:branch` form.
      if (!summary.headRepoOwner) return null;
      const path = `repos/${summary.owner}/${summary.repo}/compare/`
        + `${encodeURIComponent(summary.baseRefName)}...`
        + `${encodeURIComponent(`${summary.headRepoOwner}:${summary.headRefName}`)}`;
      const data = await ghRest<{ ahead_by?: number; behind_by?: number; status?: string }>(path);
      return {
        aheadBy: data.ahead_by ?? 0,
        behindBy: data.behind_by ?? 0,
        status: data.status ?? '',
      };
    }

    const data = await ghGraphql<any>(PR_COMPARE_QUERY, {
      owner: summary.owner,
      repo: summary.repo,
      number: summary.number,
      headRefName: summary.headRefName,
    });
    const compare = data?.repository?.pullRequest?.baseRef?.compare;
    if (!compare) return null;
    return { aheadBy: compare.aheadBy ?? 0, behindBy: compare.behindBy ?? 0, status: compare.status ?? '' };
  } catch {
    // Deleted branch, fork with no shared history, or a ref GitHub cannot
    // resolve. The header simply omits the counts.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function toThreadComment(raw: any): PrThreadComment {
  return {
    id: raw?.id ?? '',
    databaseId: raw?.databaseId ?? null,
    body: raw?.body ?? '',
    createdAt: raw?.createdAt ?? '',
    author: raw?.author?.login ?? null,
    viewerDidAuthor: raw?.viewerDidAuthor === true,
    outdated: raw?.outdated === true,
    state: raw?.state ?? '',
    viewerCanDelete: raw?.viewerCanDelete === true,
  };
}

export function toReviewThread(raw: any): PrReviewThread {
  return {
    id: raw?.id ?? '',
    isResolved: raw?.isResolved === true,
    isOutdated: raw?.isOutdated === true,
    viewerCanResolve: raw?.viewerCanResolve === true,
    viewerCanUnresolve: raw?.viewerCanUnresolve === true,
    viewerCanReply: raw?.viewerCanReply === true,
    path: raw?.path ?? '',
    // `line` goes null once the anchor no longer exists in the current diff;
    // `originalLine` still says where it was, which is what lets an outdated
    // thread be listed at all.
    line: raw?.line ?? raw?.originalLine ?? null,
    startLine: raw?.startLine ?? raw?.originalStartLine ?? null,
    side: raw?.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
    comments: (raw?.comments?.nodes ?? []).map(toThreadComment),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function getPullRequest(ref: PrRef): Promise<PrDetail> {
  const summary = await fetchSummary(ref);
  const vars = { owner: ref.owner, repo: ref.repo, number: ref.number };

  const [commitsPage, timelinePage, threadsPage, compare] = await Promise.all([
    collect<any>(PR_COMMITS_QUERY, vars, (d) => prNode(d)?.commits as Connection<any>),
    collect<any>(
      PR_TIMELINE_QUERY,
      { ...vars, types: TIMELINE_ITEM_TYPES },
      (d) => prNode(d)?.timelineItems as Connection<any>
    ),
    collect<any>(PR_REVIEW_THREADS_QUERY, vars, (d) => prNode(d)?.reviewThreads as Connection<any>),
    fetchCompare(summary),
  ]);

  const commits: PrCommit[] = commitsPage.nodes
    .map((node) => commitFromNode(node?.commit))
    .filter((c): c is PrCommit => c !== null);

  const { rows, forcePushes } = normalizeTimeline(timelinePage.nodes);

  return {
    summary: { ...summary, compare },
    commits,
    forcePushes,
    timeline: rows,
    threads: threadsPage.nodes.map(toReviewThread),
    historyTruncated: commitsPage.truncated || timelinePage.truncated || threadsPage.truncated,
  };
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

interface RestFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

function toDiffFile(file: RestFile, viewed: Set<string>): PrDiffFile {
  const path = file.filename ?? '';
  return {
    path,
    previousPath: file.previous_filename ?? null,
    status: (file.status ?? 'modified') as PrFileStatus,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    // Absent for binary files and anything past GitHub's size ceiling; the
    // viewer renders a placeholder rather than dropping the row.
    patch: file.patch ?? null,
    viewed: viewed.has(path),
  };
}

/**
 * Viewed state, which GitHub defines against the full PR diff only.
 *
 * Fetched only in full-PR mode; a commit-scoped diff tracks viewed files
 * locally in the renderer instead (ambiguity 27).
 */
async function fetchViewedPaths(ref: PrRef): Promise<Set<string>> {
  const page = await collect<any>(
    PR_FILE_VIEWED_QUERY,
    { owner: ref.owner, repo: ref.repo, number: ref.number },
    (d) => prNode(d)?.files as Connection<any>
  );
  const viewed = new Set<string>();
  for (const node of page.nodes) {
    if (node?.viewerViewedState === 'VIEWED' && node.path) viewed.add(node.path);
  }
  return viewed;
}

export async function getDiff(ref: PrRef, diffRef: PrDiffRef, changedFiles: number): Promise<PrDiff> {
  const base = `repos/${ref.owner}/${ref.repo}`;

  if (diffRef.kind === 'pr') {
    const [files, viewed] = await Promise.all([
      ghRestPagedArray<RestFile>(`${base}/pulls/${ref.number}/files`),
      fetchViewedPaths(ref),
    ]);
    return {
      files: files.map((f) => toDiffFile(f, viewed)),
      // `changedFiles` comes from GraphQL and is a true count, so a short file
      // list is detectable rather than invisible.
      truncated: changedFiles > 0 && files.length < changedFiles,
      headOid: '',
    };
  }

  const noneViewed = new Set<string>();

  if (diffRef.kind === 'commit') {
    const { value, truncated } = await ghRestPagedObject<{ files?: RestFile[]; sha?: string }, 'files'>(
      `${base}/commits/${diffRef.oid}`,
      'files'
    );
    return {
      files: (value.files ?? []).map((f) => toDiffFile(f, noneViewed)),
      truncated,
      headOid: value.sha ?? diffRef.oid,
    };
  }

  const { value, truncated } = await ghRestPagedObject<{ files?: RestFile[] }, 'files'>(
    `${base}/compare/${diffRef.beforeOid}...${diffRef.afterOid}`,
    'files'
  );
  return {
    files: (value.files ?? []).map((f) => toDiffFile(f, noneViewed)),
    truncated,
    headOid: diffRef.afterOid,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function submitReview(
  pullRequestId: string, reviewId: string | null, event: PrReviewEvent, body: string
): Promise<void> {
  if (reviewId) {
    await ghGraphql(SUBMIT_REVIEW_MUTATION, { reviewId, event, body: body || null });
    return;
  }
  // No review in progress: `addPullRequestReview` with an event submits one
  // directly, which is what the header's APPROVE does on an untouched PR.
  await ghGraphql(SUBMIT_STANDALONE_REVIEW_MUTATION, { pullRequestId, event, body: body || null });
}

export async function discardReview(reviewId: string): Promise<void> {
  await ghGraphql(DISCARD_REVIEW_MUTATION, { reviewId });
}

/**
 * Post a diff-anchored comment into a review.
 *
 * A diff comment is *never* published on its own: it is always held in a
 * pending review until the user submits one deliberately. When no review is
 * open yet, `addPullRequestReviewThread` creates a PENDING one implicitly —
 * verified against the live API — and its id is returned so the caller can
 * arm the rest of the session against it.
 */
export async function addReviewComment(
  pullRequestId: string, reviewId: string | null, anchor: PrCommentAnchor, body: string
): Promise<{ thread: PrReviewThread; pendingReviewId: string | null }> {
  const data = await ghGraphql<any>(ADD_REVIEW_THREAD_MUTATION, {
    pullRequestId,
    reviewId,
    path: anchor.path,
    body,
    line: anchor.line,
    side: anchor.side,
    startLine: anchor.startLine,
    startSide: anchor.startSide,
  });

  const raw = data?.addPullRequestReviewThread?.thread;
  const review = raw?.comments?.nodes?.[0]?.pullRequestReview;

  return {
    thread: toReviewThread(raw),
    // Only a review still awaiting submission is worth reporting back; a
    // published one is not something the user can add to.
    pendingReviewId: review?.state === 'PENDING' ? (review.id ?? null) : (reviewId ?? null),
  };
}

/**
 * Reply to an existing thread.
 *
 * Unlike `addPullRequestReviewThread`, a reply with no review id is published
 * outright — GitHub returns it already SUBMITTED — so there is normally
 * nothing to submit. Verified against the live API. The PENDING branch is kept
 * because the same mutation *does* hold the reply back when a review is in
 * progress, and blindly submitting an already-published review fails with
 * "Could not comment pull request review".
 */
export async function replyToThread(
  threadId: string, reviewId: string | null, body: string
): Promise<PrThreadComment> {
  const data = await ghGraphql<any>(REPLY_THREAD_MUTATION, { threadId, reviewId, body });
  const comment = data?.addPullRequestReviewThreadReply?.comment;
  const review = comment?.pullRequestReview;

  if (!reviewId && review?.id && review.state === 'PENDING') {
    await ghGraphql(SUBMIT_REVIEW_MUTATION, { reviewId: review.id, event: 'COMMENT', body: null });
    return { ...toThreadComment(comment), state: 'SUBMITTED' };
  }

  return toThreadComment(comment);
}

export async function addIssueComment(subjectId: string, body: string): Promise<{
  id: string; createdAt: string; body: string; author: string | null;
}> {
  const data = await ghGraphql<any>(ADD_ISSUE_COMMENT_MUTATION, { subjectId, body });
  const node = data?.addComment?.commentEdge?.node;
  return {
    id: node?.id ?? '',
    createdAt: node?.createdAt ?? new Date().toISOString(),
    body: node?.body ?? body,
    author: node?.author?.login ?? null,
  };
}

/**
 * Resolve or unresolve, returning the refreshed permissions with the state.
 *
 * `viewerCanResolve` and `viewerCanUnresolve` are mutually exclusive and flip
 * with `isResolved`, so the caller must replace both — keeping the stale pair
 * makes the opposite action vanish from the UI.
 */
/**
 * Delete a comment.
 *
 * The two comment types have separate mutations and are not interchangeable:
 * a review comment lives in a thread on the diff, an issue comment on the
 * conversation. The caller says which because only it knows where the
 * comment was rendered.
 */
export async function deleteComment(id: string, kind: 'review' | 'issue'): Promise<void> {
  await ghGraphql(
    kind === 'review' ? DELETE_REVIEW_COMMENT_MUTATION : DELETE_ISSUE_COMMENT_MUTATION,
    { id }
  );
}

export async function setThreadResolved(threadId: string, resolved: boolean): Promise<PrThreadState> {
  const data = await ghGraphql<any>(
    resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION,
    { threadId }
  );
  const thread = resolved ? data?.resolveReviewThread?.thread : data?.unresolveReviewThread?.thread;
  return {
    isResolved: thread?.isResolved === true,
    viewerCanResolve: thread?.viewerCanResolve === true,
    viewerCanUnresolve: thread?.viewerCanUnresolve === true,
    viewerCanReply: thread?.viewerCanReply === true,
  };
}

export async function setFileViewed(pullRequestId: string, path: string, viewed: boolean): Promise<void> {
  await ghGraphql(viewed ? MARK_FILE_VIEWED_MUTATION : UNMARK_FILE_VIEWED_MUTATION, { pullRequestId, path });
}

export async function mergePullRequest(pullRequestId: string, options: PrMergeOptions): Promise<void> {
  await ghGraphql(MERGE_MUTATION, {
    pullRequestId,
    method: options.method,
    // Rebase takes no commit message: the commits keep their own.
    headline: options.method === 'REBASE' ? null : (options.commitHeadline || null),
    body: options.method === 'REBASE' ? null : (options.commitBody || null),
  });
}

export async function setAutoMerge(
  pullRequestId: string, enabled: boolean, options?: PrMergeOptions
): Promise<PrAutoMerge | null> {
  if (!enabled) {
    await ghGraphql(DISABLE_AUTO_MERGE_MUTATION, { pullRequestId });
    return null;
  }
  const method = options?.method ?? 'MERGE';
  const data = await ghGraphql<any>(ENABLE_AUTO_MERGE_MUTATION, {
    pullRequestId,
    method,
    headline: method === 'REBASE' ? null : (options?.commitHeadline || null),
    body: method === 'REBASE' ? null : (options?.commitBody || null),
  });
  return toAutoMerge(data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest);
}

export async function setDraft(pullRequestId: string, draft: boolean): Promise<boolean> {
  const data = await ghGraphql<any>(
    draft ? CONVERT_TO_DRAFT_MUTATION : READY_FOR_REVIEW_MUTATION,
    { pullRequestId }
  );
  const pr = draft
    ? data?.convertPullRequestToDraft?.pullRequest
    : data?.markPullRequestReadyForReview?.pullRequest;
  return pr?.isDraft === true;
}

export async function closePullRequest(pullRequestId: string): Promise<string> {
  const data = await ghGraphql<any>(CLOSE_PR_MUTATION, { pullRequestId });
  return data?.closePullRequest?.pullRequest?.state ?? 'CLOSED';
}

/**
 * Replace the reviewer set.
 *
 * `requestReviewsByLogin` has replace-set semantics, so add, remove and
 * re-request all submit the complete desired set — never a delta. Users and
 * teams stay separate because the mutation takes them separately.
 */
export async function setReviewers(
  pullRequestId: string, userLogins: string[], teamSlugs: string[]
): Promise<PrSummary['reviewers']> {
  const data = await ghGraphql<any>(SET_REVIEWERS_MUTATION, {
    pullRequestId,
    userLogins,
    // Must be `org/team-slug`; the API rejects a bare slug.
    teamSlugs,
    union: false,
  });
  const pr = data?.requestReviewsByLogin?.pullRequest;
  return buildReviewers(pr?.reviewRequests?.nodes, pr?.latestReviews?.nodes);
}
