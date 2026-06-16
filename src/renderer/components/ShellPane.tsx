import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
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
  panelVisible: boolean;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

const ShellPane = forwardRef<ShellPaneHandle, Props>(function ShellPane(
  { session, isActive, panelVisible, openDropdownWithKeyboardRef },
  ref
): React.ReactElement {
  const spawnedRef = useRef(false);
  const { activate, containerRef, fitAndMeasure, focus, termRef, write } = useXterm({
    openDropdownRef: openDropdownWithKeyboardRef,
  });

  useImperativeHandle(ref, () => ({
    focus,
    fitAndMeasure,
    write,
  }), [fitAndMeasure, focus, write]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const onDataDisposable = term.onData((data) => {
      window.agentSmith.shellWrite(session.id, data);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.agentSmith.shellResize(session.id, cols, rows);
    });

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
    };
  }, [session.id, termRef]);

  useEffect(() => {
    if (!isActive || !panelVisible) return;

    activate();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const size = fitAndMeasure();
      if (size) {
        void window.agentSmith.shellResize(session.id, size.cols, size.rows);
      }
      if (!spawnedRef.current) {
        spawnedRef.current = true;
        void window.agentSmith.shellSpawn(session.id, session.workingDir);
      }
    }));
  }, [activate, fitAndMeasure, isActive, panelVisible, session.id, session.workingDir]);

  useEffect(() => {
    const unsub = window.agentSmith.onShellExit((sessionId) => {
      if (sessionId !== session.id) return;
      termRef.current?.clear();
    });
    return unsub;
  }, [session.id, termRef]);

  return (
    <div className="shell-pane" style={isActive ? undefined : { display: 'none' }}>
      <div className="shell-pane__terminal" ref={containerRef} />
    </div>
  );
});

export default ShellPane;
