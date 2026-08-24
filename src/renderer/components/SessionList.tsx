import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Session, WorkspaceGroup } from '../../main/types';
import { PanelType } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import StateIndicator from './StateIndicator';
import ConfirmDialog from './ConfirmDialog';
import SessionContextMenu from './SessionContextMenu';
import { usePanelFocus } from '../dashboard/usePanelFocus';
import './SessionList.css';

export interface SessionListHandle {
  focus: () => void;
}

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  workspaceGroups: WorkspaceGroup[];
  onSelect: (id: string) => void;
  onCreate: (workingDir: string, project?: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDestroy: (id: string) => void;
  onRevive: (id: string) => void;
  onDoubleClickSession: (id: string) => void;
  onContextMenuSpawn: (type: PanelType, sessionId: string) => void;
  onRename: (id: string, name: string) => void;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

export default forwardRef<SessionListHandle, Props>(function SessionList({
  sessions, activeSessionId, workspaceGroups, onSelect, onCreate, onArchive, onUnarchive, onDestroy, onRevive,
  onDoubleClickSession, onContextMenuSpawn, onRename,
  openDropdownWithKeyboardRef,
}: Props, ref): React.ReactElement {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  // null  = nothing highlighted (click-open default)
  // -1    = "New Session" button highlighted
  // 0..n-1 = project item at that index highlighted (flat index across all groups)
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const highlightedIndexRef = useRef<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);
  const [pendingDestroyId, setPendingDestroyId] = useState<string | null>(null);
  const [destroyAllPending, setDestroyAllPending] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  usePanelFocus(rootRef);

  // Default working directory root from settings
  const [defaultWorkDir, setDefaultWorkDir] = useState('/home');
  useEffect(() => {
    const loadRoot = () => { void window.dad.getDefaultWorkingRoot().then(setDefaultWorkDir); };
    loadRoot();
    window.addEventListener('dad-settings-changed', loadRoot);
    return () => window.removeEventListener('dad-settings-changed', loadRoot);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (activeItemRef.current) activeItemRef.current.focus();
      else rootRef.current?.focus();
    },
  }), []);
  const [archivedExpanded, setArchivedExpanded] = useState(() => {
    try { return localStorage.getItem('dad-archived-expanded') === 'true'; } catch { return false; }
  });

  const pendingDestroySession = sessions.find((s) => s.id === pendingDestroyId) ?? null;

  const activeSessions = sessions.filter((s) => !s.archived);
  const archivedSessions = sessions.filter((s) => s.archived);

  // --- Session drag-to-reorder ---
  const [dragSessionId, setDragSessionId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ id: string; y: number; x: number; active: boolean } | null>(null);
  const justDraggedRef = useRef(false);
  const DRAG_DEAD_ZONE = 5;

  const handleDragPointerDown = useCallback((sessionId: string, e: React.PointerEvent) => {
    // Only primary button, not on buttons/inputs
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    e.stopPropagation(); // Prevent panel drag from activating
    dragStartRef.current = { id: sessionId, y: e.clientY, x: e.clientX, active: false };
  }, []);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      if (!drag.active) {
        if (Math.abs(e.clientY - drag.y) < DRAG_DEAD_ZONE) return;
        drag.active = true;
        setDragSessionId(drag.id);
        document.body.style.userSelect = 'none';
      }
      setDragPos({ x: e.clientX, y: e.clientY });
      // Find which session item we're hovering over
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const li = el?.closest<HTMLElement>('.session-item[data-session-id]');
      const targetId = li?.dataset.sessionId ?? null;
      if (targetId && targetId !== drag.id) {
        setDropTargetId(targetId);
      } else if (!targetId && el?.closest('.session-list__items, .session-list__drop-end')) {
        // Below all items or on the drop-end zone → move to end
        setDropTargetId('__end__');
      } else {
        setDropTargetId(null);
      }
    };

    const handleUp = () => {
      const drag = dragStartRef.current;
      if (!drag) return;
      if (drag.active) {
        justDraggedRef.current = true;
        requestAnimationFrame(() => { justDraggedRef.current = false; });
        if (dropTargetId) {
          // Reorder: move dragged session before the drop target (or to end)
          const ids = activeSessions.map((s) => s.id);
          const fromIdx = ids.indexOf(drag.id);
          if (fromIdx !== -1) {
            ids.splice(fromIdx, 1);
            if (dropTargetId === '__end__') {
              ids.push(drag.id);
            } else {
              const toIdx = ids.indexOf(dropTargetId);
              if (toIdx !== -1) {
                ids.splice(toIdx, 0, drag.id);
              }
            }
            const allIds = [...ids, ...archivedSessions.map((s) => s.id)];
            useSessionStore.getState().reorderSessions(allIds);
          }
        }
      }
      dragStartRef.current = null;
      setDragSessionId(null);
      setDropTargetId(null);
      setDragPos(null);
      document.body.style.userSelect = '';
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };
  }, [activeSessions, archivedSessions, dropTargetId]);

  const draggedSession = dragSessionId ? activeSessions.find((s) => s.id === dragSessionId) : null;

  // Flat list of all workspaces for keyboard navigation
  const allWorkspaces = workspaceGroups.flatMap((g) => g.workspaces);

  // Keep ref in sync with state so the keyboard handler can read it without
  // needing to be re-registered on every highlight change.
  useEffect(() => { highlightedIndexRef.current = highlightedIndex; }, [highlightedIndex]);

  // Expose keyboard-open function to App.tsx via ref
  openDropdownWithKeyboardRef.current = () => {
    if (dropdownOpen) return;
    setDropdownOpen(true);
    setHighlightedIndex(-1);
    // Position will be computed by the useEffect above
  };

  // Reset highlight whenever the dropdown closes
  useEffect(() => {
    if (!dropdownOpen) setHighlightedIndex(null);
  }, [dropdownOpen]);

  // Compute fixed position for the dropdown (escapes panel overflow:hidden)
  useEffect(() => {
    if (!dropdownOpen || !dropdownRef.current) return;
    const rect = dropdownRef.current.getBoundingClientRect();
    setDropdownStyle({
      top: rect.bottom,
      left: rect.left,
      width: rect.width,
    });
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
          onCreate(defaultWorkDir);
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
    <aside className="session-list" ref={rootRef} tabIndex={-1}>
      <div className="session-list__new" ref={dropdownRef}>
        <button
          className={[
            'btn btn--primary session-list__new-btn',
            highlightedIndex === -1 ? 'session-list__new-btn--highlighted' : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onCreate(defaultWorkDir)}
          title={`New session in ${defaultWorkDir}`}
        >
          + NEW SESSION
        </button>
        <button
          className="btn btn--icon session-list__arrow"
          onClick={() => setDropdownOpen((v) => !v)}
          title="Open in project…"
        >
          ▾
        </button>

        {dropdownOpen && (
          <div className="dropdown" style={dropdownStyle}>
            {workspaceGroups.length === 0 && (
              <div className="dropdown__empty">No projects found</div>
            )}
            {workspaceGroups.map((group) => (
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
        {activeSessions.map((session) => (
          <li
            key={session.id}
            data-session-id={session.id}
            ref={session.id === activeSessionId ? activeItemRef : undefined}
            tabIndex={0}
            className={[
              'session-item',
              session.id === activeSessionId ? 'session-item--active' : '',
              session.dead ? 'session-item--dead' : '',
              dragSessionId === session.id ? 'session-item--dragging' : '',
              dropTargetId === session.id ? 'session-item--drop-target' : '',
            ].join(' ')}
            onClick={() => { if (!justDraggedRef.current && !dragStartRef.current) onSelect(session.id); }}
            onFocus={() => { if (!justDraggedRef.current && !dragStartRef.current) onSelect(session.id); }}
            onPointerDown={(e) => handleDragPointerDown(session.id, e)}
            onDoubleClick={() => {
              if (!session.archived && !session.dead) {
                onDoubleClickSession(session.id);
              }
            }}
            onContextMenu={(e) => {
              if (session.archived || session.dead) return;
              e.preventDefault();
              setContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY });
            }}
          >
            <div className="session-item__top">
              <StateIndicator state={session.dead ? 'dead' : session.state} />
              {renamingId === session.id ? (
                <input
                  className="session-item__rename-input"
                  value={renameValue}
                  autoFocus
                  spellCheck={false}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => {
                    const trimmed = renameValue.trim();
                    if (trimmed && trimmed !== session.name) onRename(session.id, trimmed);
                    setRenamingId(null);
                    // Re-focus the session list item
                    requestAnimationFrame(() => activeItemRef.current?.focus());
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const trimmed = renameValue.trim();
                      if (trimmed && trimmed !== session.name) onRename(session.id, trimmed);
                      setRenamingId(null);
                      requestAnimationFrame(() => activeItemRef.current?.focus());
                    }
                    if (e.key === 'Escape') {
                      setRenamingId(null);
                      requestAnimationFrame(() => activeItemRef.current?.focus());
                    }
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="session-item__name">{session.name}</span>
              )}
              <div className="session-item__actions">
                {session.dead && (
                  <button
                    className="btn btn--micro"
                    tabIndex={-1}
                    title="Revive session"
                    onClick={(e) => { e.stopPropagation(); onRevive(session.id); }}
                  >↺</button>
                )}
                <button
                  className="btn btn--micro btn--danger"
                  tabIndex={-1}
                  title="Archive session"
                  onClick={(e) => { e.stopPropagation(); onArchive(session.id); }}
                >✕</button>
              </div>
            </div>
            {(session.project || session.restored) && (
              <div className="session-item__meta">
                {session.restored && <span className="session-item__restored">↺</span>}
                {session.project && <span className="session-item__project">[ {session.project} ]</span>}
              </div>
            )}
          </li>
        ))}
        {dragSessionId && (
          <li className={`session-list__drop-end${dropTargetId === '__end__' ? ' session-list__drop-end--active' : ''}`} />
        )}
      </ul>

      {archivedSessions.length > 0 && (
        <div className="session-list__archived">
          <button
            className="session-list__archived-header"
            onClick={() => {
              setArchivedExpanded((v) => {
                const next = !v;
                try { localStorage.setItem('dad-archived-expanded', String(next)); } catch { /* ok */ }
                return next;
              });
            }}
          >
            <span className="session-list__archived-arrow">
              {archivedExpanded ? '▾' : '▸'}
            </span>
            <span>ARCHIVED SESSIONS</span>
            <span className="session-list__archived-count">({archivedSessions.length})</span>
          </button>
          {archivedExpanded && (
            <ul className="session-list__archived-items">
              {archivedSessions.map((session) => (
                <li
                  key={session.id}
                  className="session-item session-item--archived"
                >
                  <div className="session-item__top">
                    <StateIndicator state={session.warm ? 'warm' : 'cold'} />
                    <span className="session-item__name">{session.name}</span>
                    <div className="session-item__actions session-item__actions--archived">
                      <button
                        className="btn btn--micro"
                        tabIndex={-1}
                        title="Restore session"
                        onClick={(e) => { e.stopPropagation(); onUnarchive(session.id); }}
                      >↺</button>
                      <button
                        className="btn btn--micro btn--danger"
                        tabIndex={-1}
                        title="Destroy session"
                        onClick={(e) => { e.stopPropagation(); setPendingDestroyId(session.id); }}
                      >✕</button>
                    </div>
                  </div>
                  {session.project && (
                    <div className="session-item__meta">
                      <span className="session-item__project">[ {session.project} ]</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {archivedExpanded && archivedSessions.length > 1 && (
            <div className="session-list__destroy-all">
              <button
                className="btn btn--micro btn--danger session-list__destroy-all-btn"
                onClick={() => setDestroyAllPending(true)}
              >
                ✕ DESTROY ALL
              </button>
            </div>
          )}
        </div>
      )}

      {pendingDestroySession && (
        <ConfirmDialog
          message={`Destroy "${pendingDestroySession.name}"?`}
          detail="This will permanently kill the session and any running agent. This cannot be undone."
          confirmLabel="DESTROY"
          onConfirm={() => {
            onDestroy(pendingDestroySession.id);
            setPendingDestroyId(null);
          }}
          onCancel={() => setPendingDestroyId(null)}
        />
      )}

      {destroyAllPending && (
        <ConfirmDialog
          message={`Destroy all ${archivedSessions.length} archived sessions?`}
          detail="This will permanently kill all archived sessions and any running agents. This cannot be undone."
          confirmLabel="DESTROY ALL"
          onConfirm={() => {
            for (const s of archivedSessions) onDestroy(s.id);
            setDestroyAllPending(false);
          }}
          onCancel={() => setDestroyAllPending(false)}
        />
      )}

      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onSpawnPanel={(type) => onContextMenuSpawn(type, contextMenu.sessionId)}
          onRename={() => {
            const session = sessions.find((s) => s.id === contextMenu.sessionId);
            if (session) {
              setRenameValue(session.name);
              setRenamingId(session.id);
            }
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {draggedSession && dragPos && (
        <div
          className="session-drag-ghost"
          style={{ left: dragPos.x + 12, top: dragPos.y - 14 }}
        >
          <StateIndicator state={draggedSession.dead ? 'dead' : draggedSession.state} />
          <span className="session-drag-ghost__name">{draggedSession.name}</span>
          {draggedSession.project && (
            <span className="session-drag-ghost__project">[ {draggedSession.project} ]</span>
          )}
        </div>
      )}
    </aside>
  );
});
