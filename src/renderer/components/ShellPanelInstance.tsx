import React, { useEffect, useRef } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
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
  const sessions = useSessionStore((s) => s.sessions);
  const session = sessions.find((s) => s.id === instance.currentSessionId) ?? null;
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

    const doAttach = async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const size = shellRef.current?.fitAndMeasure();
      await window.dad.shellAttach(
        session.id,
        instance.id,
        session.workingDir,
        size?.cols ?? 120,
        size?.rows ?? 36
      );
      attachedRef.current = session.id;
      // Re-measure and resize after attach resolves — any resize events that
      // fired during the async attach window were dropped because the
      // attachment didn't exist yet in the main process.
      const postSize = shellRef.current?.fitAndMeasure();
      if (postSize) {
        void window.dad.shellResizePanel(instance.id, postSize.cols, postSize.rows);
      }
    };

    void doAttach();

    return () => {
      void window.dad.shellDetach(instance.id);
      attachedRef.current = null;
    };
  }, [instance.id, session?.id, session?.workingDir]);

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
      // Shell tmux died — clear the terminal
      // The user can re-attach by activating another session and coming back
    });
    return unsub;
  }, [instance.id]);

  if (!session) {
    return (
      <div className="workspace-fill">
        <div className="app-empty">
          <div className="app-empty__text">NO ACTIVE SESSION</div>
          <div className="app-empty__sub">CREATE A NEW SESSION TO BEGIN</div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-fill">
      <div key={session.id} className="workspace-slot">
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{session.name}</span>
          {session.project && (
            <span className="terminal-pane__project">[ {session.project} ]</span>
          )}
          <span className="terminal-pane__dir">{session.workingDir}</span>
        </div>
        <ShellPane
          ref={(handle) => { shellRef.current = handle; }}
          session={session}
          isActive={true}
          panelInstanceId={instance.id}
          openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        />
      </div>
    </div>
  );
}
