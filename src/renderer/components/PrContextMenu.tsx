import React, { useLayoutEffect, useRef, useState } from 'react';
import { Dropdown, DropdownItem, DropdownSection, useDismiss } from './dropdown';
import './PrContextMenu.css';

export interface MenuPosition {
  x: number;
  y: number;
}

interface Props extends MenuPosition {
  url: string;
  onClose: () => void;
}

export default function PrContextMenu({ x, y, url, onClose }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useDismiss(ref, true, onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPosition({
      left: Math.max(0, Math.min(x, window.innerWidth - width)),
      top: Math.max(0, Math.min(y, window.innerHeight - height)),
    });
  }, [x, y]);

  const copyLink = (): void => {
    window.dad.clipboardWrite(url);
    onClose();
  };

  return (
    <Dropdown
      ref={ref}
      className="pr-context-menu"
      anchorToParent={false}
      style={{ position: 'fixed', ...position }}
    >
      <DropdownSection label="Pull request">
        <DropdownItem onClick={copyLink}>Copy link to GitHub</DropdownItem>
      </DropdownSection>
    </Dropdown>
  );
}
