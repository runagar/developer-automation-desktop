import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { Dropdown, DropdownItem, DropdownSection, DropdownSubmenu } from './dropdown';
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
        <Dropdown className="panel-menu__menu" onMouseDown={(e) => e.stopPropagation()}>
          <DropdownSection label="PANELS">
            <DropdownItem check={sessionsVisible ? '✓' : '✕'} onClick={() => toggleSessionsVisible()}>
              Sessions
            </DropdownItem>
            <DropdownSubmenu
              label="Notes"
              check=""
              open={notesSubOpen}
              onOpen={() => { void handleNotesHover(); }}
              onClose={() => setNotesSubOpen(false)}
            >
              <DropdownItem
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
              </DropdownItem>
              {closedPanels.length > 0 && (
                <DropdownSection label="RESTORE">
                  {closedPanels.map((p) => (
                    <div key={p.id} className="dropdown__item panel-menu__restore-row">
                      <span
                        className="panel-menu__restore-name"
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
                </DropdownSection>
              )}
            </DropdownSubmenu>
          </DropdownSection>

          <DropdownSection label="LAYOUT">
            <DropdownItem check={locked ? '✓' : '✕'} onClick={() => setLocked(!locked)}>
              Lock layout
            </DropdownItem>
          </DropdownSection>
        </Dropdown>
      )}
    </div>
  );
}
