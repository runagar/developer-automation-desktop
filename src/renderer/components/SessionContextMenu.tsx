import React, { useEffect, useRef } from 'react';
import { PanelType } from '../dashboard/layout';
import { Dropdown, DropdownItem, DropdownSection } from './dropdown';

interface MenuItem {
  label: string;
  action: string;
}

interface MenuSection {
  header: string;
  items: MenuItem[];
}

interface Props {
  x: number;
  y: number;
  onSpawnPanel: (type: PanelType) => void;
  onRename: () => void;
  onClose: () => void;
}

const SECTIONS: MenuSection[] = [
  {
    header: 'New panel',
    items: [
      { label: 'CLI Terminal', action: 'terminal' },
      { label: 'Shell', action: 'shell' },
      { label: 'Jira', action: 'jira' },
      { label: 'Notes', action: 'notes' },
    ],
  },
  {
    header: 'Session',
    items: [
      { label: 'Rename', action: 'rename' },
    ],
  },
];

export default function SessionContextMenu({ x, y, onSpawnPanel, onRename, onClose }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Clamp position to viewport
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - 180),
  };

  const handleAction = (action: string) => {
    if (action === 'rename') {
      onRename();
    } else {
      onSpawnPanel(action as PanelType);
    }
    onClose();
  };

  return (
    <Dropdown
      ref={ref}
      style={{ ...style, position: 'fixed' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {SECTIONS.map((section) => (
        <DropdownSection key={section.header} label={section.header}>
          {section.items.map((item) => (
            <DropdownItem
              key={item.action}
              onClick={() => handleAction(item.action)}
            >
              {item.label}
            </DropdownItem>
          ))}
        </DropdownSection>
      ))}
    </Dropdown>
  );
}
