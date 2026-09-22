import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { PrCommentAnchor, PrDiffFile, PrReviewThread } from '../../main/types';
import {
  DiffLine, DiffHunk, anchorForLine, anchorForSelection, lineMatchesAnchor, parsePatch, toSplitRows,
} from '../../main/githubDiff';
import { DiffLineSelection, DiffViewMode, useGitHubStore } from '../stores/githubStore';
import { cn } from '../utils/cn';
import CommentThread from './CommentThread';
import CommentComposer from './CommentComposer';

interface Props {
  file: PrDiffFile;
  mode: DiffViewMode;
  /** Threads belonging to this file. Empty outside full-PR mode. */
  threads: PrReviewThread[];
  /** False in commit/range mode, where anchors cannot be computed reliably. */
  canComment: boolean;
  pendingReviewId: string | null;
  onComment: (anchor: PrCommentAnchor, body: string) => Promise<void>;
}

/** An in-progress drag from the `+` affordance, in one hunk. */
interface Drag {
  hunkIndex: number;
  from: number;
  to: number;
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

export default function DiffFileView({
  file, mode, threads, canComment, pendingReviewId, onComment,
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
        });
      }
      setDrag(null);
    }
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  if (!file.patch) {
    // Binary files and files past GitHub's size ceiling arrive with no patch.
    // They are still listed, so the file is not silently missing.
    return (
      <div className="pr-diff__placeholder">
        DIFF NOT SHOWN (binary / too large)
      </div>
    );
  }

  const threadsAt = (line: DiffLine): PrReviewThread[] => {
    const anchor = anchorForLine(line);
    if (!anchor) return [];
    return threads.filter(
      (t) => t.line === anchor.line && t.side === anchor.side && lineMatchesAnchor(line, anchor)
    );
  };

  /**
   * The `+` affordance.
   *
   * Mouse *down* starts a drag rather than click opening the composer, so a
   * single click and a drag are the same gesture — the click simply ends where
   * it began. `preventDefault` stops the browser beginning a text selection,
   * which is what keeps dragging here distinct from selecting the diff text.
   */
  const addButton = (hunkIndex: number, lineIndex: number): React.ReactNode => {
    if (!canComment) return null;
    return (
      <button
        className="pr-diff__add-comment"
        title="Comment on this line — drag to cover several"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDrag({ hunkIndex, from: lineIndex, to: lineIndex });
        }}
      >
        <Plus size={11} />
      </button>
    );
  };

  /** Extends an in-progress drag; clamped to the hunk it started in. */
  const extendDrag = (hunkIndex: number, lineIndex: number): void => {
    setDrag((d) => (d && d.hunkIndex === hunkIndex ? { ...d, to: lineIndex } : d));
  };

  const highlighted = (hunkIndex: number, lineIndex: number): boolean => {
    if (drag) return drag.hunkIndex === hunkIndex && inRange(drag, lineIndex);
    return !!selection && selection.hunkIndex === hunkIndex && inRange(selection, lineIndex);
  };

  /**
   * The composer, rendered directly beneath the last line of the selection.
   *
   * Placed inline rather than at the foot of the hunk so the comment sits
   * against the code it refers to — losing that adjacency is most of what
   * makes a diff comment readable.
   */
  const composerFor = (hunk: DiffHunk, hunkIndex: number, afterLine: number): React.ReactNode => {
    if (!selection || selection.hunkIndex !== hunkIndex || drag) return null;
    if (Math.max(selection.from, selection.to) !== afterLine) return null;

    const multi = selection.from !== selection.to;
    const anchor: PrCommentAnchor | null = multi
      ? (() => {
        const a = anchorForSelection(hunk, selection.from, selection.to);
        return a ? { path: file.path, ...a } : null;
      })()
      : (() => {
        const a = anchorForLine(hunk.lines[selection.from]);
        return a ? { path: file.path, line: a.line, side: a.side, startLine: null, startSide: null } : null;
      })();

    if (!anchor) {
      return (
        <div className="panel-error">
          That selection cannot be commented on — it spans both sides of the diff.
          <button className="btn btn--micro panel-error__retry" onClick={() => setSelection(null)}>
            DISMISS
          </button>
        </div>
      );
    }

    return (
      <CommentComposer
          // Keyed by the exact anchor, so a draft on one line is not offered
          // when commenting on another.
          draftKey={`diff:${file.path}:${anchor.side}:${anchor.startLine ?? anchor.line}:${anchor.line}`}
          placeholder={
            multi
              ? `Comment on lines ${anchor.startLine}–${anchor.line}…  (Ctrl+Enter to send, Esc to cancel)`
              : `Comment on line ${anchor.line}…  (Ctrl+Enter to send, Esc to cancel)`
          }
          submitLabel={pendingReviewId ? 'ADD TO REVIEW' : 'COMMENT'}
          autoFocus
        onSubmit={async (body) => { await onComment(anchor, body); setSelection(null); }}
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
      {parsed.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}-${hunkIndex}`} className="pr-diff__hunk">
          <div className="pr-diff__hunk-header">{hunk.header}</div>

          {mode === 'unified'
            ? hunk.lines.map((line, lineIndex) => {
              const composer = composerFor(hunk, hunkIndex, lineIndex);
              return (
              <React.Fragment key={lineIndex}>
                <div
                  className={cn(
                    lineClass(line.kind),
                    highlighted(hunkIndex, lineIndex) && 'pr-diff__line--selected'
                  )}
                  onMouseEnter={dragging ? () => extendDrag(hunkIndex, lineIndex) : undefined}
                >
                  <span className="pr-diff__gutter">{gutter(line, 'old')}</span>
                  <span className="pr-diff__gutter">{gutter(line, 'new')}</span>
                  {addButton(hunkIndex, lineIndex)}
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
              const lastIndex = Math.max(leftIndex, rightIndex);
              const composer = lastIndex >= 0 ? composerFor(hunk, hunkIndex, lastIndex) : null;

              return (
                <React.Fragment key={rowIndex}>
                <div className="pr-diff__split-row">
                  <div
                    className={cn(
                      'pr-diff__split-cell',
                      row.left && lineClass(row.left.kind),
                      leftIndex >= 0 && highlighted(hunkIndex, leftIndex) && 'pr-diff__line--selected'
                    )}
                    onMouseEnter={dragging && leftIndex >= 0
                      ? () => extendDrag(hunkIndex, leftIndex)
                      : undefined}
                  >
                    <span className="pr-diff__gutter">{gutter(row.left, 'old')}</span>
                    {leftIndex >= 0 && addButton(hunkIndex, leftIndex)}
                    <span className="pr-diff__content">{row.left?.content || '\u00a0'}</span>
                  </div>
                  <div
                    className={cn(
                      'pr-diff__split-cell',
                      row.right && lineClass(row.right.kind),
                      rightIndex >= 0 && highlighted(hunkIndex, rightIndex) && 'pr-diff__line--selected'
                    )}
                    onMouseEnter={dragging && rightIndex >= 0
                      ? () => extendDrag(hunkIndex, rightIndex)
                      : undefined}
                  >
                    <span className="pr-diff__gutter">{gutter(row.right, 'new')}</span>
                    {rightIndex >= 0 && addButton(hunkIndex, rightIndex)}
                    <span className="pr-diff__content">{row.right?.content || '\u00a0'}</span>
                  </div>
                </div>
                {rowThreads.map((thread) => inlineRow(
                  thread.id,
                  <CommentThread thread={thread} pendingReviewId={pendingReviewId} />
                ))}
                {composer && inlineRow(`composer-${lastIndex}`, composer)}
                </React.Fragment>
              );
            })}
        </div>
      ))}
    </div>
  );
}
