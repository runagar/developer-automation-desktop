import React from 'react';
import { useTopLayer } from './useTopLayer';
import './Dropdown.css';

// --- Dropdown container ---

interface DropdownProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onMouseDown?: (e: React.MouseEvent) => void;
  /**
   * Set to false for menus positioned with explicit viewport coordinates
   * (context menus opened at the pointer) rather than under their container.
   */
  anchorToParent?: boolean;
}

export const Dropdown = React.forwardRef<HTMLDivElement, DropdownProps>(function Dropdown(
  { children, className, style, onMouseDown, anchorToParent = true },
  ref,
): React.ReactElement {
  const innerRef = React.useRef<HTMLDivElement>(null);
  useTopLayer(innerRef, { anchorToParent });

  // Keep the caller's ref working while the hook drives the same node.
  React.useImperativeHandle(ref, () => innerRef.current as HTMLDivElement);

  return (
    <div
      ref={innerRef}
      className={`dropdown${className ? ` ${className}` : ''}`}
      style={style}
      onMouseDown={onMouseDown ?? ((e) => e.stopPropagation())}
    >
      {children}
    </div>
  );
});
Dropdown.displayName = 'Dropdown';

// --- Section header (with auto-divider except first) ---

interface DropdownSectionProps {
  label: string;
  children: React.ReactNode;
}

export function DropdownSection({ label, children }: DropdownSectionProps): React.ReactElement {
  return (
    <>
      <div className="dropdown__section">{label}</div>
      {children}
    </>
  );
}

// --- Menu item ---

interface DropdownItemProps {
  children: React.ReactNode;
  check?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export function DropdownItem({ children, check, onClick, disabled, className }: DropdownItemProps): React.ReactElement {
  return (
    <button
      className={`dropdown__item${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="dropdown__check">{check ?? ''}</span>
      {children}
    </button>
  );
}

// --- Submenu trigger (opens SubDropdown on hover) ---

interface DropdownSubmenuProps {
  label: string;
  check?: string;
  children: React.ReactNode;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export function DropdownSubmenu({ label, check, children, open, onOpen, onClose }: DropdownSubmenuProps): React.ReactElement {
  return (
    <div
      className="dropdown__item dropdown__submenu"
      onMouseEnter={onOpen}
      onMouseLeave={onClose}
    >
      <span className="dropdown__check">{check ?? ''}</span>
      {label}
      <span className="dropdown__arrow">▸</span>
      {open && (
        <SubDropdownWrapper>
          {children}
        </SubDropdownWrapper>
      )}
    </div>
  );
}

// --- SubDropdown with viewport boundary detection ---

function SubDropdownWrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const [openLeft, setOpenLeft] = React.useState(false);
  const [measured, setMeasured] = React.useState(false);

  React.useEffect(() => {
    requestAnimationFrame(() => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      setOpenLeft(rect.right > window.innerWidth);
      setMeasured(true);
    });
  }, []);

  const classes = [
    'dropdown__sub',
    openLeft ? 'dropdown__sub--left' : '',
    !measured ? 'dropdown__sub--measuring' : '',
  ].filter(Boolean).join(' ');

  return (
    <div ref={ref} className={classes} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
