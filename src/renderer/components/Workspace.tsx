import React, { useCallback, useEffect, useRef, useState } from 'react';
import WorkspacePanel, { PanelHandle, ResizeHandle } from './WorkspacePanel';
import { useLayoutStore } from '../stores/layoutStore';
import {
  PanelInstance, PANEL_LABELS, panelOrder, Placement, GRID,
} from '../dashboard/layout';
import './Workspace.css';

interface Props {
  renderBody: (instance: PanelInstance) => React.ReactNode;
  renderTitle?: (instance: PanelInstance) => React.ReactNode;
  focusEntry: (instance: PanelInstance) => (() => void) | undefined;
}

type Interaction =
  | { kind: 'move'; id: string; startX: number; startY: number; cellW: number; cellH: number; start: Placement }
  | { kind: 'resize'; id: string; handle: ResizeHandle; startX: number; startY: number; cellW: number; cellH: number; start: Placement };

export default function Workspace({ renderBody, renderTitle, focusEntry }: Props): React.ReactElement {
  const instances = useLayoutStore((s) => s.instances);
  const locked = useLayoutStore((s) => s.locked);
  const setPlacement = useLayoutStore((s) => s.setPlacement);
  const bringToFront = useLayoutStore((s) => s.bringToFront);
  const destroyPanel = useLayoutStore((s) => s.destroyPanel);
  const rootRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [focusedInstanceId, setFocusedInstanceId] = useState<string | null>(null);

  const panelRefs = useRef<Map<string, PanelHandle>>(new Map());

  // --- Pointer drag / resize ---

  const onPointerMove = useCallback((e: PointerEvent) => {
    const it = interactionRef.current;
    if (!it) return;
    const dxCells = Math.round((e.clientX - it.startX) / it.cellW);
    const dyCells = Math.round((e.clientY - it.startY) / it.cellH);
    const s = it.start;

    if (it.kind === 'move') {
      setPlacement(it.id, { ...s, x: s.x + dxCells, y: s.y + dyCells });
      return;
    }

    // resize
    let { x, y, w, h } = s;
    const hdl = it.handle;
    if (hdl.includes('e')) w = s.w + dxCells;
    if (hdl.includes('s')) h = s.h + dyCells;
    if (hdl.includes('w')) { x = s.x + dxCells; w = s.w - dxCells; }
    if (hdl.includes('n')) { y = s.y + dyCells; h = s.h - dyCells; }
    setPlacement(it.id, { ...s, x, y, w, h });
  }, [setPlacement]);

  const endInteraction = useCallback(() => {
    interactionRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endInteraction);
  }, [onPointerMove]);

  const beginInteraction = useCallback((it: Interaction) => {
    interactionRef.current = it;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endInteraction);
  }, [onPointerMove, endInteraction]);

  const cellSize = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { cellW: (rect?.width ?? 1) / GRID, cellH: (rect?.height ?? 1) / GRID };
  }, []);

  const handleDragStart = useCallback((id: string, placement: Placement) => (e: React.PointerEvent) => {
    if (locked) return;
    e.preventDefault();
    const { cellW, cellH } = cellSize();
    beginInteraction({ kind: 'move', id, startX: e.clientX, startY: e.clientY, cellW, cellH, start: placement });
  }, [locked, cellSize, beginInteraction]);

  const handleResizeStart = useCallback((id: string, placement: Placement) => (e: React.PointerEvent, handle: ResizeHandle) => {
    if (locked) return;
    e.preventDefault();
    const { cellW, cellH } = cellSize();
    beginInteraction({ kind: 'resize', id, handle, startX: e.clientX, startY: e.clientY, cellW, cellH, start: placement });
  }, [locked, cellSize, beginInteraction]);

  useEffect(() => endInteraction, [endInteraction]);

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
        // Cross-panel cycling
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

      // Plain Tab: only allowed when focus is inside a panel (intra-panel cycle).
      const active = document.activeElement as HTMLElement | null;
      if (!active?.closest('[data-panel-id]')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [bringToFront]);

  const visibleInstances = panelOrder(instances);

  return (
    <div className="workspace" ref={rootRef}>
      {instances.map((inst) => (
        <WorkspacePanel
          key={inst.id}
          id={inst.id}
          title={renderTitle ? renderTitle(inst) : PANEL_LABELS[inst.type]}
          placement={inst.placement}
          mode={inst.mode}
          locked={locked}
          isFocused={focusedInstanceId === inst.id}
          focusEntry={focusEntry(inst)}
          ref={(h) => {
            if (h) panelRefs.current.set(inst.id, h);
            else panelRefs.current.delete(inst.id);
          }}
          onDragStart={handleDragStart(inst.id, inst.placement)}
          onResizeStart={handleResizeStart(inst.id, inst.placement)}
          onActivate={() => bringToFront(inst.id)}
          onClose={() => {
            // For global notes panels, mark as closed in DB before destroying
            if (inst.type === 'notes' && inst.isGlobal) {
              void window.agentSmith.notesClosePanel(inst.id);
            }
            destroyPanel(inst.id);
          }}
        >
          {renderBody(inst)}
        </WorkspacePanel>
      ))}

      {visibleInstances.length === 0 && (
        <div className="workspace__all-hidden">
          ALL PANELS HIDDEN — REOPEN FROM THE PANEL MENU OR DOUBLE-CLICK A SESSION
        </div>
      )}
    </div>
  );
}
