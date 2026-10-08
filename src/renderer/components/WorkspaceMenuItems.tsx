import React from 'react';
import { WorkspaceEntry, WorkspaceGroup } from '../../main/types';
import { cn } from '../utils/cn';

interface Props {
  groups: WorkspaceGroup[];
  /** Flat index across all groups, in display order. */
  highlightedIndex: number | null;
  onPick: (workspace: WorkspaceEntry) => void;
  itemTitle?: (workspace: WorkspaceEntry) => string;
  emptyLabel?: string;
}

/** Workspace groups as `KEY  repo` menu items; render inside a `.dropdown--workspaces` Dropdown. */
export default function WorkspaceMenuItems({
  groups, highlightedIndex, onPick, itemTitle, emptyLabel = 'No projects found',
}: Props): React.ReactElement {
  let flatIndex = 0;

  return (
    <>
      {groups.length === 0 && <div className="dropdown__empty">{emptyLabel}</div>}
      {groups.map((group) => (
        <div key={group.group}>
          <div className="dropdown__header">{group.group}</div>
          {group.workspaces.map((workspace) => {
            const idx = flatIndex++;
            return (
              <button
                key={workspace.key}
                className={cn('dropdown__item', highlightedIndex === idx && 'dropdown__item--highlighted')}
                title={itemTitle?.(workspace)}
                onClick={() => onPick(workspace)}
              >
                <div className="dropdown__item-row">
                  <span className="dropdown__key">{workspace.key}</span>
                  <span className="dropdown__repo">{workspace.repo}</span>
                </div>
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}
