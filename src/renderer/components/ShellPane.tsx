import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
} from 'react';
import { Session } from '../../main/types';
import { useXterm } from '../hooks/useXterm';
import '@xterm/xterm/css/xterm.css';
import './ShellPane.css';

export interface ShellPaneHandle {
  focus: () => void;
  fitAndMeasure: () => { cols: number; rows: number } | null;
  write: (data: string) => void;
}

interface Props {
  session: Session;
  isActive: boolean;
  panelInstanceId: string;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

const ShellPane = forwardRef<ShellPaneHandle, Props>(function ShellPane(
  { session, isActive, panelInstanceId, openDropdownWithKeyboardRef },
  ref
): React.ReactElement {
  const { activate, containerRef, fitAndMeasure, focus, termRef, write } = useXterm({
    openDropdownRef: openDropdownWithKeyboardRef,
  });

  useImperativeHandle(ref, () => ({
    focus,
    fitAndMeasure,
    write,
  }), [fitAndMeasure, focus, write]);

  // Wire up xterm input → IPC (using panelInstanceId)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onDataDisposable = term.onData((data) => {
      window.agentSmith.shellWritePanel(panelInstanceId, data);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.agentSmith.shellResizePanel(panelInstanceId, cols, rows);
    });

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
    };
  }, [panelInstanceId, termRef]);

  // Activate xterm when visible
  useEffect(() => {
    if (!isActive) return;

    activate();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const size = fitAndMeasure();
      if (size) {
        void window.agentSmith.shellResizePanel(panelInstanceId, size.cols, size.rows);
      }
    }));
  }, [activate, fitAndMeasure, isActive, panelInstanceId]);

  return (
    <div className="shell-pane" style={isActive ? undefined : { display: 'none' }}>
      <div className="shell-pane__terminal" ref={containerRef} />
    </div>
  );
});

export default ShellPane;
