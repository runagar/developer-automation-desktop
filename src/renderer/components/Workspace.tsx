import React, { useCallback, useEffect, useRef, useState } from 'react';
import WorkspacePanel, { PanelHandle, ResizeHandle } from './WorkspacePanel';
import { DashboardController } from '../dashboard/useDashboardLayout';
import {
  PanelId, PANEL_IDS, PANEL_LABELS, panelOrder, DashboardPanelPlacement,
} from '../dashboard/layout';
import './Workspace.css';

interface Props {
  controller: DashboardController;
  bodies: Record<PanelId, React.ReactNode>;
  titles?: Partial<Record<PanelId, React.ReactNode>>;
  focusEntry: Record<PanelId, () => void>;
}

type Interaction =
  | { kind: 'move'; id: PanelId; startX: number; startY: number; cellW: number; cellH: number; start: DashboardPanelPlacement }
  | { kind: 'resize'; id: PanelId; handle: ResizeHandle; startX: number; startY: number; cellW: number; cellH: number; start: DashboardPanelPlacement };

export default function Workspace({ controller, bodies, titles, focusEntry }: Props): React.ReactElement {
  const { layout, locked, setPlacement, bringToFront } = controller;
  const rootRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [focusedPanel, setFocusedPanel] = useState<PanelId | null>(null);

  const panelRefs = useRef<Record<PanelId, PanelHandle | null>>({
    sessions: null, terminal: null, jira: null, shell: null,
  });

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
    return { cellW: (rect?.width ?? 1) / 12, cellH: (rect?.height ?? 1) / 12 };
  }, []);

  const handleDragStart = useCallback((id: PanelId) => (e: React.PointerEvent) => {
    if (locked) return;
    e.preventDefault();
    const { cellW, cellH } = cellSize();
    beginInteraction({ kind: 'move', id, startX: e.clientX, startY: e.clientY, cellW, cellH, start: layout[id] });
  }, [locked, layout, cellSize, beginInteraction]);

  const handleResizeStart = useCallback((id: PanelId) => (e: React.PointerEvent, handle: ResizeHandle) => {
    if (locked) return;
    e.preventDefault();
    const { cellW, cellH } = cellSize();
    beginInteraction({ kind: 'resize', id, handle, startX: e.clientX, startY: e.clientY, cellW, cellH, start: layout[id] });
  }, [locked, layout, cellSize, beginInteraction]);

  useEffect(() => endInteraction, [endInteraction]);

  // --- Focus tracking (highlight + Ctrl+Tab start point) ---

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onFocusIn = (e: FocusEvent): void => {
      const el = (e.target as HTMLElement | null)?.closest('[data-panel-id]');
      const id = el?.getAttribute('data-panel-id') as PanelId | undefined;
      setFocusedPanel(id ?? null);
    };
    const onFocusOut = (): void => {
      requestAnimationFrame(() => {
        const active = document.activeElement as HTMLElement | null;
        const el = active?.closest('[data-panel-id]');
        const id = el?.getAttribute('data-panel-id') as PanelId | undefined;
        if (!id) setFocusedPanel(null);
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

  const focusedRef = useRef<PanelId | null>(null);
  focusedRef.current = focusedPanel;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;

      if (e.ctrlKey) {
        // Cross-panel cycling
        const order = panelOrder(layoutRef.current);
        if (order.length === 0) return;
        e.preventDefault();
        e.stopPropagation();

        const current = focusedRef.current;
        const idx = current ? order.indexOf(current) : -1;
        const next = e.shiftKey
          ? order[(idx - 1 + order.length) % order.length]
          : order[(idx + 1) % order.length];

        bringToFront(next);
        panelRefs.current[next]?.focus();
        return;
      }

      // Plain Tab: only allowed when focus is inside a panel (intra-panel cycle).
      // When focus is outside any panel (header, body background), block the
      // default focus traversal — there is no global Tab navigation. We only
      // preventDefault (not stopPropagation) so other capture handlers such as
      // the New Session dropdown navigation can still run.
      const active = document.activeElement as HTMLElement | null;
      if (!active?.closest('[data-panel-id]')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [bringToFront]);

  return (
    <div className="workspace" ref={rootRef}>
      {PANEL_IDS.map((id) => (
        <WorkspacePanel
          key={id}
          id={id}
          title={titles?.[id] ?? PANEL_LABELS[id]}
          placement={layout[id]}
          locked={locked}
          isFocused={focusedPanel === id}
          focusEntry={focusEntry[id]}
          ref={(h) => { panelRefs.current[id] = h; }}
          onDragStart={handleDragStart(id)}
          onResizeStart={handleResizeStart(id)}
          onActivate={() => bringToFront(id)}
          onClose={() => controller.toggleVisible(id)}
        >
          {bodies[id]}
        </WorkspacePanel>
      ))}

      {panelOrder(layout).length === 0 && (
        <div className="workspace__all-hidden">
          ALL PANELS HIDDEN — REOPEN FROM THE PANEL MENU
        </div>
      )}
    </div>
  );
}
