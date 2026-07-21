import React, { useState, useEffect, useRef, useCallback } from 'react';
import './ZoomControl.css';

const STORAGE_KEY = 'dad-zoom';
const DEFAULT_ZOOM = 1.0;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const STEP = 0.1;
const ZOOM_CHANGED_EVENT = 'dad-zoom-changed';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function readZoom(): number {
  const saved = parseFloat(localStorage.getItem(STORAGE_KEY) ?? String(DEFAULT_ZOOM));
  return clamp(isNaN(saved) ? DEFAULT_ZOOM : saved, MIN_ZOOM, MAX_ZOOM);
}

function applyZoom(next: number): number {
  const clamped = clamp(Math.round(next * 10) / 10, MIN_ZOOM, MAX_ZOOM);
  localStorage.setItem(STORAGE_KEY, String(clamped));
  // Dispatch event first so React updates the display immediately
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT, { detail: clamped }));
  // Defer the expensive webFrame zoom so the UI repaints before the reflow
  requestAnimationFrame(() => {
    window.dad.setZoom(clamped);
  });
  return clamped;
}

export function initZoom(): void {
  const factor = readZoom();
  window.dad.setZoom(factor);
}

/**
 * Hook that registers global Ctrl++/−/0 keyboard shortcuts for zoom.
 * Must be called from a component that is always mounted (e.g. App.tsx).
 */
export function useZoomKeyboard(): void {
  const zoomRef = useRef(readZoom());

  useEffect(() => {
    const onZoomChanged = (e: Event) => {
      zoomRef.current = (e as CustomEvent).detail;
    };
    window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);

    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomRef.current = applyZoom(zoomRef.current + STEP);
      } else if (e.key === '-') {
        e.preventDefault();
        zoomRef.current = applyZoom(zoomRef.current - STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        zoomRef.current = applyZoom(DEFAULT_ZOOM);
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
    };
  }, []);
}

/**
 * Visual zoom controls (+/−/%) for embedding in the settings dropdown.
 * onReset is called when the user clicks the percentage label.
 */
export function ZoomControls({ onReset }: { onReset?: () => void }): React.ReactElement {
  const [zoom, setZoom] = useState<number>(readZoom);

  // Sync from keyboard changes or other sources
  useEffect(() => {
    const onZoomChanged = (e: Event) => {
      setZoom((e as CustomEvent).detail);
    };
    window.addEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
    return () => window.removeEventListener(ZOOM_CHANGED_EVENT, onZoomChanged);
  }, []);

  const apply = useCallback((next: number) => {
    applyZoom(next);
  }, []);

  const pct = Math.round(zoom * 100);

  return (
    <div className="zoom-control">
      <button
        className="zoom-control__btn"
        onClick={() => apply(zoom - STEP)}
        disabled={zoom <= MIN_ZOOM}
        title="Zoom out (Ctrl+-)"
      >
        −
      </button>
      <button
        className="zoom-control__value"
        onClick={() => { apply(DEFAULT_ZOOM); onReset?.(); }}
        title="Reset zoom to 100% (Ctrl+0)"
      >
        {pct}%
      </button>
      <button
        className="zoom-control__btn"
        onClick={() => apply(zoom + STEP)}
        disabled={zoom >= MAX_ZOOM}
        title="Zoom in (Ctrl++)"
      >
        +
      </button>
    </div>
  );
}
