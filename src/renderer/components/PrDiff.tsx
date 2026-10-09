import React, { useMemo } from 'react';
import { PrCommentAnchor, PrDetail, PrLineCommentAnchor } from '../../main/types';
import {
  DiffViewMode, commentCountsByFile, commitCommentPosition, countCommentsByFile, diffRefKey, diffRefOptions,
  threadsForCommit, threadsForFile, useGitHubStore,
} from '../stores/githubStore';
import { cn } from '../utils/cn';
import DiffFileView, { DiffCommentMode } from './DiffFileView';
import DiffFileTree from './DiffFileTree';
import DiffRefPicker from './DiffRefPicker';

interface Props {
  detail: PrDetail;
}

/**
 * The Diff subtab (requirement 3.2.3).
 *
 * GitHub-synced viewed state is full-PR-mode only. A single commit of the
 * pull request can be commented on too, pinned to that commit, and shows the
 * threads written against it; a force-push range shows neither, because its
 * end commit need not belong to the pull request any more.
 */
export default function PrDiff({ detail }: Props): React.ReactElement {
  const diffRef = useGitHubStore((s) => s.diffRef);
  const diff = useGitHubStore((s) => s.diff);
  const loading = useGitHubStore((s) => s.diffLoading);
  const error = useGitHubStore((s) => s.diffError);
  const selectedPath = useGitHubStore((s) => s.selectedPath);
  const viewMode = useGitHubStore((s) => s.viewMode);
  const localViewed = useGitHubStore((s) => s.localViewed);
  const setDiffRef = useGitHubStore((s) => s.setDiffRef);
  const setSelectedPath = useGitHubStore((s) => s.setSelectedPath);
  const setViewMode = useGitHubStore((s) => s.setViewMode);
  const toggleViewed = useGitHubStore((s) => s.toggleViewed);
  const run = useGitHubStore((s) => s.run);
  const addThread = useGitHubStore((s) => s.addThread);
  const bumpPendingCount = useGitHubStore((s) => s.bumpPendingCount);
  const patchSummary = useGitHubStore((s) => s.patchSummary);

  const options = diffRefOptions(detail);
  const currentKey = diffRefKey(diffRef);
  const isFullPr = diffRef.kind === 'pr';
  const commitOid = diffRef.kind === 'commit' && detail.commits.some((c) => c.oid === diffRef.oid)
    ? diffRef.oid
    : null;
  const commentMode: DiffCommentMode = isFullPr ? 'pr' : commitOid ? 'commit' : null;
  const pendingReviewId = detail.summary.pendingReview?.id ?? null;

  const commitThreads = useMemo(
    () => (commitOid && diff ? threadsForCommit(detail.threads, commitOid, diff.files) : []),
    [commitOid, diff, detail.threads]
  );

  // Empty in range mode: no thread renders there, so a count would promise
  // discussion the diff does not show.
  const commentCounts = useMemo(
    () => (isFullPr ? commentCountsByFile(detail.threads) : countCommentsByFile(commitThreads)),
    [isFullPr, detail.threads, commitThreads]
  );

  const file = diff?.files.find((f) => f.path === selectedPath) ?? null;
  const threads = isFullPr
    ? threadsForFile(detail.threads, selectedPath)
    : commitThreads.filter((t) => t.path === selectedPath);
  const shownThreadIds = new Set(threads.map((t) => t.id));
  const hiddenThreadCount = isFullPr
    ? 0
    : detail.threads.filter((t) => !t.isOutdated && t.path === selectedPath && !shownThreadIds.has(t.id)).length;

  const pinToCommit = async (anchor: PrLineCommentAnchor, oid: string): Promise<PrCommentAnchor> => {
    const { owner, repo, number } = detail.summary;
    const position = await commitCommentPosition(
      { owner, repo, number }, detail.summary.baseRefOid, oid, anchor.path, anchor.line
    );
    if (position === null) {
      throw new Error(
        'That line is not part of the pull request\'s changes as of this commit, so GitHub cannot '
          + 'anchor a comment to it. Comment from the full PR diff instead.'
      );
    }
    return { path: anchor.path, commitOid: oid, position, line: anchor.line };
  };

  /**
   * A diff comment always lands in a pending review, never on its own.
   *
   * When none is open, GitHub creates one implicitly and returns its id; the
   * session is armed against it so every later comment joins the same review
   * and the header's SUBMIT REVIEW becomes available.
   *
   * Resolves to whether it was posted, so a failed comment keeps its text.
   */
  const postComment = async (anchor: PrCommentAnchor, body: string): Promise<boolean> => {
    const result = await run(async () => {
      const target = commitOid && 'side' in anchor ? await pinToCommit(anchor, commitOid) : anchor;
      return window.dad.githubAddReviewComment(detail.summary.id, pendingReviewId, target, body);
    });
    if (!result) return false;

    addThread(result.thread);

    if (pendingReviewId) {
      bumpPendingCount(1);
    } else if (result.pendingReviewId) {
      patchSummary({ pendingReview: { id: result.pendingReviewId, body: '', commentCount: 1 } });
    }
    return true;
  };

  return (
    <div className="pr-diff">
      <div className="pr-diff__toolbar">
        <DiffRefPicker
          options={options}
          activeKey={
            currentKey === 'pr'
              ? 'pr'
              : options.find((o) => o.ref && diffRefKey(o.ref) === currentKey)?.key ?? 'pr'
          }
          onSelect={setDiffRef}
        />

        <div className="pr-diff__modes">
          {(['unified', 'split'] as DiffViewMode[]).map((mode) => (
            <button
              key={mode}
              className={cn('btn', 'btn--micro', viewMode === mode && 'btn--primary')}
              onClick={() => setViewMode(mode)}
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="panel-error">{error}</div>}

      <div className="pr-diff__body">
        <div className="pr-diff__files">
          {loading && <div className="pr-diff__files-status">LOADING…</div>}
          {diff?.truncated && (
            <div className="pr-diff__files-status">
              File list truncated by GitHub ({diff.files.length} of {detail.summary.changedFiles}).
            </div>
          )}
          {diff && diff.files.length > 0 && (
            <DiffFileTree
              files={diff.files}
              selectedPath={selectedPath}
              diffRef={diffRef}
              localViewed={localViewed}
              commentCounts={commentCounts}
              onSelect={setSelectedPath}
              onToggleViewed={(path, viewed) => void toggleViewed(path, viewed)}
            />
          )}
          {!loading && diff?.files.length === 0 && <div className="pr-diff__files-status">No files</div>}
        </div>

        <div className="pr-diff__viewer">
          {hiddenThreadCount > 0 && (
            <div className="pr-diff__thread-notice">
              {hiddenThreadCount} thread{hiddenThreadCount === 1 ? '' : 's'} on this file not shown here — switch
              to the full PR diff to read {hiddenThreadCount === 1 ? 'it' : 'them'}.
            </div>
          )}
          {file ? (
            <DiffFileView
              key={`${currentKey}:${file.path}`}
              file={file}
              mode={viewMode}
              threads={threads}
              commentMode={commentMode}
              pendingReviewId={pendingReviewId}
              onComment={postComment}
            />
          ) : (
            <div className="pr-diff__placeholder">{loading ? 'LOADING…' : 'Select a file'}</div>
          )}
        </div>
      </div>
    </div>
  );
}
