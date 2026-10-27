import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLayoutStore, useActiveInstances, useActiveLocked } from '../stores/layoutStore';
import { PANEL_LABELS, PanelType, SINGLETON_TYPES, tabDef } from '../dashboard/layout';
import { Dropdown, DropdownDeletableItem, DropdownItem, DropdownSection, DropdownSubmenu } from './dropdown';
import './PanelMenu.css';

interface GlobalPanelEntry {
  id: string;
  name: string;
  /** Open in the currently active tab — determines focus vs. spawn-second-view. */
  openInThisTab: boolean;
}

export default function PanelMenu(): React.ReactElement {
  const instances = useActiveInstances();
  const locked = useActiveLocked();
  const activeTab = useLayoutStore((s) => s.activeTab);
  const togglePanelVisible = useLayoutStore((s) => s.togglePanelVisible);
  const setLocked = useLayoutStore((s) => s.setLocked);

  const { panelTypes } = tabDef(activeTab);
  // One visibility toggle per singleton this tab contains, in the tab's own order.
  const singletonTypes = panelTypes.filter((t) => SINGLETON_TYPES.has(t));
  const supportsNotes = panelTypes.includes('notes');

  const [open, setOpen] = useState(false);
  const [notesSubOpen, setNotesSubOpen] = useState(false);
  const [globalPanels, setGlobalPanels] = useState<GlobalPanelEntry[]>([]);
  const [confirmDestroyId, setConfirmDestroyId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const isVisible = (type: PanelType): boolean =>
    instances.find((i) => i.type === type)?.placement.visible ?? false;

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
      const store = useLayoutStore.getState();
      const openHere = new Set(
        store.tabs[store.activeTab].instances
          .filter((inst) => inst.type === 'notes' && inst.isGlobal)
          .map((inst) => inst.contentId ?? inst.id)
      );
      setGlobalPanels(panels.map((p: any) => ({
        id: p.id,
        name: p.name || 'Untitled',
        openInThisTab: openHere.has(p.id),
      })));
    } catch {
      setGlobalPanels([]);
    }
  }, []);

  const handlePanelClick = useCallback(async (panel: GlobalPanelEntry) => {
    const store = useLayoutStore.getState();
    const views = store.findInstancesByContentId(panel.id);

    if (panel.openInThisTab) {
      // Already here — surface it rather than opening a duplicate.
      const here = views.find((v) => v.tabId === store.activeTab);
      if (here) store.bringToFront(here.instance.id);
    } else {
      // Open in another tab: a second view shares the contentId and therefore the
      // notes scope, so the DB record is already open and needs no restore.
      if (views.length === 0) await window.dad.notesRestorePanel(panel.id);
      store.spawnGlobalPanel('notes', panel.id, panel.name);
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
        <Dropdown onMouseDown={(e) => e.stopPropagation()}>
          <DropdownSection label="PANELS">
            {singletonTypes.map((type) => (
              <DropdownItem
                key={type}
                check={isVisible(type) ? '✓' : '✕'}
                onClick={() => togglePanelVisible(type)}
              >
                {PANEL_LABELS[type]}
              </DropdownItem>
            ))}
            {supportsNotes && (
              <DropdownSubmenu
                label="Notes"
                check=""
                open={notesSubOpen}
                onOpen={() => { void handleNotesHover(); }}
                onClose={() => setNotesSubOpen(false)}
              >
                <DropdownItem
                  onClick={() => {
                    const store = useLayoutStore.getState();
                    const newId = store.spawnGlobalPanel('notes');
                    if (newId) {
                      const contentId = store.getInstance(newId)?.contentId ?? newId;
                      void window.dad.notesCreatePanel({ kind: 'global', id: contentId }, contentId);
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
                      <DropdownDeletableItem
                        key={p.id}
                        labelClassName={p.openInThisTab ? 'panel-menu__restore-name--open' : undefined}
                        confirming={confirmDestroyId === p.id}
                        onSelect={() => void handlePanelClick(p)}
                        onConfirmingChange={(confirming) => setConfirmDestroyId(confirming ? p.id : null)}
                        onDelete={() => {
                          void window.dad.notesDestroyPanel(p.id).then(() => {
                            // Close every view of this note, in every tab.
                            useLayoutStore.getState().destroyByContentId(p.id);
                            setGlobalPanels((prev) => prev.filter((cp) => cp.id !== p.id));
                            setConfirmDestroyId(null);
                          });
                        }}
                      >
                        {p.name}
                      </DropdownDeletableItem>
                    ))}
                  </DropdownSection>
                )}
              </DropdownSubmenu>
            )}
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
