import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { Dropdown, DropdownItem, DropdownSection, DropdownSubmenu } from './dropdown';
import './PanelMenu.css';

interface GlobalPanelEntry {
  id: string;
  name: string;
  isOpen: boolean;
}

export default function PanelMenu(): React.ReactElement {
  const instances = useLayoutStore((s) => s.instances);
  const locked = useLayoutStore((s) => s.locked);
  const toggleSessionsVisible = useLayoutStore((s) => s.toggleSessionsVisible);
  const setLocked = useLayoutStore((s) => s.setLocked);

  const sessionsVisible = instances.find((i) => i.type === 'sessions')?.placement.visible ?? false;

  const [open, setOpen] = useState(false);
  const [notesSubOpen, setNotesSubOpen] = useState(false);
  const [globalPanels, setGlobalPanels] = useState<GlobalPanelEntry[]>([]);
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
      const panels = await window.dad.notesGetAllGlobalPanels();
      // Determine which are currently open in the layout
      const openIds = new Set(
        useLayoutStore.getState().instances
          .filter((inst) => inst.type === 'notes' && inst.isGlobal)
          .map((inst) => inst.id)
      );
      setGlobalPanels(panels.map((p: any) => ({
        id: p.id,
        name: p.name || 'Untitled',
        isOpen: openIds.has(p.id),
      })));
    } catch {
      setGlobalPanels([]);
    }
  }, []);

  const handlePanelClick = useCallback(async (panel: GlobalPanelEntry) => {
    if (panel.isOpen) {
      // Focus and bring to front
      useLayoutStore.getState().bringToFront(panel.id);
    } else {
      // Restore
      await window.dad.notesRestorePanel(panel.id);
      const name = panel.name;
      useLayoutStore.getState().spawnGlobalPanel('notes', panel.id, name);
    }
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
                    void window.dad.notesCreatePanel({ kind: 'global', id: newId }, newId);
                  }
                  setOpen(false);
                  setNotesSubOpen(false);
                }}
              >
                New
              </DropdownItem>
              {globalPanels.length > 0 && (
                <DropdownSection label="SAVED NOTES">
                  {globalPanels.map((p) => (
                    <div key={p.id} className="dropdown__item panel-menu__restore-row">
                      <span className="dropdown__check"></span>
                      <span
                        className={`panel-menu__restore-name${p.isOpen ? ' panel-menu__restore-name--open' : ''}`}
                        onClick={() => void handlePanelClick(p)}
                      >
                        {p.name}
                      </span>
                      {confirmDestroyId === p.id ? (
                        <>
                          <button
                            className="btn btn--micro btn--primary"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              void window.dad.notesDestroyPanel(p.id).then(() => {
                                // Close the panel in the layout if it's open
                                if (p.isOpen) {
                                  useLayoutStore.getState().destroyPanel(p.id);
                                }
                                setGlobalPanels((prev) => prev.filter((cp) => cp.id !== p.id));
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
