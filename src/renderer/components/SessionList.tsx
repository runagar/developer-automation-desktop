import React, { useState, useRef, useEffect } from 'react';
import { Session, ProjectGroup } from '../../main/types';
import StateIndicator from './StateIndicator';
import ConfirmDialog from './ConfirmDialog';
import ManageWorkspacesDialog from './ManageWorkspacesDialog';
import './SessionList.css';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  projectGroups: ProjectGroup[];
  onSelect: (id: string) => void;
  onCreate: (workingDir: string, project?: string) => void;
  onDestroy: (id: string) => void;
  onRevive: (id: string) => void;
  onAddProject: (key: string, repo: string, group: string) => Promise<void>;
  onRemoveProject: (key: string) => Promise<void>;
  onAddGroup: (name: string) => Promise<void>;
  onRemoveGroup: (name: string) => Promise<void>;
  onMoveWorkspace: (key: string, toGroup: string, toIndex: number) => Promise<void>;
  onReorderGroup: (name: string, toIndex: number) => Promise<void>;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

const DEFAULT_WORK_DIR = '/home/rulu/projects';

export default function SessionList({
  sessions, activeSessionId, projectGroups, onSelect, onCreate, onDestroy, onRevive,
  onAddProject, onRemoveProject, onAddGroup, onRemoveGroup, onMoveWorkspace, onReorderGroup,
  openDropdownWithKeyboardRef,
}: Props): React.ReactElement {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  // null  = nothing highlighted (click-open default)
  // -1    = "New Session" button highlighted
  // 0..n-1 = project item at that index highlighted (flat index across all groups)
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const highlightedIndexRef = useRef<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pendingDestroyId, setPendingDestroyId] = useState<string | null>(null);

  const pendingSession = sessions.find((s) => s.id === pendingDestroyId) ?? null;

  // Flat list of all workspaces for keyboard navigation
  const allWorkspaces = projectGroups.flatMap((g) => g.workspaces);

  // Keep ref in sync with state so the keyboard handler can read it without
  // needing to be re-registered on every highlight change.
  useEffect(() => { highlightedIndexRef.current = highlightedIndex; }, [highlightedIndex]);

  // Expose keyboard-open function to App.tsx via ref
  openDropdownWithKeyboardRef.current = () => {
    if (dropdownOpen) return;
    setDropdownOpen(true);
    setHighlightedIndex(-1);
  };

  // Reset highlight whenever the dropdown closes
  useEffect(() => {
    if (!dropdownOpen) setHighlightedIndex(null);
  }, [dropdownOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Keyboard navigation — only active while the dropdown is open.
  // Registered with capture=true so it fires before App.tsx's bubble-phase
  // Tab handler, allowing stopImmediatePropagation to suppress session cycling.
  useEffect(() => {
    if (!dropdownOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDropdownOpen(false);
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const n = allWorkspaces.length;
        if (e.shiftKey) {
          setHighlightedIndex((curr) => {
            if (curr === null) return n > 0 ? n - 1 : -1;
            if (curr === -1)   return n > 0 ? n - 1 : -1;
            return curr === 0 ? -1 : curr - 1;
          });
        } else {
          setHighlightedIndex((curr) => {
            if (curr === null) return n > 0 ? 0 : -1;
            if (curr === -1)   return n > 0 ? 0 : -1;
            return curr === n - 1 ? -1 : curr + 1;
          });
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const curr = highlightedIndexRef.current;
        if (curr === null) return;
        if (curr === -1) {
          onCreate(DEFAULT_WORK_DIR);
        } else {
          const p = allWorkspaces[curr];
          if (p) onCreate(p.workingDir, p.key);
        }
        setDropdownOpen(false);
      }
    };

    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [dropdownOpen, allWorkspaces, onCreate]);

  // Running flat index counter for keyboard highlight mapping
  let flatIndex = 0;

  return (
    <aside className="session-list">
      <div className="session-list__header">SESSIONS</div>

      <div className="session-list__new" ref={dropdownRef}>
        <button
          className={[
            'btn btn--primary session-list__new-btn',
            highlightedIndex === -1 ? 'session-list__new-btn--highlighted' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onCreate(DEFAULT_WORK_DIR)}
          title={`New session in ${DEFAULT_WORK_DIR}`}
        >
          + NEW SESSION
        </button>
        <button
          className="btn btn--icon session-list__arrow"
          onClick={() => setDropdownOpen((v) => !v)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
          title="Open in project…"
        >
          ▾
        </button>

        {dropdownOpen && (
          <div className="dropdown">
            {projectGroups.length === 0 && (
              <div className="dropdown__empty">No projects found</div>
            )}
            {projectGroups.map((group) => (
              <div key={group.group}>
                <div className="dropdown__header">{group.group}</div>
                {group.workspaces.map((p) => {
                  const idx = flatIndex++;
                  return (
                    <button
                      key={p.key}
                      className={[
                        'dropdown__item',
                        highlightedIndex === idx ? 'dropdown__item--highlighted' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => {
                        onCreate(p.workingDir, p.key);
                        setDropdownOpen(false);
                      }}
                    >
                      <div className="dropdown__item-row">
                        <span className="dropdown__key">{p.key}</span>
                        <span className="dropdown__repo">{p.repo}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <ul className="session-list__items">
        {sessions.map((session) => (
          <li
            key={session.id}
            className={[
              'session-item',
              session.id === activeSessionId ? 'session-item--active' : '',
              session.dead ? 'session-item--dead' : '',
            ].join(' ')}
            onClick={() => onSelect(session.id)}
          >
            <div className="session-item__top">
              <StateIndicator state={session.dead ? 'dead' : session.state} />
              <span className="session-item__name">{session.name}</span>
              <div className="session-item__actions">
                {session.dead && (
                  <button
                    className="btn btn--micro"
                    title="Revive session"
                    onClick={(e) => { e.stopPropagation(); onRevive(session.id); }}
                  >↺</button>
                )}
                <button
                  className="btn btn--micro btn--danger"
                  title="Destroy session"
                  onClick={(e) => { e.stopPropagation(); setPendingDestroyId(session.id); }}
                >✕</button>
              </div>
            </div>
            {(session.project || session.restored) && (
              <div className="session-item__meta">
                {session.restored && <span className="session-item__restored">↺</span>}
                {session.project && <span className="session-item__project">{session.project}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="session-list__manage">
        <button
          className="btn session-list__manage-btn"
          onClick={() => setManageOpen(true)}
          title="Manage workspaces"
        >
          ⬡ MANAGE WORKSPACES
        </button>
      </div>

      {pendingSession && (
        <ConfirmDialog
          message={`Destroy "${pendingSession.name}"?`}
          detail="The session and its scrollback will be permanently removed."
          confirmLabel="DESTROY"
          onConfirm={() => {
            onDestroy(pendingSession.id);
            setPendingDestroyId(null);
          }}
          onCancel={() => setPendingDestroyId(null)}
        />
      )}

      {manageOpen && (
        <ManageWorkspacesDialog
          projectGroups={projectGroups}
          sessions={sessions}
          onAdd={onAddProject}
          onRemove={onRemoveProject}
          onAddGroup={onAddGroup}
          onRemoveGroup={onRemoveGroup}
          onMove={onMoveWorkspace}
          onReorderGroup={onReorderGroup}
          onClose={() => setManageOpen(false)}
        />
      )}
    </aside>
  );
}
