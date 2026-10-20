import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { PrDiffFile, PrDiffRef } from '../../main/types';
import { allDirPaths, buildFileTree, dirPathsContaining, flattenVisible } from '../utils/fileTree';
import { isFileViewed } from '../stores/githubStore';
import { cn } from '../utils/cn';

interface Props {
  files: PrDiffFile[];
  selectedPath: string | null;
  diffRef: PrDiffRef;
  localViewed: Map<string, Set<string>>;
  /** Comments per path. Empty outside full-PR mode, where none render. */
  commentCounts: Record<string, number>;
  onSelect: (path: string) => void;
}

/** Indent per level, in px. Kept tight: the panel is narrow. */
const INDENT = 12;

/** A folder row's padding before its chevron, in px. */
const DIR_INSET = 4;

/** A folder's chevron plus its gap, in px; skipped on file rows so names line up with folder names. */
const CHEVRON_COLUMN = 15;

/**
 * The changed files, as a collapsible tree.
 *
 * Rows show the base name only; the directory is conveyed by the tree itself.
 * A name cut off by the panel's width is on the row's tooltip. A flat list of
 * full paths is
 * unreadable in a narrow panel — every row ellipsises in the middle of the
 * part that identifies it.
 */
export default function DiffFileTree({
  files, selectedPath, diffRef, localViewed, commentCounts, onSelect,
}: Props): React.ReactElement {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleDir = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const pendingRevealRef = useRef(false);

  useEffect(() => {
    if (!selectedPath) return;
    pendingRevealRef.current = true;
    setCollapsed((prev) => {
      const hiding = [...prev].filter((dir) => selectedPath.startsWith(`${dir}/`));
      if (hiding.length === 0) return prev;
      const next = new Set(prev);
      hiding.forEach((dir) => next.delete(dir));
      return next;
    });
  }, [selectedPath]);

  useEffect(() => {
    if (!pendingRevealRef.current || !activeRowRef.current) return;
    pendingRevealRef.current = false;
    activeRowRef.current.scrollIntoView({ block: 'nearest' });
  });

  const dirPaths = useMemo(() => allDirPaths(tree), [tree]);
  const unviewedDirs = useMemo(
    () => dirPathsContaining(tree, (file) => !isFileViewed(file, diffRef, localViewed)),
    [tree, diffRef, localViewed]
  );
  const allCollapsed = dirPaths.length > 0 && dirPaths.every((p) => collapsed.has(p));

  // Flat, so striping follows visible order and stays correct as folders open
  // and close — the same approach as the REST Response tree.
  const rows = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);

  return (
    <>
      {/* The toggle and the count share a row: the count labels the list the
          toggle acts on, and giving it a line of its own cost a band of empty
          space above every diff. The toggle is absent when the tree is flat,
          so the count must not depend on it being there. */}
      <div className="pr-diff__tree-header">
        {dirPaths.length > 0 && (
          <button
            className="btn btn--micro pr-diff__tree-toggle"
            title={allCollapsed ? 'Expand all folders' : 'Collapse all folders'}
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(dirPaths))}
          >
            {allCollapsed ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
          </button>
        )}
        <span className="pr-diff__tree-count">
          {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
      </div>

      {rows.map(({ node, depth }, index) => {
        const alt = index % 2 === 1 && 'pr-diff__row--alt';

        if (node.kind === 'dir') {
          const isCollapsed = collapsed.has(node.path);
          return (
            <button
              key={`dir:${node.path}`}
              className={cn('pr-diff__dir', alt)}
              style={{ paddingLeft: depth * INDENT + DIR_INSET }}
              title={node.name}
              aria-expanded={!isCollapsed}
              onClick={() => toggleDir(node.path)}
            >
              {/* Same chevrons, at the same size, as the API Picker's
                  collapsible sections. */}
              <span className="pr-diff__dir-caret">
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </span>
              <span
                className={cn('pr-diff__dir-name', unviewedDirs.has(node.path) && 'pr-diff__dir-name--unviewed')}
                data-tooltip-overflow
              >
                {node.name}
              </span>
            </button>
          );
        }

        const viewed = isFileViewed(node.item, diffRef, localViewed);
        return (
          <div
            key={`file:${node.path}`}
            ref={node.path === selectedPath ? activeRowRef : undefined}
            className={cn(
              'pr-diff__file-row',
              alt,
              node.path === selectedPath && 'pr-diff__file-row--active'
            )}
            style={{ paddingLeft: depth * INDENT + DIR_INSET + CHEVRON_COLUMN }}
          >
            <button
              className="pr-diff__file-name"
              title={node.name}
              onClick={() => onSelect(node.path)}
            >
              <span
                className={cn('pr-diff__file-path', !viewed && 'pr-diff__file-path--unviewed')}
                data-tooltip-overflow
              >
                {node.name}
              </span>
              {/* Only where there is discussion — a "(0)" on every other row
                  would be noise. */}
              {commentCounts[node.path] > 0 && (
                <span className="pr-diff__file-comments">({commentCounts[node.path]})</span>
              )}
              <span className="pr-diff__file-stat">
                <span className="pr-diff__adds">+{node.item.additions}</span>
                <span className="pr-diff__dels">-{node.item.deletions}</span>
              </span>
            </button>
          </div>
        );
      })}
    </>
  );
}
