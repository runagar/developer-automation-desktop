import React, { useCallback, useEffect, useRef, useState } from 'react';
import WorkspacePanel, { PanelHandle, ResizeHandle } from './WorkspacePanel';
import { useLayoutStore } from '../stores/layoutStore';
import {
  PanelInstance, PANEL_LABELS, panelOrder, Placement, GRID, clampPlacement, toPct,
} from '../dashboard/layout';
import './Workspace.css';

interface Props {
  renderBody: (instance: PanelInstance) => React.ReactNode;
  renderTitle?: (instance: PanelInstance) => React.ReactNode;
  focusEntry: (instance: PanelInstance) => (() => void) | undefined;
}

// Dead zone threshold in pixels before drag activates
const DEAD_ZONE_PX = 4;
// Snap animation duration in ms
const SNAP_DURATION_MS = 150;

interface DragState {
  id: string;
  kind: 'move' | 'resize';
  handle?: ResizeHandle;
  startX: number;
  startY: number;
  pixelDx: number;
  pixelDy: number;
  cellW: number;
  cellH: number;
  original: Placement;
  snap: Placement;
  active: boolean;
  pointerId: number;
  captureElement: HTMLElement;
}

interface SnapState {
  id: string;
  kind: 'move' | 'resize';
  snap: Placement;
  original: Placement;
  // Move: pixel offsets for FLIP animation
  fromTransformX: number;
  fromTransformY: number;
  targetTransformX: number;
  targetTransformY: number;
  // Resize: pixel rects for animation
  fromPx?: { left: number; top: number; width: number; height: number };
  targetPx?: { left: number; top: number; width: number; height: number };
  // Whether the transition CSS has been applied (needs a frame delay)
  animating: boolean;
}

/** Compute snapped target placement from pixel delta. */
function computeSnap(drag: DragState): Placement {
  const { kind, handle, original, pixelDx, pixelDy, cellW, cellH } = drag;
  const dxCells = Math.round(pixelDx / cellW);
  const dyCells = Math.round(pixelDy / cellH);

  if (kind === 'move') {
    return clampPlacement({
      ...original,
      x: original.x + dxCells,
      y: original.y + dyCells,
    });
  }

  // Resize
  let { x, y, w, h } = original;
  const hdl = handle!;
  if (hdl.includes('e')) w = original.w + dxCells;
  if (hdl.includes('s')) h = original.h + dyCells;
  if (hdl.includes('w')) { x = original.x + dxCells; w = original.w - dxCells; }
  if (hdl.includes('n')) { y = original.y + dyCells; h = original.h - dyCells; }
  return clampPlacement({ ...original, x, y, w, h });
}

export default function Workspace({ renderBody, renderTitle, focusEntry }: Props): React.ReactElement {
  const instances = useLayoutStore((s) => s.instances);
  const locked = useLayoutStore((s) => s.locked);
  const setPlacement = useLayoutStore((s) => s.setPlacement);
  const bringToFront = useLayoutStore((s) => s.bringToFront);
  const destroyPanel = useLayoutStore((s) => s.destroyPanel);
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusedInstanceId, setFocusedInstanceId] = useState<string | null>(null);

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [snapState, setSnapState] = useState<SnapState | null>(null);

  const panelRefs = useRef<Map<string, PanelHandle>>(new Map());

  // --- Pointer drag / resize (with dead zone + pointer capture) ---

  const dragRef = useRef<DragState | null>(null);
  dragRef.current = dragState;

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;

    const pixelDx = e.clientX - drag.startX;
    const pixelDy = e.clientY - drag.startY;

    if (!drag.active) {
      if (Math.hypot(pixelDx, pixelDy) < DEAD_ZONE_PX) return;
      bringToFront(drag.id);
      const activated: DragState = { ...drag, active: true, pixelDx, pixelDy, snap: computeSnap({ ...drag, pixelDx, pixelDy }) };
      dragRef.current = activated;
      setDragState(activated);
      return;
    }

    const updated: DragState = { ...drag, pixelDx, pixelDy, snap: computeSnap({ ...drag, pixelDx, pixelDy }) };
    dragRef.current = updated;
    setDragState(updated);
  }, [bringToFront]);

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;

    try { drag.captureElement.releasePointerCapture(drag.pointerId); } catch { /* already released */ }

    if (!drag.active) {
      // Dead-zone click — manually focus the panel (preventDefault blocks default focus)
      const section = drag.captureElement.closest<HTMLElement>('[data-panel-id]');
      section?.focus();
      setDragState(null);
      dragRef.current = null;
      return;
    }

    // Begin snap animation
    const rootRect = rootRef.current?.getBoundingClientRect();
    const containerW = rootRect?.width ?? 1;
    const containerH = rootRect?.height ?? 1;

    if (drag.kind === 'move') {
      const snapOffsetX = ((drag.snap.x - drag.original.x) / GRID) * containerW;
      const snapOffsetY = ((drag.snap.y - drag.original.y) / GRID) * containerH;

      setSnapState({
        id: drag.id,
        kind: 'move',
        snap: drag.snap,
        original: drag.original,
        fromTransformX: drag.pixelDx,
        fromTransformY: drag.pixelDy,
        targetTransformX: snapOffsetX,
        targetTransformY: snapOffsetY,
        animating: false,
      });
    } else {
      // Resize: compute current and target pixel rects
      const origPxX = (drag.original.x / GRID) * containerW;
      const origPxY = (drag.original.y / GRID) * containerH;
      const origPxW = (drag.original.w / GRID) * containerW;
      const origPxH = (drag.original.h / GRID) * containerH;
      let curX = origPxX, curY = origPxY, curW = origPxW, curH = origPxH;
      const hdl = drag.handle!;
      if (hdl.includes('e')) curW = origPxW + drag.pixelDx;
      if (hdl.includes('s')) curH = origPxH + drag.pixelDy;
      if (hdl.includes('w')) { curX = origPxX + drag.pixelDx; curW = origPxW - drag.pixelDx; }
      if (hdl.includes('n')) { curY = origPxY + drag.pixelDy; curH = origPxH - drag.pixelDy; }

      const targetPx = {
        left: (drag.snap.x / GRID) * containerW,
        top: (drag.snap.y / GRID) * containerH,
        width: (drag.snap.w / GRID) * containerW,
        height: (drag.snap.h / GRID) * containerH,
      };

      setSnapState({
        id: drag.id,
        kind: 'resize',
        snap: drag.snap,
        original: drag.original,
        fromTransformX: 0,
        fromTransformY: 0,
        targetTransformX: 0,
        targetTransformY: 0,
        fromPx: { left: curX, top: curY, width: Math.max(curW, 20), height: Math.max(curH, 20) },
        targetPx,
        animating: false,
      });
    }

    setDragState(null);
    dragRef.current = null;
  }, [setPlacement]);

  // Trigger animation on next frame after snap state is set, then commit after duration
  useEffect(() => {
    if (!snapState || snapState.animating) return;
    // Next frame: enable transition
    const rafId = requestAnimationFrame(() => {
      setSnapState((s) => s ? { ...s, animating: true } : null);
    });
    return () => cancelAnimationFrame(rafId);
  }, [snapState?.id, snapState?.animating]);

  useEffect(() => {
    if (!snapState?.animating) return;
    const timer = setTimeout(() => {
      setPlacement(snapState.id, snapState.snap);
      setSnapState(null);
    }, SNAP_DURATION_MS + 10);
    return () => clearTimeout(timer);
  }, [snapState?.animating, snapState?.id, setPlacement]);

  const handleLostCapture = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.active) {
      setPlacement(drag.id, drag.snap);
    }
    setDragState(null);
    dragRef.current = null;
    setSnapState(null);
  }, [setPlacement]);

  const cellSize = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { cellW: (rect?.width ?? 1) / GRID, cellH: (rect?.height ?? 1) / GRID };
  }, []);

  const handleDragStart = useCallback((id: string, placement: Placement) => (e: React.PointerEvent) => {
    if (locked) return;
    e.preventDefault();
    const { cellW, cellH } = cellSize();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const initial: DragState = {
      id, kind: 'move', startX: e.clientX, startY: e.clientY,
      pixelDx: 0, pixelDy: 0, cellW, cellH,
      original: placement, snap: placement,
      active: false, pointerId: e.pointerId, captureElement: el,
    };
    dragRef.current = initial;
    setDragState(initial);
  }, [locked, cellSize]);

  const handleResizeStart = useCallback((id: string, placement: Placement) => (e: React.PointerEvent, handle: ResizeHandle) => {
    if (locked) return;
    e.preventDefault();
    const { cellW, cellH } = cellSize();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const initial: DragState = {
      id, kind: 'resize', handle, startX: e.clientX, startY: e.clientY,
      pixelDx: 0, pixelDy: 0, cellW, cellH,
      original: placement, snap: placement,
      active: false, pointerId: e.pointerId, captureElement: el,
    };
    dragRef.current = initial;
    setDragState(initial);
  }, [locked, cellSize]);

  // Attach pointer event handlers to the capture element when drag starts
  useEffect(() => {
    const drag = dragState;
    if (!drag) return;
    const el = drag.captureElement;
    el.addEventListener('pointermove', handlePointerMove);
    el.addEventListener('pointerup', handlePointerUp);
    el.addEventListener('lostpointercapture', handleLostCapture);
    return () => {
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerup', handlePointerUp);
      el.removeEventListener('lostpointercapture', handleLostCapture);
    };
  }, [dragState?.id, dragState?.captureElement, handlePointerMove, handlePointerUp, handleLostCapture]);

  // --- Focus tracking (highlight + Ctrl+Tab start point) ---

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onFocusIn = (e: FocusEvent): void => {
      const el = (e.target as HTMLElement | null)?.closest('[data-panel-id]');
      const id = el?.getAttribute('data-panel-id') ?? null;
      setFocusedInstanceId(id);
    };
    const onFocusOut = (): void => {
      requestAnimationFrame(() => {
        const active = document.activeElement as HTMLElement | null;
        const el = active?.closest('[data-panel-id]');
        const id = el?.getAttribute('data-panel-id') ?? null;
        if (!id) setFocusedInstanceId(null);
      });
    };

    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // --- Cross-panel Ctrl+Tab cycling (window capture, before xterm) ---

  const focusedRef = useRef<string | null>(null);
  focusedRef.current = focusedInstanceId;
  const instancesRef = useRef(instances);
  instancesRef.current = instances;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;

      if (e.ctrlKey) {
        const order = panelOrder(instancesRef.current);
        if (order.length === 0) return;
        e.preventDefault();
        e.stopPropagation();

        const current = focusedRef.current;
        const idx = current ? order.findIndex((inst) => inst.id === current) : -1;
        const next = e.shiftKey
          ? order[(idx - 1 + order.length) % order.length]
          : order[(idx + 1) % order.length];

        bringToFront(next.id);
        panelRefs.current.get(next.id)?.focus();
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      if (!active?.closest('[data-panel-id]')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [bringToFront]);

  const visibleInstances = panelOrder(instances);

  // --- Compute drag/snap visual overrides ---

  const getDragStyle = (inst: PanelInstance): React.CSSProperties | undefined => {
    // Snap animation
    if (snapState && snapState.id === inst.id) {
      // Guard: if the store already reflects the snap position, no override needed.
      // This prevents a double-offset flicker if the store updates before snapState clears.
      const p = inst.placement;
      if (p.x === snapState.snap.x && p.y === snapState.snap.y &&
          p.w === snapState.snap.w && p.h === snapState.snap.h) {
        return undefined;
      }

      if (snapState.kind === 'move') {
        if (snapState.animating) {
          return {
            transform: `translate(${snapState.targetTransformX}px, ${snapState.targetTransformY}px)`,
            transition: `transform ${SNAP_DURATION_MS}ms ease-out`,
            zIndex: 9999,
          };
        }
        // First frame: keep at current drag position (no transition, no jump)
        return {
          transform: `translate(${snapState.fromTransformX}px, ${snapState.fromTransformY}px)`,
          zIndex: 9999,
        };
      }

      // Resize snap
      if (snapState.animating && snapState.targetPx) {
        return {
          left: `${snapState.targetPx.left}px`,
          top: `${snapState.targetPx.top}px`,
          width: `${snapState.targetPx.width}px`,
          height: `${snapState.targetPx.height}px`,
          zIndex: 9999,
          position: 'absolute' as const,
          transition: `left ${SNAP_DURATION_MS}ms ease-out, top ${SNAP_DURATION_MS}ms ease-out, width ${SNAP_DURATION_MS}ms ease-out, height ${SNAP_DURATION_MS}ms ease-out`,
        };
      }
      if (snapState.fromPx) {
        // First frame: keep at current resize position (no transition)
        return {
          left: `${snapState.fromPx.left}px`,
          top: `${snapState.fromPx.top}px`,
          width: `${snapState.fromPx.width}px`,
          height: `${snapState.fromPx.height}px`,
          zIndex: 9999,
          position: 'absolute' as const,
        };
      }
    }

    // Active drag
    if (dragState?.active && dragState.id === inst.id) {
      if (dragState.kind === 'move') {
        return {
          transform: `translate(${dragState.pixelDx}px, ${dragState.pixelDy}px)`,
          zIndex: 9999,
        };
      }
      // Resize: pixel-level position override
      const rootRect = rootRef.current?.getBoundingClientRect();
      if (!rootRect) return undefined;
      const { original, pixelDx, pixelDy, handle } = dragState;
      const origPxW = (original.w / GRID) * rootRect.width;
      const origPxH = (original.h / GRID) * rootRect.height;
      const origPxX = (original.x / GRID) * rootRect.width;
      const origPxY = (original.y / GRID) * rootRect.height;
      let newX = origPxX, newY = origPxY, newW = origPxW, newH = origPxH;
      const hdl = handle!;
      if (hdl.includes('e')) newW = origPxW + pixelDx;
      if (hdl.includes('s')) newH = origPxH + pixelDy;
      if (hdl.includes('w')) { newX = origPxX + pixelDx; newW = origPxW - pixelDx; }
      if (hdl.includes('n')) { newY = origPxY + pixelDy; newH = origPxH - pixelDy; }
      return {
        left: `${newX}px`,
        top: `${newY}px`,
        width: `${Math.max(newW, 20)}px`,
        height: `${Math.max(newH, 20)}px`,
        zIndex: 9999,
        position: 'absolute' as const,
      };
    }

    return undefined;
  };

  // --- Shadow rendering ---

  const renderShadow = (): React.ReactNode => {
    if (!dragState?.active) return null;
    const { snap } = dragState;
    const style: React.CSSProperties = {
      left: `${toPct(snap.x)}%`,
      top: `${toPct(snap.y)}%`,
      width: `${toPct(snap.w)}%`,
      height: `${toPct(snap.h)}%`,
      zIndex: 9998,
    };
    return <div className="workspace__drag-shadow" style={style} />;
  };

  return (
    <div className="workspace" ref={rootRef}>
      {renderShadow()}

      {instances.map((inst) => {
        const isDragging = dragState?.active && dragState.id === inst.id;
        const isSnapping = snapState?.id === inst.id;
        const dragStyle = getDragStyle(inst);

        return (
          <WorkspacePanel
            key={inst.id}
            id={inst.id}
            title={renderTitle ? renderTitle(inst) : PANEL_LABELS[inst.type]}
            placement={inst.placement}
            mode={inst.mode}
            locked={locked}
            isFocused={focusedInstanceId === inst.id}
            isDragging={!!isDragging}
            isSnapping={!!isSnapping}
            dragStyle={dragStyle}
            focusEntry={focusEntry(inst)}
            ref={(h) => {
              if (h) panelRefs.current.set(inst.id, h);
              else panelRefs.current.delete(inst.id);
            }}
            onDragStart={handleDragStart(inst.id, inst.placement)}
            onResizeStart={handleResizeStart(inst.id, inst.placement)}
            onActivate={() => bringToFront(inst.id)}
            onClose={() => {
              if (inst.type === 'notes' && inst.isGlobal) {
                void window.agentSmith.notesClosePanel(inst.id);
              }
              destroyPanel(inst.id);
            }}
          >
            {renderBody(inst)}
          </WorkspacePanel>
        );
      })}

      {visibleInstances.length === 0 && (
        <div className="workspace__all-hidden">
          ALL PANELS HIDDEN — REOPEN FROM THE PANEL MENU OR DOUBLE-CLICK A SESSION
        </div>
      )}
    </div>
  );
}
