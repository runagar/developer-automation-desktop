import React, { useEffect, useRef } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import ShellPane, { ShellPaneHandle } from './ShellPane';
import { handleOsc52 } from '../utils/osc52';
import './TerminalPane.css';

interface Props {
  instance: PanelInstance;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

/**
 * Renders a single ShellPane for a panel instance's currentSessionId.
 * Handles shell tmux attach/detach lifecycle per panel instance.
 */
export default function ShellPanelInstance({
  instance,
  openDropdownWithKeyboardRef,
}: Props): React.ReactElement {
  const session = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === instance.currentSessionId) ?? null
  );
  const shellRef = useRef<ShellPaneHandle | null>(null);
  const attachedRef = useRef<string | null>(null);

  // Attach shell tmux when session changes or on mount
  useEffect(() => {
    if (!session || session.dead || session.archived) {
      if (attachedRef.current) {
        void window.dad.shellDetach(instance.id);
        attachedRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const doAttach = async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (cancelled) return;
      const size = shellRef.current?.fitAndMeasure();
      await window.dad.shellAttach(
        session.id,
        instance.id,
        session.workingDir,
        size?.cols ?? 120,
        size?.rows ?? 36
      );
      if (cancelled) {
        // Attached but effect was cleaned up — detach the stale attachment
        void window.dad.shellDetach(instance.id);
        return;
      }
      attachedRef.current = session.id;
      const postSize = shellRef.current?.fitAndMeasure();
      if (postSize) {
        void window.dad.shellResizePanel(instance.id, postSize.cols, postSize.rows);
      }
    };

    void doAttach();

    return () => {
      cancelled = true;
      void window.dad.shellDetach(instance.id);
      attachedRef.current = null;
    };
  }, [instance.id, session?.id, session?.dead, session?.archived, session?.workingDir]);

  // Listen for shell data for this panel instance
  useEffect(() => {
    const unsub = window.dad.onShellData((panelInstanceId, data) => {
      if (panelInstanceId !== instance.id) return;
      const cleaned = handleOsc52(data);
      shellRef.current?.write(cleaned);
    });
    return unsub;
  }, [instance.id]);

  // Listen for shell exit (tmux session died)
  useEffect(() => {
    const unsub = window.dad.onShellExit((panelInstanceId) => {
      if (panelInstanceId !== instance.id) return;
    });
    return unsub;
  }, [instance.id]);

  return (
    <PanelInstanceWrapper instance={instance} slotKey={session?.id ?? ''}>
      {(s) => (
        <ShellPane
          ref={(handle) => { shellRef.current = handle; }}
          session={s}
          isActive={true}
          panelInstanceId={instance.id}
          openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        />
      )}
    </PanelInstanceWrapper>
  );
}
