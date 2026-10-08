import React, { useCallback, useRef, useState } from 'react';
import { WorkspaceEntry, WorkspaceGroup } from '../../main/types';
import { OPEN_PR_OWNER } from '../../main/githubPrLists';
import { Dropdown, useDismiss } from './dropdown';
import WorkspaceMenuItems from './WorkspaceMenuItems';
import './WorkspacePicker.css';

interface Props {
  groups: WorkspaceGroup[];
  selected: WorkspaceEntry | null;
  onSelect: (workspace: WorkspaceEntry) => void;
  autoFocus?: boolean;
}

const repoTitle = (workspace: WorkspaceEntry): string => `${OPEN_PR_OWNER}/${workspace.repo}`;

export default function WorkspacePicker({ groups, selected, onSelect, autoFocus }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(containerRef, open, close);

  const flat = groups.flatMap((g) => g.workspaces);
  const selectedIndex = selected ? flat.findIndex((w) => w.key === selected.key) : -1;

  return (
    <div ref={containerRef} className="workspace-picker">
      <button
        className="workspace-picker__trigger"
        title={selected ? repoTitle(selected) : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        autoFocus={autoFocus}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <>
            <span className="workspace-picker__key">{selected.key}</span>
            <span className="workspace-picker__repo">{selected.repo}</span>
          </>
        ) : (
          <span className="workspace-picker__repo">No workspaces</span>
        )}
        <span className="workspace-picker__caret">▾</span>
      </button>

      {open && (
        <Dropdown className="dropdown--workspaces workspace-picker__menu">
          <WorkspaceMenuItems
            groups={groups}
            highlightedIndex={selectedIndex >= 0 ? selectedIndex : null}
            itemTitle={repoTitle}
            onPick={(workspace) => {
              close();
              onSelect(workspace);
            }}
          />
        </Dropdown>
      )}
    </div>
  );
}
