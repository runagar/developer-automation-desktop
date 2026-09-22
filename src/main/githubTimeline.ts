/**
 * Pull request timeline normalisation.
 *
 * Pure: no I/O, so the whitelist and the expansion rules are asserted in tests
 * rather than argued about.
 *
 * `PullRequestTimelineItemsItemType` has 82 members; 27 are kept. The list is
 * a whitelist rather than a blacklist because GitHub adds members without
 * warning and a new one must default to hidden, not to a row rendered as
 * "undefined".
 */

import { PrCommit, PrForcePush, PrReviewComment, PrTimelineRow } from './types';

/**
 * The event types requested from GitHub and rendered in the Overview.
 *
 * Seven entries go beyond the literal whitelist agreed in the feature plan,
 * each because another requirement is incoherent without it: the `UN*`/`DE*`
 * inverses (a history showing only additions lies), `PULL_REQUEST_REVIEW_THREAD`
 * (outdated threads surface here), `REVIEW_DISMISSED_EVENT` (dismissal is a
 * first-class reviewer state), `AUTO_MERGE_*` and `*_MERGE_QUEUE_EVENT` (the
 * user can toggle exactly those, and an action with no trace reads as a
 * no-op), and the `BASE_REF_*` pair (either silently changes what the diff
 * means).
 */
/**
 * The timeline entries DAD renders, as `__typename` → enum name.
 *
 * Both spellings are needed and they are NOT interchangeable: the query's
 * `itemTypes` argument takes `PullRequestTimelineItemsItemType` enum members
 * (`REVIEW_REQUESTED_EVENT`), while the response's `__typename` is the object
 * type (`ReviewRequestedEvent`). Keeping them in one map is what stops the two
 * drifting — checking a response against the enum spelling silently discards
 * every node and renders an empty history.
 *
 * Seven entries go beyond the literal whitelist agreed in the feature plan,
 * each because another requirement is incoherent without it: the `UN*`/`DE*`
 * inverses (a history showing only additions lies), `PullRequestReviewThread`
 * (outdated threads surface here), `ReviewDismissedEvent` (dismissal is a
 * first-class reviewer state), the auto-merge pair (the user can toggle
 * exactly those, and an action with no trace reads as a no-op), the
 * merge-queue pair (read-only: DAD no longer offers the toggle, but a queue
 * configured on GitHub would otherwise rewrite history invisibly), and the
 * base-ref pair (either silently changes what the diff means).
 */
const TIMELINE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  PullRequestCommit: 'PULL_REQUEST_COMMIT',
  PullRequestReview: 'PULL_REQUEST_REVIEW',
  PullRequestReviewThread: 'PULL_REQUEST_REVIEW_THREAD',
  HeadRefForcePushedEvent: 'HEAD_REF_FORCE_PUSHED_EVENT',
  BaseRefChangedEvent: 'BASE_REF_CHANGED_EVENT',
  BaseRefForcePushedEvent: 'BASE_REF_FORCE_PUSHED_EVENT',
  ReviewRequestedEvent: 'REVIEW_REQUESTED_EVENT',
  ReviewRequestRemovedEvent: 'REVIEW_REQUEST_REMOVED_EVENT',
  ReviewDismissedEvent: 'REVIEW_DISMISSED_EVENT',
  AssignedEvent: 'ASSIGNED_EVENT',
  UnassignedEvent: 'UNASSIGNED_EVENT',
  LabeledEvent: 'LABELED_EVENT',
  UnlabeledEvent: 'UNLABELED_EVENT',
  MilestonedEvent: 'MILESTONED_EVENT',
  DemilestonedEvent: 'DEMILESTONED_EVENT',
  ReadyForReviewEvent: 'READY_FOR_REVIEW_EVENT',
  ConvertToDraftEvent: 'CONVERT_TO_DRAFT_EVENT',
  ConvertedFromDraftEvent: 'CONVERTED_FROM_DRAFT_EVENT',
  RenamedTitleEvent: 'RENAMED_TITLE_EVENT',
  MergedEvent: 'MERGED_EVENT',
  ClosedEvent: 'CLOSED_EVENT',
  ReopenedEvent: 'REOPENED_EVENT',
  IssueComment: 'ISSUE_COMMENT',
  AutoMergeEnabledEvent: 'AUTO_MERGE_ENABLED_EVENT',
  AutoMergeDisabledEvent: 'AUTO_MERGE_DISABLED_EVENT',
  AddedToMergeQueueEvent: 'ADDED_TO_MERGE_QUEUE_EVENT',
  RemovedFromMergeQueueEvent: 'REMOVED_FROM_MERGE_QUEUE_EVENT',
});

/** Enum members for the query's `itemTypes` argument. */
export const TIMELINE_ITEM_TYPES: readonly string[] = Object.freeze(Object.values(TIMELINE_TYPES));

/** `__typename` values accepted when rendering the response. */
export const TIMELINE_TYPENAMES: ReadonlySet<string> = new Set(Object.keys(TIMELINE_TYPES));

interface RawNode {
  __typename?: string;
  id?: string;
  createdAt?: string;
  actor?: { login?: string } | null;
  [key: string]: unknown;
}

function login(value: unknown): string | null {
  const node = value as { login?: string } | null | undefined;
  return node?.login ?? null;
}

function reviewerName(value: unknown): string {
  const node = value as { __typename?: string; login?: string; slug?: string } | null | undefined;
  if (!node) return 'someone';
  return node.slug ?? node.login ?? 'someone';
}

export function commitFromNode(value: unknown): PrCommit | null {
  const c = value as {
    oid?: string; abbreviatedOid?: string; messageHeadline?: string;
    committedDate?: string; author?: { name?: string; user?: { login?: string } };
  } | null | undefined;
  if (!c?.oid) return null;
  return {
    oid: c.oid,
    abbreviatedOid: c.abbreviatedOid ?? c.oid.slice(0, 7),
    messageHeadline: c.messageHeadline ?? '',
    committedDate: c.committedDate ?? '',
    author: c.author?.user?.login ?? c.author?.name ?? null,
  };
}

/**
 * Merge paged connection results.
 *
 * De-duplicates on node id because a write landing between two page fetches
 * shifts the cursor window and can repeat a node.
 */
export function mergePages<T extends { id?: string }>(pages: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const node of page) {
      if (!node) continue;
      const id = node.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(node);
    }
  }
  return out;
}

export interface NormalizedTimeline {
  rows: PrTimelineRow[];
  forcePushes: PrForcePush[];
}

/**
 * Turn raw timeline nodes into rendered rows.
 *
 * A `PullRequestCommit` node is already one commit, so a push of five commits
 * arrives as five nodes and becomes five rows. A force push contributes one
 * extra before…after range row (ambiguity 21).
 */
export function normalizeTimeline(nodes: unknown[]): NormalizedTimeline {
  const rows: PrTimelineRow[] = [];
  const forcePushes: PrForcePush[] = [];

  for (const raw of nodes ?? []) {
    const node = raw as RawNode;
    if (!node || typeof node !== 'object') continue;
    const type = node.__typename;
    if (!type || !TIMELINE_TYPENAMES.has(type)) continue;

    const id = node.id ?? `${type}-${rows.length}`;
    const at = (node.createdAt as string) ?? '';
    const actor = login(node.actor);

    switch (type) {
      case 'PullRequestCommit': {
        const commit = commitFromNode(node.commit);
        if (commit) rows.push({ kind: 'commit', id, at: commit.committedDate, commit });
        break;
      }

      case 'HeadRefForcePushedEvent': {
        const before = node.beforeCommit as { oid?: string; abbreviatedOid?: string } | null;
        const after = node.afterCommit as { oid?: string; abbreviatedOid?: string } | null;
        if (!after?.oid) break;
        const force: PrForcePush = {
          id,
          createdAt: at,
          actor,
          // `beforeCommit` is null once the commit has been garbage-collected;
          // the range is then unusable and the row renders disabled.
          beforeOid: before?.oid ?? null,
          beforeAbbrev: before?.abbreviatedOid ?? before?.oid?.slice(0, 7) ?? null,
          afterOid: after.oid,
          afterAbbrev: after.abbreviatedOid ?? after.oid.slice(0, 7),
        };
        forcePushes.push(force);
        rows.push({ kind: 'force-push', id, at, actor, force });
        break;
      }

      case 'IssueComment':
        rows.push({
          kind: 'comment',
          id,
          at,
          author: login(node.author),
          body: (node.body as string) ?? '',
          viewerDidAuthor: node.viewerDidAuthor === true,
          viewerCanDelete: node.viewerCanDelete === true,
        });
        break;

      case 'PullRequestReview': {
        const state = (node.state as string) ?? '';
        const body = (node.body as string) ?? '';
        // A PENDING review is the viewer's own unsent draft; it belongs in the
        // composer, not in the public history.
        if (state === 'PENDING') break;

        const raw = (node.comments as { totalCount?: number; nodes?: RawNode[] } | undefined);
        const nodes = raw?.nodes ?? [];
        const comments: PrReviewComment[] = nodes.map((c) => ({
          id: (c.id as string) ?? '',
          path: (c.path as string) ?? '',
          // `line` is null once the anchor no longer exists; `originalLine`
          // still says where the comment was written.
          line: (c.line as number | null) ?? (c.originalLine as number | null) ?? null,
          body: (c.body as string) ?? '',
          viewerCanDelete: c.viewerCanDelete === true,
        }));

        // A review that requests changes often has no body at all and says
        // everything inline, so dropping these would leave the row empty.
        rows.push({
          kind: 'review',
          id,
          at,
          author: login(node.author),
          state,
          body,
          comments,
          moreComments: Math.max(0, (raw?.totalCount ?? nodes.length) - nodes.length),
        });
        break;
      }

      case 'PullRequestReviewThread': {
        // Only outdated threads surface here — a live thread is rendered
        // inline in the diff instead (ambiguity 28).
        if (node.isOutdated !== true) break;
        const comments = (node.comments as { nodes?: RawNode[] } | undefined)?.nodes ?? [];
        const first = comments[0];
        if (!first) break;
        rows.push({
          kind: 'outdated-thread',
          id,
          at: (first.createdAt as string) ?? at,
          author: login(first.author),
          path: (node.path as string) ?? '',
          body: (first.body as string) ?? '',
          isResolved: node.isResolved === true,
        });
        break;
      }

      default:
        rows.push({ kind: 'event', id, at, actor, text: eventText(type, node) });
        break;
    }
  }

  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { rows, forcePushes };
}

/** Human wording for the whitelisted events that render as a single line. */
function eventText(type: string, node: RawNode): string {
  switch (type) {
    case 'BaseRefChangedEvent':
      return `changed the base branch from ${node.previousRefName ?? '?'} to ${node.currentRefName ?? '?'}`;
    case 'BaseRefForcePushedEvent':
      return 'force-pushed the base branch';
    case 'ReviewRequestedEvent':
      return `requested a review from ${reviewerName(node.requestedReviewer)}`;
    case 'ReviewRequestRemovedEvent':
      return `removed the review request for ${reviewerName(node.requestedReviewer)}`;
    case 'ReviewDismissedEvent':
      return node.dismissalMessage
        ? `dismissed a review: ${node.dismissalMessage}`
        : 'dismissed a review';
    case 'AssignedEvent':
      return `assigned ${reviewerName(node.assignee)}`;
    case 'UnassignedEvent':
      return `unassigned ${reviewerName(node.assignee)}`;
    case 'LabeledEvent':
      return `added the label ${labelName(node.label)}`;
    case 'UnlabeledEvent':
      return `removed the label ${labelName(node.label)}`;
    case 'MilestonedEvent':
      return `added this to the ${node.milestoneTitle ?? '?'} milestone`;
    case 'DemilestonedEvent':
      return `removed this from the ${node.milestoneTitle ?? '?'} milestone`;
    case 'ReadyForReviewEvent':
      return 'marked this ready for review';
    case 'ConvertToDraftEvent':
      return 'converted this to a draft';
    case 'ConvertedFromDraftEvent':
      return 'converted this from a draft';
    case 'RenamedTitleEvent':
      return `renamed this from "${node.previousTitle ?? ''}" to "${node.currentTitle ?? ''}"`;
    case 'MergedEvent':
      return `merged this into ${node.mergeRefName ?? 'the base branch'}`;
    case 'ClosedEvent':
      return 'closed this pull request';
    case 'ReopenedEvent':
      return 'reopened this pull request';
    case 'AutoMergeEnabledEvent':
      return 'enabled auto-merge';
    case 'AutoMergeDisabledEvent':
      return node.reason ? `disabled auto-merge: ${node.reason}` : 'disabled auto-merge';
    case 'AddedToMergeQueueEvent':
      return 'added this to the merge queue';
    case 'RemovedFromMergeQueueEvent':
      return node.reason ? `removed this from the merge queue: ${node.reason}` : 'removed this from the merge queue';
    default:
      // Unreachable while the map and the switch agree; renders something
      // sane rather than nothing if they ever do not.
      return type.replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }
}

function labelName(value: unknown): string {
  return (value as { name?: string } | null)?.name ?? '?';
}
