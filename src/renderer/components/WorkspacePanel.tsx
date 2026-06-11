import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { DashboardPanelPlacement, PanelId, toPct } from '../dashboard/layout';
import './WorkspacePanel.css';

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLES: ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export interface PanelHandle {
  focus: () => void;
}

interface Props {
  id: PanelId;
  title: string;
  placement: DashboardPanelPlacement;
  locked: boolean;
  isFocused: boolean;
  // Entry-point focus action invoked when the panel gains focus via Ctrl+Tab.
  focusEntry?: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent, handle: ResizeHandle) => void;
  onActivate: () => void;
  onClose: () => void;
  children: React.ReactNode;
}

const WorkspacePanel = forwardRef<PanelHandle, Props>(function WorkspacePanel(
  { id, title, placement, locked, isFocused, focusEntry, onDragStart, onResizeStart, onActivate, onClose, children },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (focusEntry) focusEntry();
      else containerRef.current?.focus();
    },
  }), [focusEntry]);

  const style: React.CSSProperties = {
    left: `${toPct(placement.x)}%`,
    top: `${toPct(placement.y)}%`,
    width: `${toPct(placement.w)}%`,
    height: `${toPct(placement.h)}%`,
    zIndex: placement.z,
    // Hidden panels stay mounted (preserving xterm buffers) but are not displayed.
    display: placement.visible ? undefined : 'none',
  };

  return (
    <section
      ref={containerRef}
      className={['workspace-panel', isFocused ? 'workspace-panel--focused' : ''].filter(Boolean).join(' ')}
      style={style}
      data-panel-id={id}
      tabIndex={-1}
      onPointerDownCapture={onActivate}
    >
      <header
        className="workspace-panel__header"
        onPointerDown={locked ? undefined : onDragStart}
        style={locked ? { cursor: 'default' } : undefined}
      >
        <span className="workspace-panel__title">{title}</span>
        {!locked && (
          <button
            className="btn btn--micro btn--danger workspace-panel__close"
            title="Hide panel"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >✕</button>
        )}
      </header>

      <div className="workspace-panel__body">{children}</div>

      {!locked && HANDLES.map((h) => (
        <div
          key={h}
          className={`workspace-panel__resize workspace-panel__resize--${h}`}
          onPointerDown={(e) => { e.stopPropagation(); onResizeStart(e, h); }}
        />
      ))}
    </section>
  );
});

export default WorkspacePanel;
