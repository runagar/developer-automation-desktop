import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { getXtermTheme } from '../xterm-theme';

export interface UseXtermOptions {
  scrollback?: number;
  openDropdownRef: React.MutableRefObject<() => void>;
  extraKeyHandler?: (e: KeyboardEvent) => boolean;
}

export interface UseXtermReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  termRef: React.RefObject<Terminal>;
  /** RAF-batched write — safe to call at high frequency. */
  write: (data: string) => void;
  focus: () => void;
  fitAndMeasure: () => { cols: number; rows: number } | null;
  /** Open the terminal into the DOM (idempotent, lazy). */
  activate: () => void;
}

export function useXterm(options: UseXtermOptions): UseXtermReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false);
  const selObsRef = useRef<MutationObserver | null>(null);
  const pendingRef = useRef('');
  const rafRef = useRef<number | null>(null);

  const openDropdownRef = useRef(options.openDropdownRef);
  openDropdownRef.current = options.openDropdownRef;

  const extraKeyHandlerRef = useRef(options.extraKeyHandler);
  extraKeyHandlerRef.current = options.extraKeyHandler;

  // Create the xterm Terminal once on mount.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Roboto Mono", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: getXtermTheme(),
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      scrollback: options.scrollback ?? 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // Common key interception: Ctrl+N, Ctrl+C (clipboard), Ctrl+V (paste)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Ctrl+N — open New Session dropdown
      if (e.key === 'n' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        openDropdownRef.current.current();
        return false;
      }

      // Ctrl+C — copy selection when text is highlighted
      if (e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        const sel = term.getSelection();
        if (sel) {
          window.dad.clipboardWrite(sel);
          return false;
        }
      }

      // Ctrl+V — let browser paste event handle it
      if (e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        return false;
      }

      // Forward to consumer's extra handler
      if (extraKeyHandlerRef.current) {
        return extraKeyHandlerRef.current(e);
      }

      return true;
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      selObsRef.current?.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      openedRef.current = false;
    };
  }, []);

  // Fit terminal whenever the container is resized.
  // Deferred via rAF to avoid "ResizeObserver loop completed with undelivered
  // notifications" — fit() mutates layout, which would trigger another
  // observation in the same loop iteration if called synchronously.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => fitAddonRef.current?.fit());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  // Re-apply xterm theme when the data-theme attribute changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (termRef.current) {
        termRef.current.options.theme = getXtermTheme();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  const activate = useCallback(() => {
    if (openedRef.current || !containerRef.current || !termRef.current || !fitAddonRef.current) return;
    openedRef.current = true;
    termRef.current.open(containerRef.current);

    // Wire up selection colour override via MutationObserver
    const selectionContainer = containerRef.current.querySelector('.xterm-selection');
    if (selectionContainer) {
      const applySelColor = (el: HTMLElement) => {
        el.style.backgroundColor = (getXtermTheme().selectionBackground as string);
      };
      const selObs = new MutationObserver((muts) => {
        for (const mut of muts) {
          mut.addedNodes.forEach((n) => {
            if (n instanceof HTMLElement) applySelColor(n);
          });
        }
      });
      selObs.observe(selectionContainer, { childList: true });
      selObsRef.current = selObs;
    }
  }, []);

  const write = useCallback((data: string) => {
    pendingRef.current += data;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        termRef.current?.write(pendingRef.current);
        pendingRef.current = '';
        rafRef.current = null;
      });
    }
  }, []);

  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const fitAndMeasure = useCallback(() => {
    const term = termRef.current;
    const fit = fitAddonRef.current;
    if (!term || !fit) return null;
    fit.fit();
    return { cols: term.cols, rows: term.rows };
  }, []);

  return { containerRef, termRef, write, focus, fitAndMeasure, activate };
}
