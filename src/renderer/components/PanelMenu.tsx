import React, { useEffect, useRef, useState } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import './PanelMenu.css';

export default function PanelMenu(): React.ReactElement {
  const instances = useLayoutStore((s) => s.instances);
  const locked = useLayoutStore((s) => s.locked);
  const toggleSessionsVisible = useLayoutStore((s) => s.toggleSessionsVisible);
  const setLocked = useLayoutStore((s) => s.setLocked);

  const sessionsVisible = instances.find((i) => i.type === 'sessions')?.placement.visible ?? false;

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click only — clicks inside keep it open.
  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
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

          <div className="panel-menu__divider" />

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
