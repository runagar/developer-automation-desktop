import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Session } from '../../main/types';
import { getXtermTheme } from '../xterm-theme';
import '@xterm/xterm/css/xterm.css';
import './TerminalPane.css';

export interface TerminalPaneHandle {
  focus: () => void;
  // Fit the (typically empty, freshly-mounted) xterm to its container and
  // return the resulting grid size, so the PTY can attach at exactly that size
  // — avoiding any post-attach resize (which corrupts tmux's repaint).
  fitAndMeasure: () => { cols: number; rows: number } | null;
}

interface Props {
  session: Session;
  isActive: boolean;
  onRename: (id: string, name: string) => void;
  onTerminalInput?: (sessionId: string, data: string) => void;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  { session, isActive, onRename, onTerminalInput, openDropdownWithKeyboardRef },
  ref
): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const openedRef = useRef(false); // has term.open() been called yet?
  const selObsRef = useRef<MutationObserver | null>(null);
  const [editingName, setEditingName] = React.useState(false);
  const [nameValue, setNameValue] = React.useState(session.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const onTerminalInputRef = useRef(onTerminalInput);
  onTerminalInputRef.current = onTerminalInput;

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    fitAndMeasure: () => {
      const term = termRef.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return null;
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
  }), []);

  // Create the xterm Terminal once on mount. We don't call term.open() yet —
  // that's deferred until first activation so dimensions are available.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Roboto Mono", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: getXtermTheme(),
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.onData((data) => {
      window.agentSmith.ptyWrite(session.id, data);
      onTerminalInputRef.current?.(session.id, data);
    });

    // Intercept Ctrl+N before xterm consumes it so the New Session dropdown
    // can be opened even when focus is inside the terminal.
    // Intercept Ctrl+C/X/V for clipboard operations.
    // Intercept Shift+Arrow for screen text selection.
    let shiftSel: {
      anchor: { col: number; row: number };
      cursor: { col: number; row: number };
    } | null = null;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Ctrl+N — open New Session dropdown
      if (e.key === 'n' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        openDropdownWithKeyboardRef.current();
        return false;
      }

      // Ctrl+C — copy selection when text is highlighted; otherwise let
      // the shell receive the interrupt signal (SIGINT) as normal.
      if (e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        const sel = term.getSelection();
        if (sel) {
          window.agentSmith.clipboardWrite(sel);
          return false;
        }
      }

      // Ctrl+V — block xterm from writing the raw 0x16 char to the PTY.
      // The browser fires a separate 'paste' event which xterm handles
      // natively (with bracketed-paste support).
      if (e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        return false;
      }

      // Shift+Arrow / Ctrl+Shift+Arrow — extend screen selection without
      // forwarding to PTY. Ctrl+Shift+Left/Right jumps by word.
      const isShiftArrow =
        e.shiftKey && !e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
          (!e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')));

      if (isShiftArrow) {
        const buf = term.buffer.active;
        const termCurCol = buf.cursorX;
        const termCurRow = buf.cursorY + buf.viewportY;

        if (!shiftSel) {
          shiftSel = {
            anchor: { col: termCurCol, row: termCurRow },
            cursor: { col: termCurCol, row: termCurRow },
          };
        }

        let { col, row } = shiftSel.cursor;

        if (e.ctrlKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          // Word-level movement: scan the buffer line for word boundaries.
          const line = buf.getLine(row);
          const text = line ? line.translateToString(false) : '';
          if (e.key === 'ArrowRight') {
            // Skip whitespace then non-whitespace to reach end of next word.
            let p = col;
            while (p < term.cols && text[p] === ' ') p++;
            while (p < term.cols && text[p] !== ' ') p++;
            col = p;
          } else {
            // Skip whitespace then non-whitespace going left to start of word.
            let p = col - 1;
            while (p >= 0 && text[p] === ' ') p--;
            while (p >= 0 && text[p] !== ' ') p--;
            col = p + 1;
          }
        } else {
          // Character-level movement.
          if (e.key === 'ArrowRight') {
            col++;
            if (col >= term.cols) { col = 0; row++; }
          } else if (e.key === 'ArrowLeft') {
            col--;
            if (col < 0) { col = term.cols - 1; row--; }
          } else if (e.key === 'ArrowDown') {
            row++;
          } else if (e.key === 'ArrowUp') {
            row--;
          }
        }

        col = Math.max(0, Math.min(col, term.cols - 1));
        row = Math.max(0, Math.min(row, buf.length - 1));
        shiftSel.cursor = { col, row };

        // Compute selection bounds (anchor may be before or after cursor).
        const a = shiftSel.anchor;
        const anchorBefore =
          a.row < row || (a.row === row && a.col <= col);
        const [startCol, startRow, endCol, endRow] = anchorBefore
          ? [a.col, a.row, col, row]
          : [col, row, a.col, a.row];

        const len = (endRow - startRow) * term.cols + (endCol - startCol);
        if (len > 0) term.select(startCol, startRow, len);
        else term.clearSelection();

        return false;
      }

      // Any non-Shift key press resets the shift-selection anchor.
      if (!e.shiftKey) shiftSel = null;

      return true;
    });

    term.onResize(({ cols, rows }) => {
      window.agentSmith.ptyResize(session.id, cols, rows);
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      selObsRef.current?.disconnect();
      term.dispose();
    };
  // Empty deps: terminal is created once per component instance. session.id and
  // session.name never change for a given instance, so closing over them is safe.
  }, []);

  // Open the terminal into the DOM the first time it becomes active.
  // After that, just re-fit — the terminal stays alive between activations.
  useEffect(() => {
    if (!isActive || !containerRef.current || !termRef.current || !fitAddonRef.current) return;

    if (!openedRef.current) {
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
    }

    // Re-fit after becoming active and notify PTY of new dimensions so the CLI redraws.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const term = termRef.current;
      if (term) {
        window.agentSmith.ptyResize(session.id, term.cols, term.rows);
      }
    }));
  }, [isActive]);

  // Write incoming PTY data for this session's terminal regardless of visibility.
  // xterm buffers data before open(), so history accumulates even while hidden.
  // Data is batched per animation frame to avoid per-chunk xterm render passes.
  useEffect(() => {
    const id = session.id;
    let pending = '';
    let rafId: number | null = null;

    const unsub = window.agentSmith.onPtyData((sessionId, data) => {
      if (sessionId !== id || !termRef.current) return;

      // Intercept OSC 52 clipboard-write sequences from CLI applications.
      // Format: ESC ] 52 ; <target> ; <base64-data> BEL|ST
      // This handles clipboard writes that would otherwise fail because
      // xterm.js uses navigator.clipboard (unreliable in Electron).
      const osc52Re = /\x1b\]52;[cps0-9]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
      let match;
      while ((match = osc52Re.exec(data)) !== null) {
        try {
          window.agentSmith.clipboardWrite(atob(match[1]));
        } catch (_) { /* invalid base64 — ignore */ }
      }

      pending += data;
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          termRef.current?.write(pending);
          pending = '';
          rafId = null;
        });
      }
    });

    return () => {
      unsub();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  // Empty deps: `id` is captured intentionally. The subscription must be registered
  // once on mount; re-subscribing on every render would leak listeners.
  }, []);

  // Fit terminal whenever the container is resized (covers window resize,
  // panel resizes, and the initial render after a session switch)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitAddonRef.current?.fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sync name field when session changes (e.g. switching active session)
  useEffect(() => {
    setNameValue(session.name);
    setEditingName(false);
  }, [session.id, session.name]);

  function startEditing(): void {
    setNameValue(session.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 0);
  }

  function commitRename(): void {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== session.name) {
      onRename(session.id, trimmed);
    } else {
      setNameValue(session.name);
    }
    setEditingName(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') { setNameValue(session.name); setEditingName(false); }
  }

  // Re-apply xterm theme when the data-theme attribute changes on <html>
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

  // Cleanup on unmount — handled inside the mount useEffect above.

  return (
    <div className="terminal-pane" style={isActive ? undefined : { display: 'none' }}>
      <div className="terminal-pane__header">
        {editingName ? (
          <input
            ref={nameInputRef}
            className="terminal-pane__name-input"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
        ) : (
          <span
            className="terminal-pane__name terminal-pane__name--editable"
            title="Click to rename"
            onClick={startEditing}
          >
            {session.name}
          </span>
        )}
        {session.project && (
          <span className="terminal-pane__project">[ {session.project} ]</span>
        )}
        <span className="terminal-pane__dir">{session.workingDir}</span>
      </div>
      {session.dead && (
        <div className="terminal-pane__dead-banner">
          ⚠ SESSION TERMINATED — SCROLLBACK PRESERVED
        </div>
      )}
      <div className="terminal-pane__terminal" ref={containerRef} />
    </div>
  );
});

export default TerminalPane;
