import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { Home } from 'lucide-react';
import { Placement, PanelMode, toPct } from '../dashboard/layout';
import PanelErrorBoundary from './PanelErrorBoundary';
import './WorkspacePanel.css';

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLES: ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export interface PanelHandle {
  focus: () => void;
}

interface Props {
  id: string;
  title: React.ReactNode;
  placement: Placement;
  mode: PanelMode;
  locked: boolean;
  isFocused: boolean;
  isDragging?: boolean;
  isSnapping?: boolean;
  dragStyle?: React.CSSProperties;
  // Entry-point focus action invoked when the panel gains focus via Ctrl+Tab.
  focusEntry?: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent, handle: ResizeHandle) => void;
  onActivate: () => void;
  onClose: () => void;
  onMaximize?: () => void;
  children: React.ReactNode;
}

const WorkspacePanel = forwardRef<PanelHandle, Props>(function WorkspacePanel(
  { id, title, placement, mode, locked, isFocused, isDragging, isSnapping, dragStyle, focusEntry, onDragStart, onResizeStart, onActivate, onClose, onMaximize, children },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (focusEntry) focusEntry();
      else containerRef.current?.focus();
    },
  }), [focusEntry]);

  const baseStyle: React.CSSProperties = {
    left: `${toPct(placement.x)}%`,
    top: `${toPct(placement.y)}%`,
    width: `${toPct(placement.w)}%`,
    height: `${toPct(placement.h)}%`,
    zIndex: placement.z,
    // Hidden panels stay mounted (preserving xterm buffers) but are not displayed.
    display: placement.visible ? undefined : 'none',
  };

  // During drag or snap, override positioning with dragStyle
  const style: React.CSSProperties = dragStyle ? { ...baseStyle, ...dragStyle } : baseStyle;

  const classNames = [
    'workspace-panel',
    isFocused ? 'workspace-panel--focused' : '',
    isDragging ? 'workspace-panel--dragging' : '',
    isSnapping ? 'workspace-panel--snapping' : '',
  ].filter(Boolean).join(' ');

  return (
    <section
      ref={containerRef}
      className={classNames}
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
        {mode === 'default' && (
          <span className="workspace-panel__default-badge" title="Default panel"><Home size={11} /></span>
        )}
        <span className="workspace-panel__title">{title}</span>
        {!locked && (
          <button
            className="btn btn--micro btn--danger workspace-panel__close"
            title={mode === 'singleton' ? 'Hide panel' : 'Close panel'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >✕</button>
        )}
      </header>

      <div
        className="workspace-panel__body"
        onDoubleClick={locked ? undefined : (e) => {
          // Double-click on sub-header (terminal-pane__header) also triggers maximize
          const target = e.target as HTMLElement;
          if (target.closest('.terminal-pane__header') && onMaximize) {
            // Don't trigger if clicking on an interactive element (buttons, inputs)
            if (!target.closest('button, input, .notes-panel__name-label')) {
              onMaximize();
            }
          }
        }}
      >
        <PanelErrorBoundary panelId={id}>
          {children}
        </PanelErrorBoundary>
      </div>

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
