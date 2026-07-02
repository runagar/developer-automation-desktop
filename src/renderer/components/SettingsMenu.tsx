import React, { useEffect, useRef, useState } from 'react';
import './SettingsMenu.css';

interface Props {
  onOpenCredentials: () => void;
  onOpenWorkspaces: () => void;
}

export default function SettingsMenu({ onOpenCredentials, onOpenWorkspaces }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
    <div className="settings-menu" ref={ref}>
      <button
        className="settings-menu__btn"
        onClick={() => setOpen((v) => !v)}
        title="Settings"
      >
        <span className="settings-menu__icon">⚙</span>
        <span className="settings-menu__label">SETTINGS</span>
        <span className="settings-menu__caret">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="settings-menu__dropdown" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="settings-menu__item"
            onClick={() => { setOpen(false); onOpenWorkspaces(); }}
          >
            Workspaces
          </button>
          <button
            className="settings-menu__item"
            onClick={() => { setOpen(false); onOpenCredentials(); }}
          >
            Credentials
          </button>
        </div>
      )}
    </div>
  );
}
