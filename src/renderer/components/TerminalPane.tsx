import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
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
  onRename: (id: string, name: string) => void;
  onTerminalInput?: (sessionId: string, data: string) => void;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

type ShiftSelection = {
  anchor: { col: number; row: number };
  cursor: { col: number; row: number };
};

const TerminalPane = forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
  { session, isActive, onRename, onTerminalInput, openDropdownWithKeyboardRef },
  ref
): React.ReactElement {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(session.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const shiftSelectionRef = useRef<ShiftSelection | null>(null);
  const termForKeysRef = useRef<Terminal | null>(null);

  const extraKeyHandler = useCallback((e: KeyboardEvent) => {
    const term = termForKeysRef.current;
    if (!term || e.type !== 'keydown') return true;

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
      window.agentSmith.ptyWrite(session.id, data);
      onTerminalInput?.(session.id, data);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.agentSmith.ptyResize(session.id, cols, rows);
    });

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
    };
  }, [onTerminalInput, session.id, termRef]);

  useEffect(() => {
    if (!isActive) return;

    activate();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const size = fitAndMeasure();
      if (size) {
        void window.agentSmith.ptyResize(session.id, size.cols, size.rows);
      }
    }));
  }, [activate, fitAndMeasure, isActive, session.id]);

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
    if (e.key === 'Escape') {
      setNameValue(session.name);
      setEditingName(false);
    }
  }

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
