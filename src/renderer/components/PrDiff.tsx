import React, { useMemo } from 'react';
import { PrCommentAnchor, PrDetail } from '../../main/types';
import {
  DiffViewMode, commentCountsByFile, diffRefKey, diffRefOptions, threadsForFile, useGitHubStore,
} from '../stores/githubStore';
import { cn } from '../utils/cn';
import DiffFileView from './DiffFileView';
import DiffFileTree from './DiffFileTree';
import DiffRefPicker from './DiffRefPicker';

interface Props {
  detail: PrDetail;
}

/**
 * The Diff subtab (requirement 3.2.3).
 *
 * Inline threads and GitHub-synced viewed state are full-PR-mode only: a
 * review comment anchors to a position in the *pull request* diff, so in
 * commit or range mode most threads have no line to attach to.
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
  const pendingReviewId = detail.summary.pendingReview?.id ?? null;

  // Empty outside full-PR mode: no thread renders there, so a count would
  // promise discussion the diff does not show.
  const commentCounts = useMemo(
    () => (isFullPr ? commentCountsByFile(detail.threads) : {}),
    [isFullPr, detail.threads]
  );

  const file = diff?.files.find((f) => f.path === selectedPath) ?? null;
  const threads = isFullPr ? threadsForFile(detail.threads, selectedPath) : [];
  const hiddenThreadCount = isFullPr
    ? 0
    : detail.threads.filter((t) => !t.isOutdated && t.path === selectedPath).length;

  /**
   * A diff comment always lands in a pending review, never on its own.
   *
   * When none is open, GitHub creates one implicitly and returns its id; the
   * session is armed against it so every later comment joins the same review
   * and the header's SUBMIT REVIEW becomes available.
   */
  const postComment = async (anchor: PrCommentAnchor, body: string): Promise<void> => {
    const result = await run(() =>
      window.dad.githubAddReviewComment(detail.summary.id, pendingReviewId, anchor, body));
    if (!result) return;

    addThread(result.thread);

    if (pendingReviewId) {
      bumpPendingCount(1);
    } else if (result.pendingReviewId) {
      patchSummary({ pendingReview: { id: result.pendingReviewId, body: '', commentCount: 1 } });
    }
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
              {hiddenThreadCount} thread{hiddenThreadCount === 1 ? '' : 's'} on this file — switch to the
              full PR diff to read {hiddenThreadCount === 1 ? 'it' : 'them'}.
            </div>
          )}
          {file ? (
            <DiffFileView
              key={`${currentKey}:${file.path}`}
              file={file}
              mode={viewMode}
              threads={threads}
              canComment={isFullPr}
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
