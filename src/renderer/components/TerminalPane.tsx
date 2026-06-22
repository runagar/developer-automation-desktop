import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { Session } from '../../main/types';
import { useXterm } from '../hooks/useXterm';
import '@xterm/xterm/css/xterm.css';
import './TerminalPane.css';

export interface TerminalPaneHandle {
  focus: () => void;
  fitAndMeasure: () => { cols: number; rows: number } | null;
  write: (data: string) => void;
}

interface Props {
  session: Session;
  isActive: boolean;
  panelInstanceId?: string;
  onResume?: () => void;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

type ShiftSelection = {
  anchor: { col: number; row: number };
  cursor: { col: number; row: number };
};

const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  { session, isActive, panelInstanceId, onResume, openDropdownWithKeyboardRef },
  ref
): React.ReactElement {
  const shiftSelectionRef = useRef<ShiftSelection | null>(null);
  const termForKeysRef = useRef<Terminal | null>(null);
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  const extraKeyHandler = useCallback((e: KeyboardEvent) => {
    const term = termForKeysRef.current;
    if (!term || e.type !== 'keydown') return true;

    // Alt+R — resume suspended session
    if (e.key === 'r' && e.altKey && !e.ctrlKey && !e.shiftKey) {
      onResumeRef.current?.();
      return false;
    }

    const isShiftArrow =
      e.shiftKey && !e.altKey &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
        (!e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')));

    if (isShiftArrow) {
      const buf = term.buffer.active;
      const termCurCol = buf.cursorX;
      const termCurRow = buf.cursorY + buf.viewportY;

      if (!shiftSelectionRef.current) {
        shiftSelectionRef.current = {
          anchor: { col: termCurCol, row: termCurRow },
          cursor: { col: termCurCol, row: termCurRow },
        };
      }

      let { col, row } = shiftSelectionRef.current.cursor;

      if (e.ctrlKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const line = buf.getLine(row);
        const text = line ? line.translateToString(false) : '';
        if (e.key === 'ArrowRight') {
          let p = col;
          while (p < term.cols && text[p] === ' ') p++;
          while (p < term.cols && text[p] !== ' ') p++;
          col = p;
        } else {
          let p = col - 1;
          while (p >= 0 && text[p] === ' ') p--;
          while (p >= 0 && text[p] !== ' ') p--;
          col = p + 1;
        }
      } else {
        if (e.key === 'ArrowRight') {
          col++;
          if (col >= term.cols) {
            col = 0;
            row++;
          }
        } else if (e.key === 'ArrowLeft') {
          col--;
          if (col < 0) {
            col = term.cols - 1;
            row--;
          }
        } else if (e.key === 'ArrowDown') {
          row++;
        } else if (e.key === 'ArrowUp') {
          row--;
        }
      }

      col = Math.max(0, Math.min(col, term.cols - 1));
      row = Math.max(0, Math.min(row, buf.length - 1));
      shiftSelectionRef.current.cursor = { col, row };

      const anchor = shiftSelectionRef.current.anchor;
      const anchorBefore = anchor.row < row || (anchor.row === row && anchor.col <= col);
      const [startCol, startRow, endCol, endRow] = anchorBefore
        ? [anchor.col, anchor.row, col, row]
        : [col, row, anchor.col, anchor.row];

      const len = (endRow - startRow) * term.cols + (endCol - startCol);
      if (len > 0) term.select(startCol, startRow, len);
      else term.clearSelection();

      return false;
    }

    if (!e.shiftKey) shiftSelectionRef.current = null;
    return true;
  }, []);

  const {
    activate,
    containerRef,
    fitAndMeasure,
    focus,
    termRef,
    write,
  } = useXterm({
    openDropdownRef: openDropdownWithKeyboardRef,
    extraKeyHandler,
  });

  termForKeysRef.current = termRef.current;

  useImperativeHandle(ref, () => ({
    focus,
    fitAndMeasure,
    write,
  }), [fitAndMeasure, focus, write]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onDataDisposable = term.onData((data) => {
      if (panelInstanceId) {
        window.agentSmith.ptyWritePanel(panelInstanceId, data);
      } else {
        window.agentSmith.ptyWrite(session.id, data);
      }
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if (panelInstanceId) {
        void window.agentSmith.ptyResizePanel(panelInstanceId, cols, rows);
      } else {
        void window.agentSmith.ptyResize(session.id, cols, rows);
      }
    });

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
    };
  }, [panelInstanceId, session.id, termRef]);

  useEffect(() => {
    if (!isActive) return;

    activate();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const size = fitAndMeasure();
      if (size) {
        if (panelInstanceId) {
          void window.agentSmith.ptyResizePanel(panelInstanceId, size.cols, size.rows);
        } else {
          void window.agentSmith.ptyResize(session.id, size.cols, size.rows);
        }
      }
    }));
  }, [activate, fitAndMeasure, isActive, panelInstanceId, session.id]);

  return (
    <div className="terminal-pane" style={isActive ? undefined : { display: 'none' }}>
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
