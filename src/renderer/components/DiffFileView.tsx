import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { PrCommentAnchor, PrDiffFile, PrLineCommentAnchor, PrReviewThread } from '../../main/types';
import {
  DiffLine, DiffHunk, DiffSide, MissingPatchReason, anchorForLine, anchorForRange, lineMatchesAnchor,
  missingPatchReason, parsePatch, toSplitRows,
} from '../../main/githubDiff';
import { DiffLineSelection, DiffViewMode, useGitHubStore } from '../stores/githubStore';
import { cn } from '../utils/cn';
import CommentThread from './CommentThread';
import CommentComposer from './CommentComposer';

/**
 * `pr` comments anywhere in the full PR diff. `commit` comments on one
 * right-hand line at a time, pinned to the commit shown: GitHub anchors those
 * by position in the pull request's diff as of the commit, which a left-hand
 * line of the commit's own diff has no reliable counterpart in, and which has
 * no way to express a range. `null` offers no commenting at all.
 */
export type DiffCommentMode = 'pr' | 'commit' | null;

interface Props {
  file: PrDiffFile;
  mode: DiffViewMode;
  /** Threads this view can place on this file. */
  threads: PrReviewThread[];
  commentMode: DiffCommentMode;
  pendingReviewId: string | null;
  /** Resolves to whether the comment was posted. */
  onComment: (anchor: PrCommentAnchor, body: string) => Promise<boolean>;
}

/** An in-progress drag from the `+` affordance, in one hunk. */
interface Drag {
  hunkIndex: number;
  from: number;
  to: number;
  /** The split-view column it started in; null in unified view. */
  side: DiffSide | null;
}

function gutter(line: DiffLine | null, side: 'old' | 'new'): string {
  if (!line) return '';
  const n = side === 'old' ? line.oldLine : line.newLine;
  return n === null ? '' : String(n);
}

function lineClass(kind: DiffLine['kind']): string {
  return `pr-diff__line pr-diff__line--${kind}`;
}

function inRange(range: { from: number; to: number } | null, index: number): boolean {
  if (!range) return false;
  return index >= Math.min(range.from, range.to) && index <= Math.max(range.from, range.to);
}

const MISSING_PATCH_LABELS: Record<MissingPatchReason, string> = {
  renamed: 'FILE RENAMED WITHOUT CHANGES',
  copied: 'FILE COPIED WITHOUT CHANGES',
  unavailable: 'DIFF NOT SHOWN (binary / too large)',
};

export default function DiffFileView({
  file, mode, threads, commentMode, pendingReviewId, onComment,
}: Props): React.ReactElement {
  const parsed = useMemo(() => parsePatch(file.patch), [file.patch]);

  /**
   * Restored non-reactively on mount.
   *
   * This component is keyed by file, so switching file — or switching subtab,
   * which unmounts the whole diff — would otherwise drop a comment the user
   * had started writing.
   */
  const [selection, setSelectionState] = useState<DiffLineSelection | null>(
    () => useGitHubStore.getState().diffSelections[file.path] ?? null
  );

  const [drag, setDrag] = useState<Drag | null>(null);
  // The mouseup listener is registered once per drag and must see the latest
  // extent without re-registering on every mousemove.
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const setSelection = (next: DiffLineSelection | null): void => {
    setSelectionState(next);
    useGitHubStore.getState().setDiffSelection(file.path, next);
  };

  const dragging = drag !== null;

  const fileDraftKey = `diff:${file.path}:FILE::`;
  const [fileComposerOpen, setFileComposerOpen] = useState(
    () => Boolean(useGitHubStore.getState().drafts[fileDraftKey])
  );
  const fileThreads = threads.filter((t) => t.subjectType === 'FILE');

  useEffect(() => {
    if (!dragging) return undefined;
    // Released anywhere, not just over the diff: a drag that ends outside the
    // panel must still commit rather than leave the rows stuck highlighted.
    function onMouseUp(): void {
      const d = dragRef.current;
      if (d) {
        setSelection({
          hunkIndex: d.hunkIndex,
          from: Math.min(d.from, d.to),
          to: Math.max(d.from, d.to),
          side: d.side,
        });
      }
      setDrag(null);
    }
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const fileRow = (key: string, content: React.ReactNode): React.ReactNode => (
    <div key={key} className="pr-diff__inline-row pr-diff__inline-row--file">
      <div className="pr-diff__inline-body">{content}</div>
    </div>
  );

  const fileHeader = (
    <>
      {(file.previousPath || commentMode) && (
        <div className="pr-diff__file-header">
          <span className="pr-diff__origin">
            {file.previousPath
              && `${file.status === 'copied' ? 'COPIED FROM' : 'RENAMED FROM'} ${file.previousPath}`}
          </span>
          {commentMode && !fileComposerOpen && (
            <button
              className="btn btn--micro"
              title="Comment on the file as a whole"
              onClick={() => setFileComposerOpen(true)}
            >
              COMMENT ON FILE
            </button>
          )}
        </div>
      )}
      {fileThreads.map((thread) => fileRow(
        thread.id,
        <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
      ))}
      {fileComposerOpen && fileRow(
        'file-composer',
        <CommentComposer
          draftKey={fileDraftKey}
          placeholder="Comment on this file…  (Ctrl+Enter to send, Esc to cancel)"
          submitLabel={pendingReviewId ? 'ADD TO REVIEW' : 'COMMENT'}
          autoFocus
          onSubmit={async (body) => {
            if (!(await onComment({ path: file.path, subjectType: 'FILE' }, body))) return false;
            setFileComposerOpen(false);
            return true;
          }}
          onCancel={() => setFileComposerOpen(false)}
        />
      )}
    </>
  );

  if (!file.patch) {
    // Pure renames, binary files and files past GitHub's size ceiling arrive
    // with no patch. They are still listed, so the file is not silently missing.
    return (
      <>
        {fileHeader}
        <div className="pr-diff__placeholder">{MISSING_PATCH_LABELS[missingPatchReason(file)]}</div>
      </>
    );
  }

  const threadsAt = (line: DiffLine): PrReviewThread[] => {
    const anchor = anchorForLine(line);
    if (!anchor) return [];
    return threads.filter(
      (t) => t.line === anchor.line && t.side === anchor.side && lineMatchesAnchor(line, anchor)
    );
  };

  const singleLine = commentMode === 'commit';

  /**
   * The `+` affordance.
   *
   * Mouse *down* starts a drag rather than click opening the composer, so a
   * single click and a drag are the same gesture — the click simply ends where
   * it began. `preventDefault` stops the browser beginning a text selection,
   * which is what keeps dragging here distinct from selecting the diff text.
   */
  const addButton = (
    hunkIndex: number, lineIndex: number, side: DiffSide | null, line: DiffLine
  ): React.ReactNode => {
    if (!commentMode) return null;
    if (singleLine && (line.kind === 'del' || side === 'LEFT')) return null;
    return (
      <button
        className="pr-diff__add-comment"
        title={singleLine ? 'Comment on this line of the commit' : 'Comment on this line — drag to cover several'}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDrag({ hunkIndex, from: lineIndex, to: lineIndex, side });
        }}
      >
        <Plus size={11} />
      </button>
    );
  };

  /** Extends an in-progress drag; clamped to the hunk and column it began in. */
  const extendDrag = (hunkIndex: number, lineIndex: number, side: DiffSide | null): void => {
    if (singleLine) return;
    setDrag((d) => (d && d.hunkIndex === hunkIndex && d.side === side ? { ...d, to: lineIndex } : d));
  };

  /**
   * True when the line at `lineIndex` is covered by the current selection.
   *
   * `side` is the column being painted: a selection made in one split-view
   * column must not light up the other, which shares the range's unified
   * indexes but was never swept over.
   */
  const highlighted = (hunkIndex: number, lineIndex: number, side: DiffSide | null): boolean => {
    const range = drag ?? selection;
    if (!range || range.hunkIndex !== hunkIndex || range.side !== side) return false;
    return inRange(range, lineIndex);
  };

  /**
   * The composer, rendered directly beneath the last line of the selection.
   *
   * Placed inline rather than at the foot of the hunk so the comment sits
   * against the code it refers to — losing that adjacency is most of what
   * makes a diff comment readable.
   *
   * `candidates` are the unified line indexes the row being rendered occupies
   * — one in unified view, up to two in split. Matching against all of them
   * matters in split view, where a deleted line paired with an added one has
   * the lower index of the two: keying off the higher one alone left a
   * selection on the left-hand column with nowhere to draw its composer.
   */
  const composerFor = (hunk: DiffHunk, hunkIndex: number, candidates: number[]): React.ReactNode => {
    if (!selection || selection.hunkIndex !== hunkIndex || drag) return null;
    if (!candidates.includes(Math.max(selection.from, selection.to))) return null;

    const range = anchorForRange(hunk, selection.from, selection.to, selection.side);
    const anchor: PrLineCommentAnchor | null = range ? { path: file.path, ...range } : null;

    if (!anchor) {
      return (
        <div className="panel-error">
          That selection cannot be commented on — a range must run from the old side to the new,
          never the other way round.
          <button className="btn btn--micro panel-error__retry" onClick={() => setSelection(null)}>
            DISMISS
          </button>
        </div>
      );
    }

    const multi = anchor.startLine !== null;

    return (
      <CommentComposer
          // Keyed by the exact anchor, so a draft on one line is not offered
          // when commenting on another.
          draftKey={`diff:${file.path}:${anchor.side}:${anchor.startLine ?? anchor.line}:${anchor.line}`}
          placeholder={
            multi
              ? `Comment on lines ${anchor.startLine}–${anchor.line}…  (Ctrl+Enter to send, Esc to cancel)`
              : `Comment on line ${anchor.line}${singleLine ? ' of this commit' : ''}…  (Ctrl+Enter to send, Esc to cancel)`
          }
          submitLabel={pendingReviewId ? 'ADD TO REVIEW' : 'COMMENT'}
          autoFocus
        onSubmit={async (body) => {
          if (!(await onComment(anchor, body))) return false;
          setSelection(null);
          return true;
        }}
        onCancel={() => setSelection(null)}
      />
    );
  };

  /**
   * Wraps inline content so it lands under the right-hand column in split
   * view, where the post-image lives — matching where the comment's anchor
   * actually is. Unified has one column, so it simply spans it.
   */
  const inlineRow = (key: string, content: React.ReactNode): React.ReactNode => (
    <div key={key} className={cn('pr-diff__inline-row', mode === 'split' && 'pr-diff__inline-row--split')}>
      <div className="pr-diff__inline-body">{content}</div>
    </div>
  );

  return (
    <div
      className={cn(
        'pr-diff__file',
        mode === 'split' && 'pr-diff__file--split',
        // Suppresses text selection for the duration of a drag, so dragging
        // the + does not also sweep-select the diff text under the pointer.
        dragging && 'pr-diff__file--dragging'
      )}
    >
      {fileHeader}
      {parsed.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}-${hunkIndex}`} className="pr-diff__hunk">
          <div className="pr-diff__hunk-header">{hunk.header}</div>

          {mode === 'unified'
            ? hunk.lines.map((line, lineIndex) => {
              const composer = composerFor(hunk, hunkIndex, [lineIndex]);
              return (
              <React.Fragment key={lineIndex}>
                <div
                  className={cn(
                    lineClass(line.kind),
                    highlighted(hunkIndex, lineIndex, null) && 'pr-diff__line--selected'
                  )}
                  onMouseEnter={dragging ? () => extendDrag(hunkIndex, lineIndex, null) : undefined}
                >
                  <span className="pr-diff__gutter">{gutter(line, 'old')}</span>
                  <span className="pr-diff__gutter">{gutter(line, 'new')}</span>
                  {addButton(hunkIndex, lineIndex, null, line)}
                  <span className="pr-diff__marker">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                  </span>
                  <span className="pr-diff__content">{line.content || '\u00a0'}</span>
                </div>
                {threadsAt(line).map((thread) => inlineRow(
                  thread.id,
                  <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
                ))}
                {composer && inlineRow(`composer-${lineIndex}`, composer)}
              </React.Fragment>
              );
            })
            : toSplitRows(hunk).map((row, rowIndex) => {
              const leftIndex = row.left ? hunk.lines.indexOf(row.left) : -1;
              const rightIndex = row.right ? hunk.lines.indexOf(row.right) : -1;
              // A thread or composer belongs to whichever side holds its
              // anchor; both are rendered beneath the pair.
              //
              // De-duplicated by id: `toSplitRows` puts the *same* DiffLine
              // object on both sides of a context row, so collecting from each
              // side would list every thread on an unchanged line twice.
              const rowThreads = [...new Map(
                [
                  ...(row.right ? threadsAt(row.right) : []),
                  ...(row.left ? threadsAt(row.left) : []),
                ].map((t) => [t.id, t])
              ).values()];
              const composer = composerFor(
                hunk, hunkIndex, [leftIndex, rightIndex].filter((i) => i >= 0)
              );

              return (
                <React.Fragment key={rowIndex}>
                <div className="pr-diff__split-row">
                  <div
                    className={cn(
                      'pr-diff__split-cell',
                      row.left && lineClass(row.left.kind),
                      leftIndex >= 0 && highlighted(hunkIndex, leftIndex, 'LEFT') && 'pr-diff__line--selected'
                    )}
                    onMouseEnter={dragging && leftIndex >= 0
                      ? () => extendDrag(hunkIndex, leftIndex, 'LEFT')
                      : undefined}
                  >
                    <span className="pr-diff__gutter">{gutter(row.left, 'old')}</span>
                    {row.left && leftIndex >= 0 && addButton(hunkIndex, leftIndex, 'LEFT', row.left)}
                    <span className="pr-diff__content">{row.left?.content || '\u00a0'}</span>
                  </div>
                  <div
                    className={cn(
                      'pr-diff__split-cell',
                      row.right && lineClass(row.right.kind),
                      rightIndex >= 0 && highlighted(hunkIndex, rightIndex, 'RIGHT') && 'pr-diff__line--selected'
                    )}
                    onMouseEnter={dragging && rightIndex >= 0
                      ? () => extendDrag(hunkIndex, rightIndex, 'RIGHT')
                      : undefined}
                  >
                    <span className="pr-diff__gutter">{gutter(row.right, 'new')}</span>
                    {row.right && rightIndex >= 0 && addButton(hunkIndex, rightIndex, 'RIGHT', row.right)}
                    <span className="pr-diff__content">{row.right?.content || '\u00a0'}</span>
                  </div>
                </div>
                {rowThreads.map((thread) => inlineRow(
                  thread.id,
                  <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
                ))}
                {composer && inlineRow(`composer-${rowIndex}`, composer)}
                </React.Fragment>
              );
            })}
        </div>
      ))}
    </div>
  );
}
