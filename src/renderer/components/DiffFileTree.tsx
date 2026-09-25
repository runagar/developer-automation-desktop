import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { PrDiffFile, PrDiffRef } from '../../main/types';
import { allDirPaths, buildFileTree, flattenVisible } from '../utils/fileTree';
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
  onToggleViewed: (path: string, viewed: boolean) => void;
}

/** Indent per level, in px. Kept tight: the panel is narrow. */
const INDENT = 12;

/**
 * The changed files, as a collapsible tree.
 *
 * Rows show the base name only; the directory is conveyed by the tree itself
 * and the full path is on the row's tooltip. A flat list of full paths is
 * unreadable in a narrow panel — every row ellipsises in the middle of the
 * part that identifies it.
 */
export default function DiffFileTree({
  files, selectedPath, diffRef, localViewed, commentCounts, onSelect, onToggleViewed,
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

  const dirPaths = useMemo(() => allDirPaths(tree), [tree]);
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
              style={{ paddingLeft: depth * INDENT + 4 }}
              title={node.path}
              aria-expanded={!isCollapsed}
              onClick={() => toggleDir(node.path)}
            >
              {/* Same chevrons, at the same size, as the API Picker's
                  collapsible sections. */}
              <span className="pr-diff__dir-caret">
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </span>
              <span className="pr-diff__dir-name">{node.name}</span>
            </button>
          );
        }

        const viewed = isFileViewed(node.item, diffRef, localViewed);
        return (
          <div
            key={`file:${node.path}`}
            className={cn(
              'pr-diff__file-row',
              alt,
              node.path === selectedPath && 'pr-diff__file-row--active'
            )}
            style={{ paddingLeft: depth * INDENT }}
          >
            <button
              className={cn('pr-diff__viewed', viewed && 'pr-diff__viewed--on')}
              title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
              // Chromium focuses a clicked button regardless of tab index;
              // letting focus escape here clears the panel's focus tracking
              // and silently disables Tab navigation.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggleViewed(node.path, !viewed)}
            >
              {viewed ? '☑' : '☐'}
            </button>
            <button
              className="pr-diff__file-name"
              // The full path, since the row shows only the base name.
              title={node.path}
              onClick={() => onSelect(node.path)}
            >
              <span className="pr-diff__file-path">{node.name}</span>
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
