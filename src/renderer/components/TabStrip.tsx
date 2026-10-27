import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../utils/cn';
import { EDGE_TOLERANCE, activeTabCap, firstIndexToReveal, isFullyVisible } from '../utils/tabStrip';
import { Dropdown, DropdownItem, useDismiss } from './dropdown';
import './TabStrip.css';

export interface TabStripItem {
  id: string;
  name: string;
  /** Tooltip for the tab; defaults to its name. */
  title?: string;
}

interface Props {
  tabs: TabStripItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  closeTitle: string;
  /** Makes a click on the active tab rename it. */
  onRename?: (id: string, name: string) => void;
  onTabContextMenu?: (id: string, e: React.MouseEvent) => void;
  /** Rendered right after the scroll and overflow controls, e.g. a new-tab button. */
  trailing?: React.ReactNode;
  /** Pinned to the right end of the bar. */
  actions?: React.ReactNode;
}

function naturalWidth(tab: HTMLElement): number {
  const name = tab.querySelector<HTMLElement>('.tab-strip__name');
  const truncated = name ? name.scrollWidth - name.clientWidth : 0;
  return tab.getBoundingClientRect().width + truncated;
}

export default function TabStrip({
  tabs, activeId, onSelect, onClose, closeTitle, onRename, onTabContextMenu, trailing, actions,
}: Props): React.ReactElement {
  const stripRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const lastFirstIndexRef = useRef(0);
  const measureRef = useRef<() => void>(() => {});
  const [firstId, setFirstId] = useState<string | null>(null);
  const [activeCap, setActiveCap] = useState<number | null>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [hiddenTabs, setHiddenTabs] = useState<TabStripItem[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const foundFirstIndex = firstId === null ? 0 : tabs.findIndex((t) => t.id === firstId);
  const firstIndex = foundFirstIndex >= 0
    ? foundFirstIndex
    : Math.min(lastFirstIndexRef.current, Math.max(0, tabs.length - 1));
  lastFirstIndexRef.current = firstIndex;

  const tabElement = (id: string): HTMLElement | null => (
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`) ?? null
  );

  const isHidden = (index: number, stripRect: DOMRect): boolean => {
    if (index < firstIndex) return true;
    const rect = tabElement(tabs[index].id)?.getBoundingClientRect();
    return rect !== undefined && !isFullyVisible(rect, stripRect);
  };

  const measure = (): void => {
    const strip = stripRef.current;
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    if (stripRect.width === 0) return;
    let cap: number | null = null;
    let moreOnRight = false;
    for (const tab of tabs.slice(firstIndex)) {
      const el = tabElement(tab.id);
      if (!el) continue;
      const left = el.getBoundingClientRect().left - stripRect.left;
      const natural = naturalWidth(el);
      if (left + natural > stripRect.width + EDGE_TOLERANCE) moreOnRight = true;
      if (tab.id === activeId) cap = activeTabCap(left, natural, stripRect.width);
    }
    setActiveCap(cap);
    setCanScrollRight(moreOnRight);
    setOverflowing(tabs.some((_, index) => isHidden(index, stripRect)));
  };
  measureRef.current = measure;

  useLayoutEffect(() => {
    measureRef.current();
  }, [tabs, firstIndex, activeId, activeCap, renamingId, renameValue]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(strip);
    strip.querySelectorAll('[data-tab-id]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [tabs]);

  const reveal = (id: string): void => {
    const index = tabs.findIndex((t) => t.id === id);
    const strip = stripRef.current;
    if (index < 0 || !strip) return;
    const stripWidth = strip.getBoundingClientRect().width;
    if (stripWidth === 0) return;
    const widths = tabs.slice(firstIndex, index + 1).map((t) => {
      const el = tabElement(t.id);
      return el ? naturalWidth(el) : 0;
    });
    const next = firstIndexToReveal(firstIndex, index, widths, stripWidth);
    if (next !== firstIndex) setFirstId(tabs[next].id);
  };

  useLayoutEffect(() => {
    if (activeId) reveal(activeId);
  }, [activeId]);

  const closeHiddenList = (): void => setHiddenTabs(null);
  useDismiss(overflowRef, hiddenTabs !== null, closeHiddenList);

  useEffect(() => {
    if (!overflowing) setHiddenTabs(null);
  }, [overflowing]);

  const toggleHiddenList = (): void => {
    const strip = stripRef.current;
    if (hiddenTabs !== null || !strip) {
      setHiddenTabs(null);
      return;
    }
    const stripRect = strip.getBoundingClientRect();
    setHiddenTabs(tabs.filter((_, index) => isHidden(index, stripRect)));
  };

  const pickHidden = (id: string): void => {
    setHiddenTabs(null);
    onSelect(id);
    reveal(id);
  };

  const scrollLeft = (): void => {
    if (firstIndex > 0) setFirstId(tabs[firstIndex - 1].id);
  };

  const scrollRight = (): void => {
    if (canScrollRight && firstIndex < tabs.length - 1) setFirstId(tabs[firstIndex + 1].id);
  };

  const handleTabClick = (tab: TabStripItem): void => {
    if (tab.id === activeId && onRename) {
      setRenamingId(tab.id);
      setRenameValue(tab.name);
    } else {
      onSelect(tab.id);
    }
  };

  const submitRename = (): void => {
    if (renamingId && renameValue.trim() && onRename) onRename(renamingId, renameValue.trim());
    setRenamingId(null);
  };

  return (
    <div className="tab-strip">
      <button className="tab-strip__control" onClick={scrollLeft} title="Scroll tabs left">◀</button>
      <div
        className={cn('tab-strip__tabs', activeCap !== null && 'tab-strip__tabs--full')}
        ref={stripRef}
        onScroll={(e) => { e.currentTarget.scrollLeft = 0; }}
      >
        {tabs.map((tab, index) => {
          const renaming = renamingId === tab.id;
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={cn(
                'tab-strip__tab',
                active && 'tab-strip__tab--active',
                renaming && 'tab-strip__tab--renaming',
                index < firstIndex && 'tab-strip__tab--scrolled-away',
              )}
              style={active && activeCap !== null ? { maxWidth: activeCap } : undefined}
              title={renaming ? undefined : tab.title ?? tab.name}
              onClick={() => handleTabClick(tab)}
              onContextMenu={onTabContextMenu && ((e) => onTabContextMenu(tab.id, e))}
            >
              <span className="tab-strip__label">
                <span className="tab-strip__name">{renaming ? renameValue || '\u00a0' : tab.name}</span>
                {renaming && (
                  <input
                    className="tab-strip__rename"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={submitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onFocus={(e) => e.target.select()}
                    autoFocus
                    spellCheck={false}
                  />
                )}
              </span>
              <button
                className="btn btn--micro btn--danger tab-strip__close"
                tabIndex={-1}
                title={closeTitle}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >✕</button>
            </div>
          );
        })}
      </div>
      <button className="tab-strip__control" onClick={scrollRight} title="Scroll tabs right">▶</button>
      {overflowing && (
        <div className="tab-strip__overflow" ref={overflowRef}>
          <button
            className="tab-strip__control"
            onClick={toggleHiddenList}
            title="Tabs out of view"
            aria-haspopup="menu"
            aria-expanded={hiddenTabs !== null}
          >▼</button>
          {hiddenTabs !== null && (
            <Dropdown className="tab-strip__overflow-menu">
              {hiddenTabs.map((tab) => (
                <DropdownItem
                  key={tab.id}
                  check={tab.id === activeId ? '✓' : ''}
                  onClick={() => pickHidden(tab.id)}
                >
                  <span className="tab-strip__overflow-name" title={tab.title ?? tab.name}>{tab.name}</span>
                </DropdownItem>
              ))}
            </Dropdown>
          )}
        </div>
      )}
      {trailing}
      {actions && <div className="tab-strip__actions">{actions}</div>}
    </div>
  );
}
