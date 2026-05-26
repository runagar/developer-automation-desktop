import React, { useState, useEffect, useRef } from 'react';
import './ZoomControl.css';

const STORAGE_KEY = 'agent-smith-zoom';
const DEFAULT_ZOOM = 1.0;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const STEP = 0.1;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function initZoom(): void {
  const saved = parseFloat(localStorage.getItem(STORAGE_KEY) ?? String(DEFAULT_ZOOM));
  const factor = clamp(isNaN(saved) ? DEFAULT_ZOOM : saved, MIN_ZOOM, MAX_ZOOM);
  window.agentSmith.setZoom(factor);
}

export default function ZoomControl(): React.ReactElement {
  const [zoom, setZoom] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem(STORAGE_KEY) ?? String(DEFAULT_ZOOM));
    return clamp(isNaN(saved) ? DEFAULT_ZOOM : saved, MIN_ZOOM, MAX_ZOOM);
  });

  function apply(next: number): void {
    const clamped = clamp(Math.round(next * 10) / 10, MIN_ZOOM, MAX_ZOOM);
    setZoom(clamped);
    localStorage.setItem(STORAGE_KEY, String(clamped));
    window.agentSmith.setZoom(clamped);
  }

  function reset(): void {
    apply(DEFAULT_ZOOM);
  }

  // Always-current ref so the keyboard handler doesn't re-register on every zoom change.
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // Ctrl+= or Ctrl++ → zoom in, Ctrl+- → zoom out, Ctrl+0 → reset.
  // preventDefault stops Electron's own Ctrl+=/- window-level zoom from also firing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        apply(zoomRef.current + STEP);
      } else if (e.key === '-') {
        e.preventDefault();
        apply(zoomRef.current - STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        apply(DEFAULT_ZOOM);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // Empty deps: handler registered once; reads fresh zoom from zoomRef.
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
        onClick={reset}
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
