import React, { useEffect, useRef, useState } from 'react';
import { DashboardController } from '../dashboard/useDashboardLayout';
import { PANEL_IDS, PANEL_LABELS, PRESETS } from '../dashboard/layout';
import './PanelMenu.css';

interface Props {
  controller: DashboardController;
}

export default function PanelMenu({ controller }: Props): React.ReactElement {
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
          {PANEL_IDS.map((id) => (
            <button
              key={id}
              className="panel-menu__item"
              onClick={() => controller.toggleVisible(id)}
            >
              <span className="panel-menu__check">
                {controller.layout[id].visible ? '✔' : ''}
              </span>
              {PANEL_LABELS[id]}
            </button>
          ))}

          <div className="panel-menu__divider" />

          <div className="panel-menu__section-label">LAYOUT PRESETS</div>
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className={`panel-menu__item${controller.preset === p.name ? ' panel-menu__item--active' : ''}`}
              onClick={() => controller.applyPreset(p.name)}
            >
              <span className="panel-menu__check">
                {controller.preset === p.name ? '✔' : ''}
              </span>
              {p.name}
            </button>
          ))}

          <div className="panel-menu__divider" />

          <button
            className="panel-menu__item"
            onClick={() => controller.setLocked(!controller.locked)}
          >
            <span className="panel-menu__check">{controller.locked ? '✔' : ''}</span>
            Lock layout
          </button>
        </div>
      )}
    </div>
  );
}
