import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import SubDropdown from './SubDropdown';
import './PanelMenu.css';

export default function PanelMenu(): React.ReactElement {
  const instances = useLayoutStore((s) => s.instances);
  const locked = useLayoutStore((s) => s.locked);
  const toggleSessionsVisible = useLayoutStore((s) => s.toggleSessionsVisible);
  const setLocked = useLayoutStore((s) => s.setLocked);

  const sessionsVisible = instances.find((i) => i.type === 'sessions')?.placement.visible ?? false;

  const [open, setOpen] = useState(false);
  const [notesSubOpen, setNotesSubOpen] = useState(false);
  const [closedPanels, setClosedPanels] = useState<Array<{ id: string; scopeId: string }>>([]);
  const [confirmDestroyId, setConfirmDestroyId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click only — clicks inside keep it open.
  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setNotesSubOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const handleNotesHover = useCallback(async () => {
    setNotesSubOpen(true);
    try {
      const panels = await window.agentSmith.notesGetClosedPanels();
      setClosedPanels(panels.map((p: any) => ({ id: p.id, scopeId: p.scopeId })));
    } catch {
      setClosedPanels([]);
    }
  }, []);

  const handleRestorePanel = useCallback(async (panelId: string) => {
    await window.agentSmith.notesRestorePanel(panelId);
    useLayoutStore.getState().spawnGlobalPanel('notes', panelId);
    setOpen(false);
    setNotesSubOpen(false);
  }, []);

  return (
    <div className="panel-menu" ref={ref}>
      <button
        className="panel-menu__btn"
        onClick={() => setOpen((v) => !v)}
        title="Panels & layout"
      >
        <span className="panel-menu__icon">▦</span>
        <span className="panel-menu__label">PANELS</span>
        <span className="panel-menu__caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="panel-menu__dropdown" onMouseDown={(e) => e.stopPropagation()}>
          <div className="panel-menu__section-label">PANELS</div>
          <button
            className="panel-menu__item"
            onClick={() => toggleSessionsVisible()}
          >
            <span className="panel-menu__check">
              {sessionsVisible ? '✔' : ''}
            </span>
            Sessions
          </button>

          <div
            className="panel-menu__item sub-dropdown-trigger"
            onMouseEnter={handleNotesHover}
            onMouseLeave={() => setNotesSubOpen(false)}
          >
            <span className="panel-menu__check">{''}</span>
            Notes
            <span className="sub-dropdown-arrow">▸</span>
            {notesSubOpen && (
              <SubDropdown>
                <button
                  className="panel-menu__item"
                  onClick={() => {
                    const newId = useLayoutStore.getState().spawnGlobalPanel('notes');
                    if (newId) {
                      void window.agentSmith.notesCreatePanel({ kind: 'global', id: newId }, newId);
                    }
                    setOpen(false);
                    setNotesSubOpen(false);
                  }}
                >
                  New
                </button>
                {closedPanels.length > 0 && (
                  <>
                    <div className="panel-menu__divider" />
                    <div className="panel-menu__section-label">RESTORE</div>
                    {closedPanels.map((p) => (
                      <div key={p.id} className="panel-menu__item panel-menu__item--restore">
                        <span
                          className="panel-menu__item-label"
                          onClick={() => void handleRestorePanel(p.id)}
                        >
                          {p.scopeId}
                        </span>
                        {confirmDestroyId === p.id ? (
                          <>
                            <button
                              className="btn btn--micro btn--primary"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                void window.agentSmith.notesDestroyPanel(p.id).then(() => {
                                  setClosedPanels((prev) => prev.filter((cp) => cp.id !== p.id));
                                  setConfirmDestroyId(null);
                                });
                              }}
                              title="Confirm delete"
                            >✓</button>
                            <button
                              className="btn btn--micro"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => { e.stopPropagation(); setConfirmDestroyId(null); }}
                              title="Cancel"
                            >✕</button>
                          </>
                        ) : (
                          <button
                            className="btn btn--micro btn--danger"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setConfirmDestroyId(p.id); }}
                            title="Delete permanently"
                          >✕</button>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </SubDropdown>
            )}
          </div>

          <div className="panel-menu__section-label">LAYOUT</div>
          <button
            className="panel-menu__item"
            onClick={() => setLocked(!locked)}
          >
            <span className="panel-menu__check">{locked ? '✔' : ''}</span>
            Lock layout
          </button>
        </div>
      )}
    </div>
  );
}
