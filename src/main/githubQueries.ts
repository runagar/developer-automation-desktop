/**
 * GraphQL documents for the GitHub integration.
 *
 * Kept out of the operation modules so a query growing a field stays a
 * readable diff, and so every document is in one place when GitHub deprecates
 * something.
 */

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/** The reviewer-state source for both the list rows and the viewer header. */
const REVIEW_STATE_FIELDS = `
  reviewRequests(first: 50) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        # combinedSlug is the org/team-slug form; the bare slug is not
        # accepted by requestReviewsByLogin.
        ... on Team { slug combinedSlug }
        ... on Bot { login }
      }
    }
  }
  latestReviews(first: 50) {
    nodes {
      state
      author { login }
    }
  }
`;

/** Badge fields for a row in "Your Pull Requests" (requirement 2.1.3.3). */
const PR_BADGE_FIELDS = `
  id
  number
  title
  url
  isDraft
  mergeable
  mergeStateStatus
  reviewDecision
  updatedAt
  repository { nameWithOwner owner { login } name }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { state } } }
  }
  ${REVIEW_STATE_FIELDS}
`;

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/**
 * Badge + reviewer detail for a batch of pull requests found by search.
 *
 * Chunked by the caller: one document asking for `statusCheckRollup` across
 * every match can exceed GitHub's node/complexity budget.
 */
export const PR_BADGES_QUERY = `
query PrBadges($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      ${PR_BADGE_FIELDS}
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Single pull request
// ---------------------------------------------------------------------------

/**
 * Scalars and small collections only.
 *
 * Commits, timeline and review threads are connections that cap at 100 nodes,
 * so they are paginated separately rather than truncated here.
 */
export const PR_SUMMARY_QUERY = `
query PrSummary($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    pullRequest(number: $number) {
      id
      number
      title
      body
      url
      state
      isDraft
      merged
      mergeable
      mergeStateStatus
      reviewDecision
      changedFiles
      createdAt
      updatedAt
      author { login avatarUrl }
      baseRefName
      headRefName
      baseRefOid
      headRefOid
      headRepository { nameWithOwner owner { login } }
      isCrossRepository
      viewerCanUpdate
      viewerDidAuthor
      viewerMergeHeadlineText
      viewerMergeBodyText
      autoMergeRequest {
        enabledAt
        mergeMethod
        enabledBy { login }
      }
      labels(first: 50) { nodes { name color } }
      assignees(first: 25) { nodes { login } }
      milestone { title }
      commits(last: 1) {
        totalCount
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                totalCount
                nodes {
                  __typename
                  # The rollup is a union of GitHub Actions runs and external
                  # integrations (Snyk, SonarQube); the two carry their name
                  # and outcome under different field names.
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    # Requiredness is branch-protection-dependent, hence the
                    # pull request argument.
                    isRequired(pullRequestNumber: $number)
                  }
                  ... on StatusContext {
                    context
                    state
                    isRequired(pullRequestNumber: $number)
                  }
                }
              }
            }
          }
        }
      }
      ${REVIEW_STATE_FIELDS}
      suggestedReviewers { reviewer { login } }
      reviews(last: 1, states: [PENDING]) {
        nodes {
          id
          body
          comments { totalCount }
        }
      }
    }
  }
}
`;

/**
 * Ahead/behind for requirement 3.3.8.
 *
 * Deliberately a *separate* document. `baseRef.compare(headRef:)` reports an
 * unresolvable ref as a top-level `errors[]` entry even though `data` is
 * present, and `ghGraphql` — rightly — throws on `errors[]`. Folding this into
 * the summary would therefore make the entire pull request fail to load for
 * every cross-repository (fork) PR, whose head branch the base repository
 * cannot resolve. Forks go through `compareViaRest` instead.
 */
export const PR_COMPARE_QUERY = `
query PrCompare($owner: String!, $repo: String!, $number: Int!, $headRefName: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      baseRef {
        compare(headRef: $headRefName) {
          aheadBy
          behindBy
          status
        }
      }
    }
  }
}
`;

export const PR_COMMITS_QUERY = `
query PrCommits($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          commit {
            oid
            abbreviatedOid
            messageHeadline
            committedDate
            author { name user { login } }
          }
        }
      }
    }
  }
}
`;

export const PR_TIMELINE_QUERY = `
query PrTimeline($owner: String!, $repo: String!, $number: Int!, $cursor: String, $types: [PullRequestTimelineItemsItemType!]) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $cursor, itemTypes: $types) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on PullRequestCommit {
            id
            commit {
              oid
              abbreviatedOid
              messageHeadline
              committedDate
              author { name user { login } }
            }
          }
          ... on HeadRefForcePushedEvent {
            id
            createdAt
            actor { login }
            beforeCommit { oid abbreviatedOid }
            afterCommit { oid abbreviatedOid }
          }
          ... on BaseRefForcePushedEvent {
            id
            createdAt
            actor { login }
            beforeCommit { oid abbreviatedOid }
            afterCommit { oid abbreviatedOid }
          }
          ... on BaseRefChangedEvent {
            id
            createdAt
            actor { login }
            previousRefName
            currentRefName
          }
          ... on IssueComment {
            id
            createdAt
            body
            author { login }
            viewerDidAuthor
            viewerCanDelete
          }
          ... on PullRequestReview {
            id
            createdAt
            state
            body
            author { login }
            # A review that requests changes commonly carries an empty body and
            # says everything in its inline comments. Without these the
            # Overview shows "changes requested" and none of the substance.
            comments(first: 50) {
              totalCount
              nodes {
                id
                path
                line
                originalLine
                diffHunk
                body
                viewerCanDelete
              }
            }
          }
          ... on PullRequestReviewThread {
            id
            isResolved
            isOutdated
            path
            comments(first: 1) {
              nodes { id createdAt body author { login } }
            }
          }
          ... on ReviewDismissedEvent { id createdAt actor { login } dismissalMessage }
          ... on ReviewRequestedEvent {
            id
            createdAt
            actor { login }
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug }
              ... on Bot { login }
            }
          }
          ... on ReviewRequestRemovedEvent {
            id
            createdAt
            actor { login }
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug }
              ... on Bot { login }
            }
          }
          ... on AssignedEvent { id createdAt actor { login } assignee { ... on User { login } } }
          ... on UnassignedEvent { id createdAt actor { login } assignee { ... on User { login } } }
          ... on LabeledEvent { id createdAt actor { login } label { name color } }
          ... on UnlabeledEvent { id createdAt actor { login } label { name color } }
          ... on MilestonedEvent { id createdAt actor { login } milestoneTitle }
          ... on DemilestonedEvent { id createdAt actor { login } milestoneTitle }
          ... on ReadyForReviewEvent { id createdAt actor { login } }
          ... on ConvertToDraftEvent { id createdAt actor { login } }
          ... on ConvertedFromDraftEvent { id createdAt actor { login } }
          ... on RenamedTitleEvent { id createdAt actor { login } previousTitle currentTitle }
          ... on MergedEvent { id createdAt actor { login } mergeRefName commit { oid abbreviatedOid } }
          ... on ClosedEvent { id createdAt actor { login } }
          ... on ReopenedEvent { id createdAt actor { login } }
          ... on AutoMergeEnabledEvent { id createdAt actor { login } }
          ... on AutoMergeDisabledEvent { id createdAt actor { login } reason }
          ... on AddedToMergeQueueEvent { id createdAt actor { login } }
          ... on RemovedFromMergeQueueEvent { id createdAt actor { login } reason }
        }
      }
    }
  }
}
`;

export const PR_REVIEW_THREADS_QUERY = `
query PrReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          isCollapsed
          viewerCanResolve
          viewerCanUnresolve
          viewerCanReply
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          comments(first: 50) {
            nodes {
              id
              databaseId
              body
              createdAt
              state
              author { login }
              viewerDidAuthor
              outdated
              viewerCanDelete
            }
          }
        }
      }
    }
  }
}
`;

/** Viewed state is defined against the full PR diff only (ambiguity 27). */
export const PR_FILE_VIEWED_QUERY = `
query PrFileViewed($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const SUBMIT_REVIEW_MUTATION = `
mutation SubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
    pullRequestReview { id state submittedAt }
  }
}
`;

/**
 * A standalone review, used when the user approves or requests changes without
 * having started one. `addPullRequestReview` with an `event` submits directly.
 */
export const SUBMIT_STANDALONE_REVIEW_MUTATION = `
mutation SubmitStandaloneReview($pullRequestId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, event: $event, body: $body }) {
    pullRequestReview { id state submittedAt }
  }
}
`;

export const DISCARD_REVIEW_MUTATION = `
mutation DiscardReview($reviewId: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) {
    pullRequestReview { id }
  }
}
`;

/**
 * A diff-anchored thread.
 *
 * `pullRequestReviewId` is optional: present, the thread is held as pending;
 * absent, it is published immediately (requirement 3.4's second sentence).
 */
export const ADD_REVIEW_THREAD_MUTATION = `
mutation AddReviewThread(
  $pullRequestId: ID!
  $reviewId: ID
  $path: String!
  $body: String!
  $line: Int!
  $side: DiffSide!
  $startLine: Int
  $startSide: DiffSide
) {
  addPullRequestReviewThread(input: {
    pullRequestId: $pullRequestId
    pullRequestReviewId: $reviewId
    path: $path
    body: $body
    line: $line
    side: $side
    startLine: $startLine
    startSide: $startSide
  }) {
    thread {
      id
      isResolved
      isOutdated
      path
      line
      startLine
      diffSide
      viewerCanResolve
      viewerCanUnresolve
      viewerCanReply
      comments(first: 50) {
        nodes {
          id
          databaseId
          body
          createdAt
          state
          author { login }
          viewerDidAuthor
          outdated
          viewerCanDelete
          # The review this comment landed in, and whether it still needs
          # submitting. Adding a thread with no review id creates a PENDING
          # review, whereas a reply is published outright — so the state has
          # to be checked, not assumed.
          pullRequestReview { id state }
        }
      }
    }
  }
}
`;

export const REPLY_THREAD_MUTATION = `
mutation ReplyThread($threadId: ID!, $body: String!, $reviewId: ID) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId
    body: $body
    pullRequestReviewId: $reviewId
  }) {
    comment {
      id
      databaseId
      body
      createdAt
      state
      author { login }
      viewerDidAuthor
      outdated
      viewerCanDelete
      pullRequestReview { id state }
    }
  }
}
`;

export const ADD_ISSUE_COMMENT_MUTATION = `
mutation AddIssueComment($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge {
      node { id createdAt body author { login } viewerDidAuthor }
    }
  }
}
`;

/**
 * The permissions are re-read, not just `isResolved`.
 *
 * GitHub reports `viewerCanUnresolve: false` while a thread is unresolved (and
 * `viewerCanResolve: false` once it is resolved), so patching only
 * `isResolved` leaves the stale permission behind and the opposite action
 * disappears from the UI.
 */
export const DELETE_REVIEW_COMMENT_MUTATION = `
mutation DeleteReviewComment($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) {
    pullRequestReview { id }
  }
}
`;

export const DELETE_ISSUE_COMMENT_MUTATION = `
mutation DeleteIssueComment($id: ID!) {
  deleteIssueComment(input: { id: $id }) {
    clientMutationId
  }
}
`;

export const RESOLVE_THREAD_MUTATION = `
mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved viewerCanResolve viewerCanUnresolve viewerCanReply }
  }
}
`;

export const UNRESOLVE_THREAD_MUTATION = `
mutation UnresolveThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved viewerCanResolve viewerCanUnresolve viewerCanReply }
  }
}
`;

export const MARK_FILE_VIEWED_MUTATION = `
mutation MarkFileViewed($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
    pullRequest { id }
  }
}
`;

export const UNMARK_FILE_VIEWED_MUTATION = `
mutation UnmarkFileViewed($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) {
    pullRequest { id }
  }
}
`;

export const MERGE_MUTATION = `
mutation MergePr($pullRequestId: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String) {
  mergePullRequest(input: {
    pullRequestId: $pullRequestId
    mergeMethod: $method
    commitHeadline: $headline
    commitBody: $body
  }) {
    pullRequest { id state merged mergedAt }
  }
}
`;

export const UPDATE_BRANCH_MUTATION = `
mutation UpdatePrBranch(
  $pullRequestId: ID!
  $expectedHeadOid: GitObjectID
  $method: PullRequestBranchUpdateMethod!
) {
  updatePullRequestBranch(input: {
    pullRequestId: $pullRequestId
    expectedHeadOid: $expectedHeadOid
    updateMethod: $method
  }) {
    pullRequest { id headRefOid }
  }
}
`;

export const ENABLE_AUTO_MERGE_MUTATION = `
mutation EnableAutoMerge($pullRequestId: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String) {
  enablePullRequestAutoMerge(input: {
    pullRequestId: $pullRequestId
    mergeMethod: $method
    commitHeadline: $headline
    commitBody: $body
  }) {
    pullRequest {
      id
      autoMergeRequest { enabledAt mergeMethod enabledBy { login } }
    }
  }
}
`;

export const DISABLE_AUTO_MERGE_MUTATION = `
mutation DisableAutoMerge($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id autoMergeRequest { enabledAt } }
  }
}
`;

export const CONVERT_TO_DRAFT_MUTATION = `
mutation ConvertToDraft($pullRequestId: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id isDraft }
  }
}
`;

export const READY_FOR_REVIEW_MUTATION = `
mutation ReadyForReview($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id isDraft }
  }
}
`;

export const CLOSE_PR_MUTATION = `
mutation ClosePr($pullRequestId: ID!) {
  closePullRequest(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id state }
  }
}
`;

/**
 * Replace-set semantics: the full desired reviewer set is submitted every
 * time, never a delta. Users and teams stay in separate collections because
 * the mutation takes them separately and a merged list cannot round-trip.
 */
export const SET_REVIEWERS_MUTATION = `
mutation SetReviewers($pullRequestId: ID!, $userLogins: [String!], $teamSlugs: [String!], $union: Boolean) {
  requestReviewsByLogin(input: {
    pullRequestId: $pullRequestId
    userLogins: $userLogins
    teamSlugs: $teamSlugs
    union: $union
  }) {
    pullRequest {
      id
      ${REVIEW_STATE_FIELDS}
    }
  }
}
`;
