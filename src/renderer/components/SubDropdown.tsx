import React, { useEffect, useRef, useState } from 'react';
import './SubDropdown.css';

interface Props {
  children: React.ReactNode;
  className?: string;
}

/**
 * A subdropdown that measures its position and flips left if it would
 * overflow the right edge of the viewport.
 */
export default function SubDropdown({ children, className }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [openLeft, setOpenLeft] = useState(false);
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      setOpenLeft(rect.right > window.innerWidth);
      setMeasured(true);
    });
  }, []);

  const classes = [
    'sub-dropdown',
    openLeft ? 'sub-dropdown--left' : '',
    !measured ? 'sub-dropdown--measuring' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div ref={ref} className={classes} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
