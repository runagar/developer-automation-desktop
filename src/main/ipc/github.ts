import { IpcMain } from 'electron';
import { githubErrorMessage } from '../github';
import { listPullRequests } from '../githubPrs';
import {
  addIssueComment, addReviewComment, closePullRequest, deleteComment, discardReview, getDiff,
  getPullRequest, mergePullRequest, replyToThread, setAutoMerge, setDraft, setFileViewed,
  setReviewers, setThreadResolved, submitReview, updatePullRequestBranch,
} from '../githubPr';
import {
  PrBranchUpdateMethod, PrCommentAnchor, PrDiffRef, PrMergeOptions, PrRef, PrReviewEvent,
} from '../types';

/**
 * Wrap a handler so the renderer receives a message, never an error class.
 *
 * Same contract as `tokenErrorMessage` in `ipc/rest.ts`: `gh` missing, `gh`
 * unauthenticated and rate limiting each have their own wording, and anything
 * else is GitHub's own first line of stderr.
 */
function handled<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw new Error(githubErrorMessage(err));
    }
  };
}

export function registerGitHubHandlers(ipcMain: IpcMain, dataDir: string): void {
  // --- reads ---------------------------------------------------------------

  ipcMain.handle('github:listPullRequests', handled(() => listPullRequests(dataDir)));

  ipcMain.handle('github:getPullRequest', handled((_e, ref: PrRef) => getPullRequest(ref)));

  ipcMain.handle(
    'github:getDiff',
    handled((_e, ref: PrRef, diffRef: PrDiffRef, changedFiles: number) =>
      getDiff(ref, diffRef, changedFiles))
  );

  // --- review batching -----------------------------------------------------

  ipcMain.handle(
    'github:submitReview',
    handled((_e, pullRequestId: string, reviewId: string | null, event: PrReviewEvent, body: string) =>
      submitReview(pullRequestId, reviewId, event, body))
  );

  ipcMain.handle('github:discardReview', handled((_e, reviewId: string) => discardReview(reviewId)));

  /**
   * A diff-anchored comment.
   *
   * `reviewId` present joins the pending review; absent posts a standalone
   * thread, which is requirement 3.4's "posting a single comment outside of a
   * review must remain possible".
   */
  ipcMain.handle(
    'github:addReviewComment',
    handled((_e, pullRequestId: string, reviewId: string | null, anchor: PrCommentAnchor, body: string) =>
      addReviewComment(pullRequestId, reviewId, anchor, body))
  );

  ipcMain.handle(
    'github:replyThread',
    handled((_e, threadId: string, reviewId: string | null, body: string) =>
      replyToThread(threadId, reviewId, body))
  );

  /** Overview comments are issue comments: GitHub cannot defer them. */
  ipcMain.handle(
    'github:addComment',
    handled((_e, subjectId: string, body: string) => addIssueComment(subjectId, body))
  );

  ipcMain.handle(
    'github:deleteComment',
    handled((_e, id: string, kind: 'review' | 'issue') => deleteComment(id, kind))
  );

  ipcMain.handle(
    'github:setThreadResolved',
    handled((_e, threadId: string, resolved: boolean) => setThreadResolved(threadId, resolved))
  );

  ipcMain.handle(
    'github:setFileViewed',
    handled((_e, pullRequestId: string, path: string, viewed: boolean) =>
      setFileViewed(pullRequestId, path, viewed))
  );

  // --- pull request actions ------------------------------------------------

  ipcMain.handle(
    'github:merge',
    handled((_e, pullRequestId: string, options: PrMergeOptions) => mergePullRequest(pullRequestId, options))
  );

  ipcMain.handle(
    'github:updateBranch',
    handled((_e, pullRequestId: string, expectedHeadOid: string | null, method: PrBranchUpdateMethod) =>
      updatePullRequestBranch(pullRequestId, expectedHeadOid, method))
  );

  ipcMain.handle(
    'github:setAutoMerge',
    handled((_e, pullRequestId: string, enabled: boolean, options?: PrMergeOptions) =>
      setAutoMerge(pullRequestId, enabled, options))
  );

  ipcMain.handle(
    'github:setDraft',
    handled((_e, pullRequestId: string, draft: boolean) => setDraft(pullRequestId, draft))
  );

  ipcMain.handle('github:close', handled((_e, pullRequestId: string) => closePullRequest(pullRequestId)));

  ipcMain.handle(
    'github:setReviewers',
    handled((_e, pullRequestId: string, userLogins: string[], teamLogins: string[]) =>
      setReviewers(pullRequestId, userLogins, teamLogins))
  );
}
